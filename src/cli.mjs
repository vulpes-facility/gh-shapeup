import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { audit } from './audit.mjs';
import { Board } from './board.mjs';
import { defaultConfigPath, loadConfig } from './config.mjs';
import { ShapeUpError, requirePosition } from './domain.mjs';
import { GitHub } from './github.mjs';
import { Init } from './init.mjs';
import { checkReport, composeBody, editBody, footnoteValues, loadReport, loadTemplate, sectionValues, titleFor } from './templates.mjs';

export const usage = `Usage: gh shapeup <kind> <command> [number] [--parameter value ...]

  pitch new --title T --appetite <key> --problem … --solution … --rabbit-holes … --no-gos …
  pitch edit <number> [--title T] [section parameters] [--appetite <key>] --reason …
  pitch bet <number> --cycle "<cycle title>" --reason …
  pitch unbet <number> --reason …
  pitch break <number> --reason …
  pitch done <number> --report-file <file>
  scope new --pitch <number> --title T --done …
  scope edit <number> [--title T] [--done …] --reason …
  scope start <number> --reason …
  scope hill <number> --position 0-100 --reason …
  scope done <number> --report-file <file>
  cooldown new --title T --what … [--why …] --done …
  cooldown edit <number> [--title T] [section parameters] --reason …
  bug new --title T --symptom … --steps … --expected … [--environment …]
  bug edit <number> [--title T] [section parameters] --reason …
  audit [--pitch <number>]
  init [--force]

Section parameters come from the config's kinds; the ones above are the defaults.
Every new and edit also takes --from <file> (Markdown split into ## sections) and repeated --footnote name=description.
Every command with --reason makes its change and then posts the reason as a comment on the issue it changed.
--reason-file <file> gives the reason as a Markdown file instead, posted as it is.
pitch done and scope done post a completion report the same way, from --report-file <file>:
exactly the ## sections of the report template, in order, none of them empty.
A command whose result already holds refuses. One that stops part-way says what it made and what is left, and posts nothing.`;

const flags = new Set(['force']);

export function parseArgs(argv) {
  const [first, second, ...rest] = argv;
  const kind = first;
  const bare = first === 'audit' || first === 'init';
  const action = bare ? null : second;
  const tokens = bare ? [second, ...rest].filter(value => value !== undefined) : rest;
  const options = {};
  const footnotes = [];
  let number = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (flags.has(key)) { options[key] = true; continue; }
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith('--')) throw new ShapeUpError('input', `--${key} needs a value.`);
      if (key === 'footnote') footnotes.push(value); else options[key] = value;
      i++;
    } else if (number === null && /^[1-9][0-9]*$/.test(token)) number = Number(token);
    else throw new ShapeUpError('input', `Unknown argument: ${token}`);
  }
  return { kind, action, number, options, footnotes };
}

const need = (value, message) => { if (value === null || value === undefined || value === '') throw new ShapeUpError('input', message); return value; };
// A command whose result already holds refuses with its own code, so a caller can tell it from any other refusal.
const holds = message => new ShapeUpError('holds', message);

// Every command that changes an existing issue leaves a comment on it: a completion report when it finishes
// a pitch or a scope, and the reason for the change otherwise.
const needsReport = (kind, action) => action === 'done' && (kind === 'pitch' || kind === 'scope');
const needsReason = (kind, action) => action === 'edit' ||
  ({ pitch: ['bet', 'unbet', 'break'], scope: ['start', 'hill'] })[kind]?.includes(action) === true;

