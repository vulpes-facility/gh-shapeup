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
exactly the ## sections of the report template, in order, none of them empty.`;

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
  // check runs after the edit's own checks and before the edit, so it can still refuse.
  async edit(kind, args, check = async () => {}) {
    const number = need(args.number, 'An issue number is required.');
    const issue = await this.board.issue(number);
    if (!issue.labels.includes(this.config[`${kind}Label`])) throw new ShapeUpError('type', `#${number} is not a ${kind} issue.`);
    const template = await this.template(kind);
    const patch = { body: editBody(issue.body, await this.values(kind, args), footnoteValues(args.footnotes)) };
    if (args.options.title !== undefined) patch.title = titleFor(template, args.options.title);
    await check(issue);
    await this.api.rest(`/issues/${number}`, { method: 'PATCH', body: patch });
    return issue;
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
  // A command that closes an issue before it sets the status looks the option up first, so a board without it refuses
  // before anything closes.
  requireStatus(key) { this.board.option('status', this.config.statuses[key]); }
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
      await new Init({ api: this.api, config: this.config, out: this.out }).run({ force: args.options.force === true });
      return done('init finished');
    }
    if (kind === 'audit') {
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
    const changed = async (number, message) => { await this.explain(number, note); return done(message); };
    if (action === 'new' && (kind === 'cooldown' || kind === 'bug')) {
      const issue = await this.create(kind, args);
      return done(`#${issue.number} ${issue.html_url}`);
    }
    if (action === 'edit') {
      const appetite = kind === 'pitch' ? args.options.appetite : undefined;
      // Every refusal comes before the first change, so a change always leaves its comment.
      const issue = await this.edit(kind, args, async pitch => {
        if (appetite === undefined) return;
        await this.board.load();
        if (pitch.item?.status !== s.shaped) throw new ShapeUpError('input', `Appetite changes only on a pitch that is ${s.shaped}.`);
        this.board.option('appetite', this.appetite(appetite));
      });
      if (appetite !== undefined) await this.board.setAppetite(issue.item.id, appetite);
      return changed(issue.number, `#${issue.number} updated`);
    }
    await this.board.load();
    if (kind === 'pitch' && action === 'new') {
      need(args.options.appetite, '--appetite is required.');
      this.appetite(args.options.appetite);
      const issue = await this.create('pitch', args);
      const item = await this.board.add(issue.node_id);
      await this.board.setStatus(item, 'shaped');
      await this.board.setAppetite(item, args.options.appetite);
      return done(`#${issue.number} ${issue.html_url}`);
    }
    if (kind === 'pitch' && action === 'bet') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      const iteration = this.board.iteration(need(args.options.cycle, '--cycle is required.'));
      await this.board.setStatus(pitch.item.id, 'bet');
      await this.board.setCycle(pitch.item.id, iteration);
      for (const scope of (await this.children(pitch)).filter(c => c.state === 'open' && c.item)) {
        await this.board.setCycle(scope.item.id, iteration);
        if ([s.shaped, null].includes(scope.item.status)) await this.board.setStatus(scope.item.id, 'bet');
      }
      return changed(pitch.number, `#${pitch.number} bet on ${args.options.cycle}`);
    }
    if (kind === 'pitch' && action === 'unbet') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      await this.board.setStatus(pitch.item.id, 'shaped');
      await this.board.clear(pitch.item.id, 'cycle');
      for (const scope of (await this.children(pitch)).filter(c => c.state === 'open' && c.item)) {
        await this.board.setStatus(scope.item.id, 'shaped');
        await this.board.clear(scope.item.id, 'cycle');
      }
      return changed(pitch.number, `#${pitch.number} back to ${s.shaped}`);
    }
    if (kind === 'pitch' && action === 'break') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      this.requireStatus('dropped');
      for (const scope of (await this.children(pitch)).filter(c => c.state === 'open')) {
        await this.close(scope.number, 'not_planned');
        if (scope.item) await this.board.setStatus(scope.item.id, 'dropped');
      }
      if (pitch.state === 'open') await this.close(pitch.number, 'not_planned');
      await this.board.setStatus(pitch.item.id, 'dropped');
      return changed(pitch.number, `#${pitch.number} closed by the circuit breaker`);
    }
    if (kind === 'pitch' && action === 'done') {
      const pitch = await this.boardIssue(args.number, 'pitch');
      const open = (await this.children(pitch)).filter(c => c.state === 'open').map(c => `#${c.number}`);
      if (open.length) throw new ShapeUpError('input', `Scopes are still open: ${open.join(', ')}`);
      this.requireStatus('done');
      if (pitch.state === 'open') await this.close(pitch.number, 'completed');
      await this.board.setStatus(pitch.item.id, 'done');
      return changed(pitch.number, `#${pitch.number} done`);
    }
    if (kind === 'scope' && action === 'new') {
      const pitch = await this.boardIssue(need(args.options.pitch, '--pitch is required.') && Number(args.options.pitch), 'pitch');
      if (pitch.state !== 'open') throw new ShapeUpError('input', `#${pitch.number} is a closed pitch.`);
      const issue = await this.create('scope', args);
      await this.api.rest(`/issues/${pitch.number}/sub_issues`, { method: 'POST', body: { sub_issue_id: issue.id } });
      const item = await this.board.add(issue.node_id);
      await this.board.setStatus(item, [s.bet, s.doing].includes(pitch.item.status) ? 'bet' : 'shaped');
      if (pitch.item.cycle) await this.board.setCycle(item, pitch.item.cycle.id);
      await this.board.setHill(item, 0);
      return done(`#${issue.number} ${issue.html_url}`);
    }
    if (kind === 'scope' && action === 'start') {
      const scope = await this.boardIssue(args.number, 'scope');
      if (scope.state !== 'open') throw new ShapeUpError('input', `#${scope.number} is closed.`);
      await this.board.setStatus(scope.item.id, 'doing');
      return changed(scope.number, `#${scope.number} ${s.doing}`);
    }
    if (kind === 'scope' && action === 'hill') {
      const scope = await this.boardIssue(args.number, 'scope');
      const raw = need(args.options.position, '--position is required.');
      if (!/^[0-9]{1,3}$/.test(raw)) throw new ShapeUpError('position', 'Hill Position must be an integer from 0 to 100.');
      const position = requirePosition(Number(raw));
      await this.board.setHill(scope.item.id, position);
      // The reason comment is also the hill chart Action's trigger, so it must follow the field change.
      return changed(scope.number, `#${scope.number} hill ${scope.item.hill ?? 0} → ${position}`);
    }
    if (kind === 'scope' && action === 'done') {
      const scope = await this.boardIssue(args.number, 'scope');
      this.requireStatus('done');
      if (scope.state === 'open') await this.close(scope.number, 'completed');
      await this.board.setStatus(scope.item.id, 'done');
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

// The token never comes from the command line.
export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (!args.kind || args.kind === 'help') { console.log(usage); return 0; }
  const root = env.SHAPEUP_CONFIG ? process.cwd() : await findRoot(process.cwd());
  const config = await loadConfig(env.SHAPEUP_CONFIG || join(root, defaultConfigPath));
  const { token, repository } = await credentials(env);
  const api = new GitHub({ repository, repositoryToken: token, projectToken: token });
  const cli = new Cli({ api, board: new Board(api, config), config,
    readTemplate: name => readFile(resolve(root, config.templateDir, name), 'utf8'),
    readReportTemplate: path => readFile(resolve(root, path), 'utf8') });
  const result = await cli.run(args);
  return Array.isArray(result) && result.length ? 1 : 0;
}