export class Cli {
  constructor({ api, board, config, readTemplate, readReportTemplate, readText = path => readFile(path, 'utf8'), out = console.log }) {
    this.api = api;
    this.board = board;
    this.config = config;
    this.readTemplate = readTemplate;
    this.readReportTemplate = readReportTemplate;
    this.readText = readText;
    this.out = out;
  }
  spec(kind) { return this.config.kinds[kind]; }
  async template(kind) { return loadTemplate(kind, this.spec(kind), await this.readTemplate(this.spec(kind).template)); }
  async values(kind, args) {
    const from = args.options.from === undefined ? undefined : await this.readText(args.options.from);
    return sectionValues(this.spec(kind), args.options, from);
  }
  async create(kind, args) {
    const template = await this.template(kind);
    const body = composeBody(template, await this.values(kind, args), footnoteValues(args.footnotes));
    const issue = await this.api.rest('/issues', { method: 'POST', body: {
      title: titleFor(template, args.options.title), body, labels: template.labels,
      assignees: this.config.assignee ? [this.config.assignee] : [] } });
    return issue;
  }
  // The options each command reads; any other option is refused before anything happens, so a typo never passes unnoticed.
  reads(kind, action) {
    const body = ['title', 'from', 'footnote', ...Object.keys(this.spec(kind).sections)];
    const reason = ['reason', 'reason-file'];
    if (action === 'new') return [...body, ...({ pitch: ['appetite'], scope: ['pitch'] }[kind] ?? [])];
    if (action === 'edit') return [...body, ...(kind === 'pitch' ? ['appetite'] : []), ...reason];
    return { 'pitch bet': ['cycle', ...reason], 'pitch unbet': reason, 'pitch break': reason, 'pitch done': ['report-file'],
      'scope start': reason, 'scope hill': ['position', ...reason], 'scope done': ['report-file'] }[`${kind} ${action}`];
  }
  refuseUnread(args, reads) {
    const given = [...Object.keys(args.options), ...(args.footnotes.length ? ['footnote'] : [])];
    const unread = given.find(name => !reads.includes(name));
    if (unread) {
      const command = [args.kind, args.action].filter(Boolean).join(' ');
      throw new ShapeUpError('input', `${command} does not take --${unread}. It takes ${reads.map(name => `--${name}`).join(', ')}.`);
    }
  }
  // Checks an edit and prepares its patch, or null when it names only the appetite. It changes nothing itself.
  async edit(kind, args) {
    const number = need(args.number, 'An issue number is required.');
    const values = await this.values(kind, args);
    const notes = footnoteValues(args.footnotes);
    const body = values.size > 0 || notes.size > 0 || args.options.title !== undefined;
    // An edit that names nothing to change would only post its reason.
    if (!body && args.options.appetite === undefined) {
      const changes = this.reads(kind, 'edit').filter(name => !name.startsWith('reason'));
      throw new ShapeUpError('input', `${kind} edit changes nothing: give at least one of ${changes.map(name => `--${name}`).join(', ')}.`);
    }
    const issue = await this.board.issue(number);
    if (!issue.labels.includes(this.config[`${kind}Label`])) throw new ShapeUpError('type', `#${number} is not a ${kind} issue.`);
    if (!body) return { issue, patch: null };
    const template = await this.template(kind);
    const patch = { body: editBody(issue.body, values, notes) };
    if (args.options.title !== undefined) patch.title = titleFor(template, args.options.title);
    return { issue, patch };
  }
  appetite(value) {
    const name = this.config.appetites[String(value)];
    if (!name) throw new ShapeUpError('input', `--appetite must be one of: ${Object.keys(this.config.appetites).join(', ')}.`);
    return name;
  }
  async boardIssue(number, label) {
    const issue = await this.board.issue(need(number, 'An issue number is required.'));
    if (!issue.labels.includes(this.config[`${label}Label`])) throw new ShapeUpError('type', `#${issue.number} is not a ${label} issue.`);
    if (!issue.item) throw new ShapeUpError('item', `#${issue.number} is not on the board. Check it with audit.`);
    return issue;
  }
  async children(pitch) {
    const children = await this.api.children(pitch.number);
    const scopes = [];
    for (const child of children.filter(c => c.labels.some(label => label.name === this.config.scopeLabel))) {
      scopes.push(await this.board.issue(child.number));
    }
    return scopes;
  }
  close(number, reason) {
    return this.api.rest(`/issues/${number}`, { method: 'PATCH', body: { state: 'closed', state_reason: reason } });
  }
  // A command looks up every status it sets before its first change, so a board without one refuses before anything changes.
  requireStatus(key) { this.board.option('status', this.config.statuses[key]); }
  // How a pitch or a scope ended, if it has: closed, or Done or Dropped on the board. Closed as anything but completed,
  // or Dropped, is not done.
  ending(issue) {
    const s = this.config.statuses;
    if (issue.state === 'closed') {
      const reason = issue.stateReason ?? 'completed';
      return { done: reason === 'completed', how: `closed as ${reason.replace(/_/g, ' ')}` };
    }
    if (issue.item?.status === s.done) return { done: true, how: s.done };
    if (issue.item?.status === s.dropped) return { done: false, how: s.dropped };
    return null;
  }
  // The changes that finish a pitch or a scope as done: close it as completed and set Done, each only if it is not so.
  // A dropped one is refused, and so is one that is already done.
  finishing(issue, kind) {
    const c = this.config;
    const s = c.statuses;
    const ending = this.ending(issue);
    if (ending && !ending.done) {
      throw new ShapeUpError('input', `#${issue.number} was dropped (${ending.how}); a dropped ${kind} is not done.${kind === 'scope' ? ` ${this.newScopeHint(issue)}` : ''}`);
    }
    const steps = [];
    if (issue.state === 'open') steps.push({ label: `close #${issue.number} as completed`, run: () => this.close(issue.number, 'completed') });
    if (issue.item.status !== s.done) steps.push({ label: `set ${c.statusField} of #${issue.number} to ${s.done}`, run: () => this.board.setStatus(issue.item.id, 'done') });
    if (!steps.length) throw holds(`#${issue.number} is already done: closed as completed and ${s.done}.`);
    this.requireStatus('done');
    return steps;
  }
  // A finished scope is never reopened: the work that follows it is a new scope.
  newScopeHint(scope) {
    const sections = this.spec('scope').required.map(param => ` --${param} …`).join('');
    return `Work that follows a finished scope is a new scope: gh shapeup scope new --pitch ${scope.parent ?? '<number>'} --title …${sections}.`;
  }
  // Makes a command's changes in order. Nothing is rolled back: when a change fails after an earlier one was made, the
  // error lists what was made, what failed, what was not attempted and how to finish, and no comment is posted.
  // again says what running the command again does; an edit sends the same edit again.
  async apply(command, steps, { note = null, rerun = true, again = 'it makes only the changes still missing' } = {}) {
    for (const [index, step] of steps.entries()) {
      try { await step.run(); } catch (error) {
        if (index === 0) throw error;
        const name = item => (typeof item.label === 'function' ? item.label() : item.label);
        const rest = steps.slice(index + 1).map(item => `- ${name(item)}`);
        const finish = rerun
          ? [`To finish, run the same command again: ${again}${note ? ` and then posts the ${note.what}` : ''}. Or make them by hand${note ? ` and post the ${note.what} yourself` : ''}.`,
            // A change that failed here may still have landed on GitHub.
            ...(note ? [`If running it again says the result already holds, post the ${note.what} by hand.`] : [])].join('\n')
          : 'To finish, make the failed and remaining changes by hand. Running the command again would create another issue.';
        throw new ShapeUpError('partial', [
          `${command} stopped after ${index} of ${steps.length} changes. Nothing was rolled back${note ? `, and the ${note.what} was not posted` : ''}.`,
          'Made:', ...steps.slice(0, index).map(item => `- ${name(item)}`),
          'Failed:', `- ${name(step)}: ${error.message}`,
          ...(rest.length ? ['Not attempted:', ...rest] : []),
          finish,
        ].join('\n'));
      }
    }
  }
  // A byte order mark is not part of the Markdown.
  async readMarkdown(file, what) {
    try { return (await this.readText(file)).replace(/^\uFEFF/, ''); } catch { throw new ShapeUpError('input', `Cannot read the ${what} file ${file}.`); }
  }
  // Exactly one of --reason and --reason-file; the file's Markdown is posted as it is.
  async reason(options) {
    const { reason, 'reason-file': file } = options;
    if (reason !== undefined && file !== undefined) throw new ShapeUpError('input', 'Give --reason or --reason-file, not both.');
    if (reason === undefined && file === undefined) {
      throw new ShapeUpError('input', '--reason or --reason-file is required: every change leaves its reason on the issue.');
    }
    const text = file === undefined ? reason.trim() : await this.readMarkdown(file, 'reason');
    if (!text.trim()) throw new ShapeUpError('input', 'The reason is empty.');
    return text;
  }
  // Without a file at the template's path, the config's headings are the report template.
  async reportTemplate(kind) {
    const spec = this.config.reports[kind];
    let text = null;
    try { text = await this.readReportTemplate(spec.template); } catch (error) {
      if (error.code !== 'ENOENT') throw new ShapeUpError('template', `Cannot read the report template ${spec.template}.`);
    }
    return loadReport(kind, spec, text);
  }
  // A completion report comes only from a file: its ## sections do not fit on one command line.
  async report(kind, options) {
    for (const other of ['reason', 'reason-file', 'report']) {
      if (options[other] !== undefined) throw new ShapeUpError('input', `${kind} done takes a completion report from --report-file <file>, not --${other}.`);
    }
    const template = await this.reportTemplate(kind);
    const file = options['report-file'];
    if (file === undefined) {
      throw new ShapeUpError('input', `--report-file is required: ${kind} done posts a completion report with ${template.headings.map(heading => `## ${heading}`).join(', ')}.`);
    }
    return checkReport(template, await this.readMarkdown(file, 'report'));
  }
  // The comment follows the change, so a failed change leaves none. On a scope it also wakes the hill chart Action.
  async explain(number, note) {
    try { await this.api.rest(`/issues/${number}/comments`, { method: 'POST', body: { body: note.text } }); } catch (error) {
      throw new ShapeUpError('comment', `#${number} was changed, but its ${note.what} comment failed: ${error.message} Post the ${note.what} on #${number} by hand.`);
    }
  }
  async run(args) {
    const { kind, action } = args;
    const s = this.config.statuses;
    const done = message => { this.out(message); return message; };
    if (kind === 'init') {
      this.refuseUnread(args, ['force']);
      await new Init({ api: this.api, config: this.config, out: this.out }).run({ force: args.options.force === true });
      return done('init finished');
    }
    if (kind === 'audit') {
      this.refuseUnread(args, ['pitch']);
      await this.board.load();
      let issues = [...new Map([...await this.board.issuesWith([this.config.pitchLabel]),
        ...await this.board.issuesWith([this.config.scopeLabel])].map(issue => [issue.number, issue])).values()];
      if (args.options.pitch) {
        const pitch = Number(args.options.pitch);
        issues = issues.filter(issue => issue.number === pitch || issue.parent === pitch);
      }
      const findings = audit(issues, this.config);
      for (const finding of findings) this.out(`#${finding.number} ${finding.rule}`);
      this.out(`Checked ${issues.length} pitches and scopes: ${findings.length ? `${findings.length} finding(s).` : 'no findings.'}`);
      return findings;
    }
    if (!this.spec(kind)) throw new ShapeUpError('input', usage);
    // The reason or the report is checked before anything changes and posted only once the change is made.
    const note = needsReport(kind, action) ? { what: 'report', text: await this.report(kind, args.options) }
      : needsReason(kind, action) ? { what: 'reason', text: await this.reason(args.options) } : null;
    const reads = this.reads(kind, action);
    if (reads) this.refuseUnread(args, reads);
    const changed = async (number, message) => { await this.explain(number, note); return done(message); };
    const c = this.config;
    const set = (number, field, value) => `set ${field} of #${number} to ${value}`;
    const step = (label, run) => ({ label, run });
    if (action === 'new' && (kind === 'cooldown' || kind === 'bug')) {
      let issue;
      await this.apply(`${kind} new`, [step(`create the ${kind} issue`, async () => { issue = await this.create(kind, args); })]);
      return done(`#${issue.number} ${issue.html_url}`);
    }
    if (action === 'edit') {
      const { issue, patch } = await this.edit(kind, args);
      const steps = [];
      if (patch) {
        steps.push(step(`edit the ${patch.title === undefined ? 'body' : 'title and body'} of #${issue.number}`,
          () => this.api.rest(`/issues/${issue.number}`, { method: 'PATCH', body: patch })));
      }
      const appetite = args.options.appetite;
      // Every refusal comes before the first change, so a change always leaves its comment.
      if (appetite !== undefined) {
        await this.board.load();
        if (issue.item?.status !== s.shaped) throw new ShapeUpError('input', `Appetite changes only on a pitch that is ${s.shaped}.`);
        const name = this.appetite(appetite);
        this.board.option('appetite', name);
        if (issue.item.appetite !== name) steps.push(step(set(issue.number, c.appetiteField, name), () => this.board.setAppetite(issue.item.id, appetite)));
        else if (!patch) throw holds(`#${issue.number} already has ${c.appetiteField} ${name}.`);
      }
      await this.apply(`${kind} edit #${issue.number}`, steps, { note, again: 'it sends the same edit again, makes the changes still missing' });
      return changed(issue.number, `#${issue.number} updated`);
    }
    await this.board.load();
    if (kind === 'pitch' && action === 'new') {
      need(args.options.appetite, '--appetite is required.');
      const name = this.appetite(args.options.appetite);
      this.board.option('appetite', name);
      this.requireStatus('shaped');
      let issue, item;
      await this.apply('pitch new', [
        step(() => (issue ? `create #${issue.number} ${issue.html_url}` : 'create the pitch issue'), async () => { issue = await this.create('pitch', args); }),
        step(() => `add #${issue.number} to the project`, async () => { item = await this.board.add(issue.node_id); }),
        step(() => set(issue.number, c.statusField, s.shaped), () => this.board.setStatus(item, 'shaped')),
        step(() => set(issue.number, c.appetiteField, name), () => this.board.setAppetite(item, args.options.appetite)),
      ], { rerun: false });
      return done(`#${issue.number} ${issue.html_url}`);
    }
    if (kind === 'pitch' && action === 'bet') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      const title = need(args.options.cycle, '--cycle is required.');
      const iteration = this.board.iteration(title);
      const ending = this.ending(pitch);
      if (ending) throw new ShapeUpError('input', `#${pitch.number} is finished (${ending.how}); a finished pitch is not bet again.`);
      const scopes = (await this.children(pitch)).filter(scope => scope.item && !this.ending(scope));
      this.requireStatus('bet');
      // Only what differs changes, so a pitch already past Bet keeps its status and a run that stopped can be run again.
      const steps = [];
      for (const issue of [pitch, ...scopes]) {
        if (issue.item.cycle?.id !== iteration) steps.push(step(set(issue.number, c.cycleField, title), () => this.board.setCycle(issue.item.id, iteration)));
        if ([s.shaped, null].includes(issue.item.status)) steps.push(step(set(issue.number, c.statusField, s.bet), () => this.board.setStatus(issue.item.id, 'bet')));
      }
      if (!steps.length) throw holds(`#${pitch.number} is already bet on ${title}.`);
      await this.apply(`pitch bet #${pitch.number}`, steps, { note });
      return changed(pitch.number, `#${pitch.number} bet on ${title}`);
    }
    if (kind === 'pitch' && action === 'unbet') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      const ending = this.ending(pitch);
      if (ending) throw new ShapeUpError('input', `#${pitch.number} is finished (${ending.how}); a finished pitch is not unbet.`);
      const scopes = (await this.children(pitch)).filter(scope => scope.item && !this.ending(scope));
      this.requireStatus('shaped');
      const steps = [];
      for (const issue of [pitch, ...scopes]) {
        if (issue.item.status !== s.shaped) steps.push(step(set(issue.number, c.statusField, s.shaped), () => this.board.setStatus(issue.item.id, 'shaped')));
        if (issue.item.cycle) steps.push(step(`clear ${c.cycleField} of #${issue.number}`, () => this.board.clear(issue.item.id, 'cycle')));
      }
      if (!steps.length) throw holds(`#${pitch.number} and its scopes are already ${s.shaped} with no ${c.cycleField}.`);
      await this.apply(`pitch unbet #${pitch.number}`, steps, { note });
      return changed(pitch.number, `#${pitch.number} back to ${s.shaped}`);
    }
    if (kind === 'pitch' && action === 'break') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      const ending = this.ending(pitch);
      if (ending?.done) throw new ShapeUpError('input', `#${pitch.number} is done (${ending.how}); the circuit breaker stops only a pitch that is not finished.`);
      // Scopes that were done stay done; every other scope is dropped with the pitch.
      const scopes = (await this.children(pitch)).filter(scope => !this.ending(scope)?.done);
      this.requireStatus('dropped');
      const steps = [];
      for (const issue of [...scopes, pitch]) {
        if (issue.state === 'open') steps.push(step(`close #${issue.number} as not planned`, () => this.close(issue.number, 'not_planned')));
        if (issue.item && issue.item.status !== s.dropped) steps.push(step(set(issue.number, c.statusField, s.dropped), () => this.board.setStatus(issue.item.id, 'dropped')));
      }
      if (!steps.length) throw holds(`#${pitch.number} is already closed by the circuit breaker.`);
      await this.apply(`pitch break #${pitch.number}`, steps, { note });
      return changed(pitch.number, `#${pitch.number} closed by the circuit breaker`);
    }
    if (kind === 'pitch' && action === 'done') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      const steps = this.finishing(pitch, 'pitch');
      const open = (await this.children(pitch)).filter(scope => scope.state === 'open').map(scope => `#${scope.number}`);
      if (open.length) throw new ShapeUpError('input', `Scopes are still open: ${open.join(', ')}`);
      await this.apply(`pitch done #${pitch.number}`, steps, { note });
      return changed(pitch.number, `#${pitch.number} done`);
    }
    if (kind === 'scope' && action === 'new') {
      const pitch = await this.boardIssue(need(args.options.pitch, '--pitch is required.') && Number(args.options.pitch), 'pitch');
      const ending = this.ending(pitch);
      if (ending) throw new ShapeUpError('input', `#${pitch.number} is finished (${ending.how}); a new scope needs a pitch that is not finished.`);
      const status = [s.bet, s.doing].includes(pitch.item.status) ? 'bet' : 'shaped';
      this.requireStatus(status);
      let issue, item;
      await this.apply('scope new', [
        step(() => (issue ? `create #${issue.number} ${issue.html_url}` : 'create the scope issue'), async () => { issue = await this.create('scope', args); }),
        step(() => `link #${issue.number} as a sub-issue of #${pitch.number}`,
          () => this.api.rest(`/issues/${pitch.number}/sub_issues`, { method: 'POST', body: { sub_issue_id: issue.id } })),
        step(() => `add #${issue.number} to the project`, async () => { item = await this.board.add(issue.node_id); }),
        step(() => set(issue.number, c.statusField, s[status]), () => this.board.setStatus(item, status)),
        ...(pitch.item.cycle ? [step(() => set(issue.number, c.cycleField, pitch.item.cycle.title), () => this.board.setCycle(item, pitch.item.cycle.id))] : []),
        step(() => set(issue.number, c.hillField, 0), () => this.board.setHill(item, 0)),
      ], { rerun: false });
      return done(`#${issue.number} ${issue.html_url}`);
    }
    if (kind === 'scope' && action === 'start') {
      const scope = await this.boardIssue(args.number, 'scope');
      const ending = this.ending(scope);
      if (ending) throw new ShapeUpError('input', `#${scope.number} is finished (${ending.how}) and is not started again. ${this.newScopeHint(scope)}`);
      if (scope.item.status === s.doing) throw holds(`#${scope.number} is already ${s.doing}.`);
      this.requireStatus('doing');
      await this.apply(`scope start #${scope.number}`, [step(set(scope.number, c.statusField, s.doing), () => this.board.setStatus(scope.item.id, 'doing'))], { note });
      return changed(scope.number, `#${scope.number} ${s.doing}`);
    }
    if (kind === 'scope' && action === 'hill') {
      const scope = await this.boardIssue(args.number, 'scope');
      const raw = need(args.options.position, '--position is required.');
      if (!/^[0-9]{1,3}$/.test(raw)) throw new ShapeUpError('position', 'Hill Position must be an integer from 0 to 100.');
      const position = requirePosition(Number(raw));
      // A done scope may still be moved to the top of the hill, where it belongs; nothing else moves a finished scope.
      const ending = this.ending(scope);
      if (ending && !ending.done) throw new ShapeUpError('input', `#${scope.number} was dropped (${ending.how}), so its hill position stays. ${this.newScopeHint(scope)}`);
      if (ending && position !== 100) throw new ShapeUpError('input', `#${scope.number} is done (${ending.how}), so it moves only to 100 on the hill. ${this.newScopeHint(scope)}`);
      if ((scope.item.hill ?? 0) === position) throw holds(`#${scope.number} is already at ${position} on the hill.`);
      await this.apply(`scope hill #${scope.number}`, [step(set(scope.number, c.hillField, position), () => this.board.setHill(scope.item.id, position))], { note });
      // The reason comment is also the hill chart Action's trigger, so it must follow the field change.
      return changed(scope.number, `#${scope.number} hill ${scope.item.hill ?? 0} → ${position}`);
    }
    if (kind === 'scope' && action === 'done') {
      const scope = await this.boardIssue(args.number, 'scope');
      await this.apply(`scope done #${scope.number}`, this.finishing(scope, 'scope'), { note });
      return changed(scope.number, `#${scope.number} done`);
    }
    throw new ShapeUpError('input', usage);
  }
}

// The nearest directory at or above start that holds the config, so the CLI runs from anywhere in the repository.
export async function findRoot(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    try { await access(join(dir, defaultConfigPath)); return dir; } catch { /* keep climbing */ }
    if (dirname(dir) === dir) return resolve(start);
  }
}

const runGh = async (file, args) => (await promisify(execFile)(file, args)).stdout;

// gh gives an extension no token, only GH_PATH, so the token and the repository are asked of gh.
// GH_TOKEN and SHAPEUP_REPOSITORY override them.
export async function credentials(env, run = runGh) {
  const gh = env.GH_PATH || 'gh';
  const ask = async (args, message) => {
    let value = '';
    let detail = '';
    try { value = (await run(gh, args)).trim(); } catch (error) { detail = error.stderr?.trim() || error.message; }
    if (!value) throw new ShapeUpError('credential', detail ? `${message}\n${detail}` : message);
    return value;
  };
  const token = env.GH_TOKEN || await ask(['auth', 'token'], 'No token: run gh auth login, or set GH_TOKEN.');
  const repository = env.SHAPEUP_REPOSITORY || await ask(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    'No repository: run inside a clone of a GitHub repository, or set SHAPEUP_REPOSITORY.');
  return { token, repository };
}

// A report template's path is relative to the repository root; templateDir holds only the issue templates.
export const reportTemplateReader = root => path => readFile(resolve(root, path), 'utf8');

// The token never comes from the command line. SHAPEUP_PROJECT_TOKEN, when set, is the one for the project.
export async function main(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const args = parseArgs(argv);
  if (!args.kind || args.kind === 'help') { console.log(usage); return 0; }
  const root = env.SHAPEUP_CONFIG ? cwd : await findRoot(cwd);
  const config = await loadConfig(env.SHAPEUP_CONFIG || join(root, defaultConfigPath));
  const { token, repository } = await credentials(env);
  const api = new GitHub({ repository, repositoryToken: token, projectToken: env.SHAPEUP_PROJECT_TOKEN || token });
  const cli = new Cli({ api, board: new Board(api, config), config,
    readTemplate: name => readFile(resolve(root, config.templateDir, name), 'utf8'),
    readReportTemplate: reportTemplateReader(root) });
  const result = await cli.run(args);
  return Array.isArray(result) && result.length ? 1 : 0;
}
