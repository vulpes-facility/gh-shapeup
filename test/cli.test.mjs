import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cli, credentials, findRoot, main, parseArgs, reportTemplateReader } from '../src/cli.mjs';
import { audit } from '../src/audit.mjs';
import { parseConfig } from '../src/config.mjs';
import { ShapeUpError } from '../src/domain.mjs';

const config = parseConfig(readFileSync('examples/shapeup.json', 'utf8'));
const s = config.statuses;
const reports = {
  pitch: '## Outcome\n\nPlayers can pay.\n\n## Scopes\n\n- #11 merged\n- #12 merged\n\n## Accepted limits\n\nNo refunds yet.\n\n## Follow-ups\n\nNone.\n',
  scope: '## Outcome\n\nMerged.\n\n## Evidence\n\n- Pull request #5, tests pass.\n\n## Follow-ups\n\nNone.\n',
};
const cycle = { title: 'Cycle 2', id: 'c2' };

function fixture() {
  const calls = [];
  const issues = new Map();
  const files = new Map();
  const templates = new Map();
  const reads = [];
  const failing = new Set();
  let next = 30;
  const boardIssue = (number, labels, item, extra = {}) => issues.set(number, { number, title: `T${number}`, body: '',
    state: 'open', stateReason: null, labels, parent: null, item, ...extra });
  boardIssue(10, ['pitch'], { id: 'I10', status: s.bet, appetite: '1 cycle', cycle, hill: null });
  boardIssue(11, ['scope'], { id: 'I11', status: s.bet, cycle, hill: 30 }, { parent: 10 });
  boardIssue(12, ['scope'], { id: 'I12', status: s.doing, cycle, hill: null }, { parent: 10 });
  boardIssue(20, ['cooldown'], null);
  boardIssue(21, ['bug'], null);
  const api = {
    async rest(path, options = {}) {
      if (failing.has(`${options.method ?? 'GET'} ${path}`)) throw new ShapeUpError('api', 'GitHub API request failed (HTTP 500).');
      calls.push(['rest', options.method ?? 'GET', path, options.body]);
      const closing = issues.get(Number(path.split('/')[2]));
      if (options.method === 'PATCH' && options.body?.state === 'closed' && closing) Object.assign(closing, { state: 'closed', stateReason: options.body.state_reason });
      if (path === '/issues' && options.method === 'POST') { const number = next++; return { number, id: number * 10, node_id: `N${number}`, html_url: `https://x/${number}` }; }
      return {};
    },
    async children(number) { return [...issues.values()].filter(i => i.parent === number).map(i => ({ number: i.number, labels: i.labels.map(name => ({ name })) })); },
  };
  // Board changes are recorded, applied to the issues and can be made to fail, as in failing.add('cycle I11').
  const change = (kind, item, value, apply) => {
    if (failing.has(`${kind} ${item}`)) throw new ShapeUpError('graphql', 'A GitHub Project GraphQL request failed.');
    calls.push([kind, item, value]);
    const issue = [...issues.values()].find(i => i.item?.id === item);
    if (issue) apply(issue.item);
  };
  const board = {
    async load() { calls.push(['load']); },
    async issue(number) { const issue = issues.get(number); if (!issue) throw new Error(`no ${number}`); return structuredClone(issue); },
    async add(node) { change('add', node, undefined, () => {}); calls.at(-1).pop(); return `item-${node}`; },
    async setStatus(item, key) { change('status', item, key, i => { i.status = s[key]; }); },
    async setAppetite(item, value) { change('appetite', item, value, i => { i.appetite = config.appetites[value]; }); },
    async setCycle(item, id) { change('cycle', item, id, i => { i.cycle = { ...cycle, id }; }); },
    async setHill(item, value) { change('hill', item, value, i => { i.hill = value; }); },
    async clear(item, field) { change('clear', item, field, i => { i[field] = null; }); },
    iteration(title) { if (title !== 'Cycle 2') throw new Error('bad cycle'); return 'c2'; },
    option(field, name) {
      if (![...Object.values(s), ...Object.values(config.appetites)].includes(name)) throw new ShapeUpError('field', `The field has no option named "${name}".`);
      return name;
    },
    async issuesWith() { return [...issues.values()]; },
  };
  const out = [];
  const cli = new Cli({ api, board, config,
    readTemplate: name => { reads.push(['template', name]); return readFileSync(`examples/ISSUE_TEMPLATE/${name}`, 'utf8'); },
    readReportTemplate: async path => {
      reads.push(['report', path]);
      if (!templates.has(path)) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return templates.get(path);
    },
    readText: async path => { if (!files.has(path)) throw new Error(`ENOENT ${path}`); return files.get(path); }, out: line => out.push(line) });
  return { cli, board, calls, issues, files, templates, reads, failing, out, run: argv => cli.run(parseArgs(argv)) };
}

test('arguments: kind, action, number, repeated footnotes, missing values', () => {
  assert.deepEqual(parseArgs(['scope', 'hill', '11', '--position', '45', '--reason', 'why', '--footnote', 'a=1', '--footnote', 'b=2']),
    { kind: 'scope', action: 'hill', number: 11, options: { position: '45', reason: 'why' }, footnotes: ['a=1', 'b=2'] });
  assert.deepEqual(parseArgs(['audit', '--pitch', '10']).options, { pitch: '10' });
  assert.throws(() => parseArgs(['pitch', 'new', '--title']), { code: 'input' });
  assert.throws(() => parseArgs(['pitch', 'edit', 'x']), { code: 'input' });
});

test('credentials come from the environment first and from gh otherwise', async () => {
  const asked = [];
  const run = async (file, args) => { asked.push([file, ...args].join(' ')); return args[0] === 'auth' ? 'gho_x\n' : 'o/r\n'; };
  assert.deepEqual(await credentials({ GH_TOKEN: 't', SHAPEUP_REPOSITORY: 'a/b' }, run), { token: 't', repository: 'a/b' });
  assert.deepEqual(asked, []);
  assert.deepEqual(await credentials({ GH_PATH: '/bin/gh' }, run), { token: 'gho_x', repository: 'o/r' });
  assert.deepEqual(asked, ['/bin/gh auth token', '/bin/gh repo view --json nameWithOwner --jq .nameWithOwner']);
  const failing = async () => { throw Object.assign(new Error('exit 1'), { stderr: 'not logged in\n' }); };
  await assert.rejects(credentials({}, failing), { code: 'credential', message: 'No token: run gh auth login, or set GH_TOKEN.\nnot logged in' });
});

test('the root is the nearest directory above that holds the config', async () => {
  const top = await mkdtemp(join(tmpdir(), 'shapeup-'));
  const deep = join(top, 'a', 'b');
  await mkdir(deep, { recursive: true });
  assert.equal(await findRoot(deep), deep);
  await mkdir(join(top, '.github'));
  await writeFile(join(top, '.github', 'shapeup.json'), '{}');
  assert.equal(await findRoot(deep), top);
  assert.equal(await findRoot(top), top);
});
test('pitch new creates the issue from the template and puts it on the board as shaped', async () => {
  const f = fixture();
  await f.run(['pitch', 'new', '--title', 'New pitch', '--appetite', '2', '--problem', 'p', '--solution', 's', '--rabbit-holes', 'r', '--no-gos', 'n']);
  const create = f.calls.find(c => c[0] === 'rest' && c[2] === '/issues');
  assert.equal(create[3].title, 'Pitch: New pitch');
  assert.deepEqual(create[3].labels, ['pitch']);
  assert.deepEqual(create[3].assignees, ['octocat']);
  assert.match(create[3].body, /<!-- hill:start -->/);
  assert.deepEqual(f.calls.filter(c => ['add', 'status', 'appetite'].includes(c[0])),
    [['add', 'N30'], ['status', 'item-N30', 'shaped'], ['appetite', 'item-N30', '2']]);
});
test('without an assignee the issue is created unassigned', async () => {
  const f = fixture();
  f.cli.config = { ...config, assignee: null };
  await f.run(['cooldown', 'new', '--title', 'Tidy', '--what', 'w', '--done', 'd']);
  assert.deepEqual(f.calls.find(c => c[2] === '/issues')[3].assignees, []);
});
test('pitch new rejects an unknown appetite before creating anything', async () => {
  const f = fixture();
  await assert.rejects(f.run(['pitch', 'new', '--title', 't', '--appetite', '3']), { code: 'input' });
  assert.ok(!f.calls.some(c => c[2] === '/issues'));
});
test('scope new links the sub-issue and inherits the pitch cycle with Hill Position 0', async () => {
  const f = fixture();
  await f.run(['scope', 'new', '--pitch', '10', '--title', 'New scope', '--done', 'Done']);
  assert.deepEqual(f.calls.find(c => c[2] === '/issues/10/sub_issues').slice(1), ['POST', '/issues/10/sub_issues', { sub_issue_id: 300 }]);
  assert.deepEqual(f.calls.filter(c => ['status', 'cycle', 'hill'].includes(c[0])),
    [['status', 'item-N30', 'bet'], ['cycle', 'item-N30', 'c2'], ['hill', 'item-N30', 0]]);
});
test('scope hill sets the field before the reason comment, and needs a reason', async () => {
  const f = fixture();
  await f.run(['scope', 'hill', '11', '--position', '45', '--reason', 'The approach is settled.']);
  const order = f.calls.filter(c => c[0] === 'hill' || c[2] === '/issues/11/comments').map(c => c[0]);
  assert.deepEqual(order, ['hill', 'rest']);
  assert.deepEqual(f.calls.find(c => c[2] === '/issues/11/comments')[3], { body: 'The approach is settled.' });
  assert.match(f.out.at(-1), /30 → 45/);
  await assert.rejects(f.run(['scope', 'hill', '11', '--position', '50']), { code: 'input' });
  await assert.rejects(f.run(['scope', 'hill', '11', '--position', '101', '--reason', 'x']), { code: 'position' });
  await assert.rejects(f.run(['scope', 'hill', '10', '--position', '10', '--reason', 'x']), { code: 'type' });
});
test('pitch break closes open scopes and the pitch as not planned and keeps the cycle', async () => {
  const f = fixture();
  await f.run(['pitch', 'break', '10', '--reason', 'Out of time.']);
  assert.deepEqual(f.calls.filter(c => c[1] === 'PATCH').map(c => [c[2], c[3].state_reason]),
    [['/issues/11', 'not_planned'], ['/issues/12', 'not_planned'], ['/issues/10', 'not_planned']]);
  assert.ok(f.calls.filter(c => c[0] === 'status').every(c => c[2] === 'dropped'));
  assert.ok(!f.calls.some(c => c[0] === 'clear'));
});
test('pitch done refuses while a scope is open', async () => {
  const f = fixture();
  f.files.set('report.md', reports.pitch);
  await assert.rejects(f.run(['pitch', 'done', '10', '--report-file', 'report.md']), /#11, #12/);
});
const finishedScope = (f, extra) => f.issues.set(13, { number: 13, title: 'T13', body: '', state: 'closed', stateReason: 'completed',
  labels: ['scope'], parent: 10, item: { id: 'I13', status: s.done, cycle: null, hill: 100 }, ...extra });
test('pitch bet and unbet move the pitch and its unfinished scopes together, changing only what differs', async () => {
  const f = fixture();
  for (const number of [10, 11, 12]) f.issues.get(number).item.cycle = null;
  f.issues.get(10).item.status = s.shaped;
  f.issues.get(11).item.status = s.shaped;
  finishedScope(f);
  await f.run(['pitch', 'bet', '10', '--cycle', 'Cycle 2', '--reason', 'Bet at the table.']);
  assert.deepEqual(f.calls.filter(c => ['status', 'cycle'].includes(c[0])),
    [['cycle', 'I10', 'c2'], ['status', 'I10', 'bet'], ['cycle', 'I11', 'c2'], ['status', 'I11', 'bet'], ['cycle', 'I12', 'c2']]);
  const g = fixture();
  finishedScope(g);
  await g.run(['pitch', 'unbet', '10', '--reason', 'Not this cycle.']);
  assert.deepEqual(g.calls.filter(c => ['status', 'clear'].includes(c[0])), [['status', 'I10', 'shaped'], ['clear', 'I10', 'cycle'],
    ['status', 'I11', 'shaped'], ['clear', 'I11', 'cycle'], ['status', 'I12', 'shaped'], ['clear', 'I12', 'cycle']]);
  const h = fixture();
  h.issues.get(10).item.status = s.doing;
  h.issues.get(10).item.cycle = null;
  await h.run(['pitch', 'bet', '10', '--cycle', 'Cycle 2', '--reason', 'Moved.']);
  assert.deepEqual(h.calls.filter(c => ['status', 'cycle'].includes(c[0])), [['cycle', 'I10', 'c2']]);
});
test('cooldown and bug are created from their templates without touching the board', async () => {
  const f = fixture();
  await f.run(['bug', 'new', '--title', 'It freezes', '--symptom', 'Frozen', '--steps', '1. Press it', '--expected', 'It moves']);
  const create = f.calls.find(c => c[2] === '/issues');
  assert.equal(create[3].title, 'Bug: It freezes');
  assert.match(create[3].body, /## Steps\n\n1\. Press it/);
  assert.ok(!f.calls.some(c => ['load', 'add', 'status'].includes(c[0])));
});
test('edit refuses the wrong kind', async () => {
  const f = fixture();
  await assert.rejects(f.run(['scope', 'edit', '10', '--done', 'x', '--reason', 'y']), { code: 'type' });
});

// Each command that changes an issue with a reason, and the issue it comments on.
const changes = [
  [['pitch', 'edit', '10', '--title', 'Renamed'], 10],
  [['pitch', 'bet', '10', '--cycle', 'Cycle 2'], 10, f => { f.issues.get(10).item.status = s.shaped; }],
  [['pitch', 'unbet', '10'], 10],
  [['pitch', 'break', '10'], 10],
  [['scope', 'edit', '11', '--done', 'Merged'], 11],
  [['scope', 'start', '11'], 11],
  [['scope', 'hill', '11', '--position', '45'], 11],
  [['cooldown', 'edit', '20', '--what', 'Tidy'], 20],
  [['bug', 'edit', '21', '--expected', 'It moves'], 21],
];
// Each command that finishes an issue with a report, the issue it comments on, and what lets it finish in the fixture.
const finishes = [
  [['pitch', 'done', '10'], 10, f => { f.issues.get(11).state = 'closed'; f.issues.get(12).state = 'closed'; }],
  [['scope', 'done', '11'], 11, () => {}],
];
const comments = f => f.calls.filter(c => c[0] === 'rest' && c[2].endsWith('/comments'));

test('every change needs exactly one non-empty reason and checks it before anything changes', async () => {
  for (const [argv] of changes) {
    const name = argv.slice(0, 2).join(' ');
    const f = fixture();
    f.files.set('blank.md', ' \n\t\n');
    await assert.rejects(f.run(argv), { code: 'input', message: /^--reason or --reason-file is required/ }, name);
    await assert.rejects(f.run([...argv, '--reason', 'a', '--reason-file', 'why.md']), { code: 'input', message: /not both/ }, name);
    await assert.rejects(f.run([...argv, '--reason', '']), { code: 'input', message: 'The reason is empty.' }, name);
    await assert.rejects(f.run([...argv, '--reason', '  \t ']), { code: 'input', message: 'The reason is empty.' }, name);
    await assert.rejects(f.run([...argv, '--reason-file', 'blank.md']), { code: 'input', message: 'The reason is empty.' }, name);
    await assert.rejects(f.run([...argv, '--reason-file', 'missing.md']), { code: 'input', message: 'Cannot read the reason file missing.md.' }, name);
    assert.deepEqual(f.calls, [], name);
  }
});
test('each change is followed by one reason comment on the issue it names', async () => {
  for (const [argv, number, prepare] of changes) {
    const name = argv.slice(0, 2).join(' ');
    const f = fixture();
    prepare?.(f);
    await f.run([...argv, '--reason', `  Why ${name}.  `]);
    assert.deepEqual(comments(f), [['rest', 'POST', `/issues/${number}/comments`, { body: `Why ${name}.` }]], name);
    assert.ok(f.calls.length > 1, name);
    assert.deepEqual(f.calls.at(-1), comments(f)[0], name);
  }
});
test('--reason-file posts its Markdown as it is', async () => {
  for (const [argv, number, prepare] of changes) {
    const name = argv.slice(0, 2).join(' ');
    const f = fixture();
    prepare?.(f);
    const report = `## Result\n\n- ${name} shipped\n  - with a nested point\n\n    indented code\n`;
    f.files.set('report.md', report);
    await f.run([...argv, '--reason-file', 'report.md']);
    assert.deepEqual(comments(f), [['rest', 'POST', `/issues/${number}/comments`, { body: report }]], name);
  }
});
test('pitch done and scope done need a report file that matches the default template, checked before anything changes', async () => {
  const headings = { pitch: '## Outcome, ## Scopes, ## Accepted limits, ## Follow-ups', scope: '## Outcome, ## Evidence, ## Follow-ups' };
  for (const [argv] of finishes) {
    const kind = argv[0];
    const f = fixture();
    const rejects = (extra, message) => assert.rejects(f.run([...argv, ...extra]), { code: 'input', message }, `${kind} ${extra.join(' ')}`);
    await rejects([], `--report-file is required: ${kind} done posts a completion report with ${headings[kind]}.`);
    for (const other of ['reason', 'reason-file', 'report']) {
      f.files.set('report.md', reports[kind]);
      await rejects([`--${other}`, 'x', '--report-file', 'report.md'], `${kind} done takes a completion report from --report-file <file>, not --${other}.`);
    }
    await rejects(['--report-file', 'missing.md'], 'Cannot read the report file missing.md.');
    const [first, ...rest] = reports[kind].split(/(?=^## )/m);
    for (const [report, message] of [
      ['', /^The report has no "## Outcome" section\. It needs /],
      [rest.join(''), /^The report has no "## Outcome" section/],
      [`# Report\n\n${reports[kind]}`, 'The report must start with its first section, "## Outcome".'],
      [[...rest, first].join('\n'), /^The report must have exactly these sections, in this order: /],
      [`${reports[kind]}\n## Notes\n\nMore.\n`, /^The report must have exactly these sections, in this order: /],
      [`${first}\n${first}${rest.join('')}`, /^The report must have exactly these sections, in this order: /],
      [reports[kind].replace('None.', ''), 'The report\'s "## Follow-ups" section is empty. Write what applies, or that nothing does.'],
      [reports[kind].replace('None.', '<!-- What is left for later. -->'), 'The report\'s "## Follow-ups" section is empty. Write what applies, or that nothing does.'],
    ]) {
      f.files.set('report.md', report);
      await rejects(['--report-file', 'report.md'], message);
    }
    assert.deepEqual(f.calls, [], kind);
  }
});
test('a completion report is posted as given, after the change, on the issue it finishes', async () => {
  for (const [argv, number, prepare] of finishes) {
    const kind = argv[0];
    for (const report of [reports[kind], `<!-- Written by hand. -->\r\n${reports[kind].replace(/\n/g, '\r\n')}`]) {
      const f = fixture();
      prepare(f);
      f.files.set('report.md', `\uFEFF${report}`);
      await f.run([...argv, '--report-file', 'report.md']);
      assert.deepEqual(comments(f), [['rest', 'POST', `/issues/${number}/comments`, { body: report }]], kind);
      assert.ok(f.calls.some(c => c[0] === 'status' && c[2] === 'done'), kind);
      assert.deepEqual(f.calls.at(-1), comments(f)[0], kind);
    }
  }
});
test('a repository overrides the report template in its config or with a template file', async () => {
  const f = fixture();
  f.cli.config = { ...config, reports: { ...config.reports, scope: { template: '.github/shapeup/scope-report.md', sections: ['Outcome', 'Verification'] } } };
  f.files.set('default.md', reports.scope);
  await assert.rejects(f.run(['scope', 'done', '11', '--report-file', 'default.md']), { code: 'input', message: /^The report has no "## Verification" section/ });
  f.files.set('verified.md', '## Outcome\n\nMerged.\n\n## Verification\n\nThe smoke suite passed.\n');
  await f.run(['scope', 'done', '11', '--report-file', 'verified.md']);
  assert.deepEqual(comments(f).map(c => c[3].body), [f.files.get('verified.md')]);

  const g = fixture();
  finishes[0][2](g);
  g.templates.set('.github/shapeup/pitch-report.md', '<!-- Fill in every section. -->\n\n## Outcome\n\n<!-- What shipped. -->\n\n## Scopes\n\n## Risks\n\n## Accepted limits\n\n## Follow-ups\n');
  g.files.set('default.md', reports.pitch);
  await assert.rejects(g.run(['pitch', 'done', '10', '--report-file', 'default.md']), { code: 'input', message: /^The report has no "## Risks" section/ });
  g.files.set('risks.md', reports.pitch.replace('## Accepted limits', '## Risks\n\nThe provider may be slow.\n\n## Accepted limits'));
  await g.run(['pitch', 'done', '10', '--report-file', 'risks.md']);
  assert.deepEqual(comments(g).map(c => c[3].body), [g.files.get('risks.md')]);

  const h = fixture();
  h.templates.set('.github/shapeup/scope-report.md', '## Outcome\n\n## Follow-ups\n');
  h.files.set('report.md', reports.scope);
  await assert.rejects(h.run(['scope', 'done', '11', '--report-file', 'report.md']),
    { code: 'template', message: 'The report template .github/shapeup/scope-report.md has no "## Evidence" section.' });
  assert.deepEqual(h.calls, []);
});
// main runs no GitHub call here: each run stops at the report check, before the first one.
test('main reads report templates under the repository root, never from the issue templates, and stops on an unreadable one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shapeup-'));
  const github = join(root, '.github');
  await mkdir(join(github, 'shapeup'), { recursive: true });
  await mkdir(join(github, 'ISSUE_TEMPLATE'));
  await mkdir(join(root, 'sub'));
  await writeFile(join(github, 'shapeup.json'), JSON.stringify({ projectOwner: 'octocat', projectOwnerType: 'user', projectNumber: 1 }));
  await writeFile(join(github, 'ISSUE_TEMPLATE', 'scope-report.md'), '## Outcome\n\n## Decoy\n');
  const report = join(root, 'report.md');
  await writeFile(report, '## Outcome\n\nMerged.\n');
  const run = () => main(['scope', 'done', '11', '--report-file', report], { GH_TOKEN: 'unused', SHAPEUP_REPOSITORY: 'o/r' }, join(root, 'sub'));
  await assert.rejects(run(), { code: 'input', message: 'The report has no "## Evidence" section. It needs ## Outcome, ## Evidence, ## Follow-ups.' });
  const template = '## Outcome\n\n## Risks\n\n## Evidence\n\n## Follow-ups\n';
  await writeFile(join(github, 'shapeup', 'scope-report.md'), template);
  assert.equal(await reportTemplateReader(root)('.github/shapeup/scope-report.md'), template);
  await assert.rejects(run(), { code: 'input', message: 'The report has no "## Risks" section. It needs ## Outcome, ## Risks, ## Evidence, ## Follow-ups.' });
  await rm(join(github, 'shapeup', 'scope-report.md'));
  await mkdir(join(github, 'shapeup', 'scope-report.md'));
  await assert.rejects(run(), { code: 'template', message: 'Cannot read the report template .github/shapeup/scope-report.md.' });
});
test('report templates are read from their own path next to the config, never from the issue templates', async () => {
  for (const [[argv, , prepare], path] of [[finishes[0], '.github/shapeup/pitch-report.md'], [finishes[1], '.github/shapeup/scope-report.md']]) {
    const f = fixture();
    prepare(f);
    f.files.set('report.md', reports[argv[0]]);
    await f.run([...argv, '--report-file', 'report.md']);
    assert.deepEqual(f.reads, [['report', path]]);
  }
  const f = fixture();
  f.cli.config = { ...config, reports: { ...config.reports, scope: { ...config.reports.scope, template: 'docs/scope-report.md' } } };
  f.templates.set('docs/scope-report.md', '## Outcome\n\n## Evidence\n\n## Risks\n\n## Follow-ups\n');
  f.files.set('report.md', reports.scope);
  await assert.rejects(f.run(['scope', 'done', '11', '--report-file', 'report.md']), { code: 'input', message: /^The report has no "## Risks" section/ });
  assert.deepEqual(f.reads, [['report', 'docs/scope-report.md']]);
});
test('an edit that names nothing to change is refused before any call', async () => {
  for (const [kind, number] of [['pitch', '10'], ['scope', '11'], ['cooldown', '20'], ['bug', '21']]) {
    const f = fixture();
    f.files.set('other.md', '## Unrelated\n\nText.\n');
    await assert.rejects(f.run([kind, 'edit', number, '--reason', 'x']), { code: 'input', message: new RegExp(`^${kind} edit changes nothing: give at least one of --title, --from, --footnote, `) });
    await assert.rejects(f.run([kind, 'edit', number, '--from', 'other.md', '--reason', 'x']), { code: 'input', message: /changes nothing/ });
    assert.deepEqual(f.calls, [], kind);
    assert.deepEqual(f.reads, [], kind);
  }
  const f = fixture();
  await assert.rejects(f.run(['pitch', 'edit', '10', '--reason', 'x']), {
    message: 'pitch edit changes nothing: give at least one of --title, --from, --footnote, --problem, --solution, --rabbit-holes, --no-gos, --appetite.' });
});
test('every command refuses an option it does not read, before any call', async () => {
  const commands = [
    ['pitch', 'new', '--title', 'T', '--appetite', '1', '--problem', 'p', '--solution', 's', '--rabbit-holes', 'r', '--no-gos', 'n'],
    ['scope', 'new', '--pitch', '10', '--title', 'T', '--done', 'd'],
    ['cooldown', 'new', '--title', 'T', '--what', 'w', '--done', 'd'],
    ['bug', 'new', '--title', 'T', '--symptom', 's', '--steps', '1', '--expected', 'e'],
    ...changes.map(([argv]) => [...argv, '--reason', 'x']),
    ...finishes.map(([argv]) => [...argv, '--report-file', 'report.md']),
    ['audit', '--pitch', '10'],
    ['init', '--force'],
  ];
  for (const argv of commands) {
    const f = fixture();
    f.files.set('report.md', reports[argv[0]] ?? '');
    await assert.rejects(f.run([...argv, '--bogus', 'x']), { code: 'input', message: /does not take --bogus\. It takes --/ }, argv.join(' '));
    assert.deepEqual(f.calls, [], argv.join(' '));
  }
  const f = fixture();
  f.issues.get(10).item.status = s.shaped;
  f.files.set('report.md', reports.scope);
  await assert.rejects(f.run(['pitch', 'edit', '10', '--apetite', '2', '--reason', 'Smaller.']), { code: 'input',
    message: 'pitch edit does not take --apetite. It takes --title, --from, --footnote, --problem, --solution, --rabbit-holes, --no-gos, --appetite, --reason, --reason-file.' });
  await assert.rejects(f.run(['scope', 'edit', '11', '--done', 'x', '--appetite', '2', '--reason', 'x']), { message: /^scope edit does not take --appetite\./ });
  await assert.rejects(f.run(['scope', 'start', '11', '--reason', 'x', '--report-file', 'report.md']), { message: /^scope start does not take --report-file\./ });
  await assert.rejects(f.run(['scope', 'hill', '11', '--position', '5', '--reason', 'x', '--footnote', 'a=b']), { message: /^scope hill does not take --footnote\./ });
  await assert.rejects(f.run(['audit', '--pich', '10']), { message: 'audit does not take --pich. It takes --pitch.' });
  assert.deepEqual(f.calls, []);
});
const scopeReport = f => { f.files.set('report.md', reports.scope); return ['--report-file', 'report.md']; };
const pitchReport = f => { f.files.set('report.md', reports.pitch); return ['--report-file', 'report.md']; };
const closeScopes = f => { for (const n of [11, 12]) Object.assign(f.issues.get(n), { state: 'closed', stateReason: 'completed' }); };
const hint = 'Work that follows a finished scope is a new scope: gh shapeup scope new --pitch 10 --title … --done ….';
test('a state command whose result already holds, or that would reopen a finished scope, refuses before any change and without a comment', async () => {
  const closed = (n, reason, status) => f => Object.assign(f.issues.get(n), { state: 'closed', stateReason: reason }, status ? { item: { ...f.issues.get(n).item, status } } : {});
  const status = (n, value, more = {}) => f => Object.assign(f.issues.get(n).item, { status: value, ...more });
  for (const [prepare, argv, message] of [
    [closed(11, 'completed', s.done), f => ['scope', 'done', '11', ...scopeReport(f)], '#11 is already done: closed as completed and Done.'],
    [closed(11, 'not_planned', s.dropped), f => ['scope', 'done', '11', ...scopeReport(f)], `#11 was dropped (closed as not planned); a dropped scope is not done. ${hint}`],
    [status(11, s.dropped), f => ['scope', 'done', '11', ...scopeReport(f)], `#11 was dropped (Dropped); a dropped scope is not done. ${hint}`],
    [() => {}, () => ['scope', 'start', '12', '--reason', 'x'], '#12 is already In progress.'],
    [closed(11, 'completed', s.done), () => ['scope', 'start', '11', '--reason', 'x'], `#11 is finished (closed as completed) and is not started again. ${hint}`],
    [status(11, s.done), () => ['scope', 'start', '11', '--reason', 'x'], `#11 is finished (Done) and is not started again. ${hint}`],
    [status(11, s.dropped), () => ['scope', 'start', '11', '--reason', 'x'], `#11 is finished (Dropped) and is not started again. ${hint}`],
    [closed(11, 'not_planned'), () => ['scope', 'start', '11', '--reason', 'x'], `#11 is finished (closed as not planned) and is not started again. ${hint}`],
    [() => {}, () => ['scope', 'hill', '11', '--position', '30', '--reason', 'x'], '#11 is already at 30 on the hill.'],
    [() => {}, () => ['scope', 'hill', '12', '--position', '0', '--reason', 'x'], '#12 is already at 0 on the hill.'],
    [closed(11, 'completed', s.done), () => ['scope', 'hill', '11', '--position', '100', '--reason', 'x'], `#11 is finished (closed as completed), so its hill position stays. ${hint}`],
    [f => { closed(10, 'completed', s.done)(f); closeScopes(f); }, f => ['pitch', 'done', '10', ...pitchReport(f)], '#10 is already done: closed as completed and Done.'],
    [closed(10, 'not_planned', s.dropped), f => ['pitch', 'done', '10', ...pitchReport(f)], '#10 was dropped (closed as not planned); a dropped pitch is not done.'],
    [f => { for (const n of [10, 11, 12]) status(n, s.shaped, { cycle: null })(f); }, () => ['pitch', 'unbet', '10', '--reason', 'x'], '#10 and its scopes are already Shaped with no Cycle.'],
    [closed(10, 'completed', s.done), () => ['pitch', 'unbet', '10', '--reason', 'x'], '#10 is finished (closed as completed); a finished pitch is not unbet.'],
    [() => {}, () => ['pitch', 'bet', '10', '--cycle', 'Cycle 2', '--reason', 'x'], '#10 is already bet on Cycle 2.'],
    [status(10, s.dropped), () => ['pitch', 'bet', '10', '--cycle', 'Cycle 2', '--reason', 'x'], '#10 is finished (Dropped); a finished pitch is not bet again.'],
    [status(10, s.done), () => ['pitch', 'break', '10', '--reason', 'x'], '#10 is done (Done); the circuit breaker stops only a pitch that is not finished.'],
    [f => { closed(10, 'not_planned', s.dropped)(f); closed(11, 'not_planned', s.dropped)(f); closed(12, 'not_planned', s.dropped)(f); },
      () => ['pitch', 'break', '10', '--reason', 'x'], '#10 is already closed by the circuit breaker.'],
    [status(10, s.shaped), () => ['pitch', 'edit', '10', '--appetite', '1', '--reason', 'x'], '#10 already has Appetite 1 cycle.'],
    [closed(10, 'completed', s.done), () => ['scope', 'new', '--pitch', '10', '--title', 'T', '--done', 'd'], '#10 is finished (closed as completed); a new scope needs a pitch that is not finished.'],
  ]) {
    const f = fixture();
    prepare(f);
    const args = argv(f);
    await assert.rejects(f.run(args), { code: 'input', message }, args.join(' '));
    assert.deepEqual(f.calls.filter(c => c[0] !== 'load'), [], args.join(' '));
  }
});
test('a finished scope keeps its state when its pitch is bet, unbet or broken, and only unfinished scopes follow', async () => {
  const f = fixture();
  finishedScope(f);
  await f.run(['pitch', 'break', '10', '--reason', 'Out of time.']);
  assert.ok(!f.calls.some(c => c[1] === 'I13' || c[2] === '/issues/13'));
  assert.deepEqual(f.issues.get(13).item.status, s.done);
  // A scope closed as not planned whose status was left behind is set to Dropped with the rest.
  const g = fixture();
  finishedScope(g, { stateReason: 'not_planned', item: { id: 'I13', status: s.doing, cycle: null, hill: 10 } });
  await g.run(['pitch', 'break', '10', '--reason', 'Out of time.']);
  assert.deepEqual(g.calls.filter(c => c[1] === 'I13'), [['status', 'I13', 'dropped']]);
});
const partial = (command, made, failed, rest, finish) => [
  `${command} stopped after ${made.length} of ${made.length + 1 + rest.length} changes. Nothing was rolled back${finish === 'new' ? '' : `, and the ${finish} was not posted`}.`,
  'Made:', ...made.map(line => `- ${line}`), 'Failed:', `- ${failed}`, ...(rest.length ? ['Not attempted:', ...rest.map(line => `- ${line}`)] : []),
  finish === 'new' ? 'To finish, make the failed and remaining changes by hand. Running the command again would create another issue.'
    : `To finish, run the same command again: it makes only the changes still missing and then posts the ${finish}. Or make them by hand and post the ${finish} yourself.`,
].join('\n');
const graphqlFailed = 'A GitHub Project GraphQL request failed.';
const apiFailed = 'GitHub API request failed (HTTP 500).';
test('a command that fails after its first change reports what was made and what is left, posts nothing, and a second run finishes it', async () => {
  for (const [name, prepare, fail, argv, message, finished] of [
    ['pitch bet', f => { for (const n of [10, 11, 12]) f.issues.get(n).item.cycle = null; f.issues.get(10).item.status = s.shaped; f.issues.get(11).item.status = s.shaped; },
      'cycle I11', () => ['pitch', 'bet', '10', '--cycle', 'Cycle 2', '--reason', 'Bet.'],
      partial('pitch bet #10', ['set Cycle of #10 to Cycle 2', 'set Status of #10 to Bet'], `set Cycle of #11 to Cycle 2: ${graphqlFailed}`,
        ['set Status of #11 to Bet', 'set Cycle of #12 to Cycle 2'], 'reason'),
      f => [11, 12].every(n => f.issues.get(n).item.cycle?.id === 'c2') && f.issues.get(11).item.status === s.bet],
    ['pitch unbet', () => {}, 'clear I11', () => ['pitch', 'unbet', '10', '--reason', 'Not now.'],
      partial('pitch unbet #10', ['set Status of #10 to Shaped', 'clear Cycle of #10', 'set Status of #11 to Shaped'], `clear Cycle of #11: ${graphqlFailed}`,
        ['set Status of #12 to Shaped', 'clear Cycle of #12'], 'reason'),
      f => [10, 11, 12].every(n => f.issues.get(n).item.status === s.shaped && !f.issues.get(n).item.cycle)],
    ['pitch break', () => {}, 'PATCH /issues/12', () => ['pitch', 'break', '10', '--reason', 'Out of time.'],
      partial('pitch break #10', ['close #11 as not planned', 'set Status of #11 to Dropped'], `close #12 as not planned: ${apiFailed}`,
        ['set Status of #12 to Dropped', 'close #10 as not planned', 'set Status of #10 to Dropped'], 'reason'),
      f => [10, 11, 12].every(n => f.issues.get(n).state === 'closed' && f.issues.get(n).item.status === s.dropped)],
    ['pitch done', closeScopes, 'status I10', f => ['pitch', 'done', '10', ...pitchReport(f)],
      partial('pitch done #10', ['close #10 as completed'], `set Status of #10 to Done: ${graphqlFailed}`, [], 'report'),
      f => f.issues.get(10).state === 'closed' && f.issues.get(10).item.status === s.done],
    ['scope done', () => {}, 'status I11', f => ['scope', 'done', '11', ...scopeReport(f)],
      partial('scope done #11', ['close #11 as completed'], `set Status of #11 to Done: ${graphqlFailed}`, [], 'report'),
      f => f.issues.get(11).state === 'closed' && f.issues.get(11).item.status === s.done],
    ['pitch edit --appetite', f => { f.issues.get(10).item.status = s.shaped; }, 'appetite I10', () => ['pitch', 'edit', '10', '--title', 'Smaller', '--appetite', '2', '--reason', 'Smaller.'],
      partial('pitch edit #10', ['edit the title and body of #10'], `set Appetite of #10 to 2 cycles: ${graphqlFailed}`, [], 'reason'),
      f => f.issues.get(10).item.appetite === '2 cycles'],
  ]) {
    const f = fixture();
    prepare(f);
    f.failing.add(fail);
    await assert.rejects(f.run(argv(f)), { code: 'partial', message }, name);
    assert.deepEqual(comments(f), [], name);
    f.failing.delete(fail);
    await f.run(argv(f));
    assert.equal(comments(f).length, 1, name);
    assert.ok(finished(f), name);
    // A state command then refuses, since its result holds; an edit of the body is not a state and runs again.
    if (!name.startsWith('pitch edit')) await assert.rejects(f.run(argv(f)), { code: 'input' }, `${name} a third time`);
  }
});
test('pitch new and scope new that fail after creating the issue say what is left to do by hand', async () => {
  const f = fixture();
  f.failing.add('add N30');
  await assert.rejects(f.run(['pitch', 'new', '--title', 'T', '--appetite', '2', '--problem', 'p', '--solution', 's', '--rabbit-holes', 'r', '--no-gos', 'n']),
    { code: 'partial', message: partial('pitch new', ['create #30 https://x/30'], `add #30 to the project: ${graphqlFailed}`,
      ['set Status of #30 to Shaped', 'set Appetite of #30 to 2 cycles'], 'new') });
  const g = fixture();
  g.failing.add('POST /issues/10/sub_issues');
  await assert.rejects(g.run(['scope', 'new', '--pitch', '10', '--title', 'T', '--done', 'd']),
    { code: 'partial', message: partial('scope new', ['create #30 https://x/30'], `link #30 as a sub-issue of #10: ${apiFailed}`,
      ['add #30 to the project', 'set Status of #30 to Bet', 'set Cycle of #30 to Cycle 2', 'set Hill Position of #30 to 0'], 'new') });
  // When the very first change fails, the command reports that failure alone.
  const h = fixture();
  h.failing.add('POST /issues');
  await assert.rejects(h.run(['cooldown', 'new', '--title', 'T', '--what', 'w', '--done', 'd']), { code: 'api', message: apiFailed });
});
test('pitch edit refuses an appetite change before it edits anything', async () => {
  const f = fixture();
  const argv = appetite => ['pitch', 'edit', '10', '--title', 'Renamed', '--appetite', appetite, '--reason', 'Smaller.'];
  const made = () => f.calls.filter(c => c[0] !== 'load');
  await assert.rejects(f.run(argv('2')), { code: 'input', message: 'Appetite changes only on a pitch that is Shaped.' });
  f.issues.get(10).item.status = s.shaped;
  await assert.rejects(f.run(argv('3')), { code: 'input', message: '--appetite must be one of: 1, 2.' });
  f.cli.config = { ...config, appetites: { ...config.appetites, 3: '3 cycles' } };
  await assert.rejects(f.run(argv('3')), { code: 'field' });
  assert.deepEqual(made(), []);
  f.cli.config = config;
  await f.run(argv('2'));
  assert.deepEqual(made().map(c => c.slice(0, 3)), [['rest', 'PATCH', '/issues/10'], ['appetite', 'I10', '2'], ['rest', 'POST', '/issues/10/comments']]);
});
test('a board without the status option refuses before anything closes', async () => {
  for (const [argv, key, prepare] of [
    [['pitch', 'break', '10', '--reason', 'Out of time.'], 'dropped', () => {}],
    [['pitch', 'done', '10', '--report-file', 'pitch.md'], 'done', finishes[0][2]],
    [['scope', 'done', '11', '--report-file', 'scope.md'], 'done', () => {}],
  ]) {
    const f = fixture();
    prepare(f);
    f.files.set('pitch.md', reports.pitch);
    f.files.set('scope.md', reports.scope);
    f.cli.config = { ...config, statuses: { ...s, [key]: 'Gone' } };
    await assert.rejects(f.run(argv), { code: 'field' }, argv.slice(0, 2).join(' '));
    assert.deepEqual(f.calls.filter(c => c[0] !== 'load'), [], argv.slice(0, 2).join(' '));
  }
});
test('a change that fails posts no comment', async () => {
  const f = fixture();
  f.files.set('report.md', reports.pitch);
  await assert.rejects(f.run(['pitch', 'bet', '10', '--cycle', 'Cycle 9', '--reason', 'x']), /bad cycle/);
  await assert.rejects(f.run(['pitch', 'done', '10', '--report-file', 'report.md']), /#11, #12/);
  await assert.rejects(f.run(['scope', 'hill', '11', '--position', '101', '--reason', 'x']), { code: 'position' });
  await assert.rejects(f.run(['scope', 'edit', '10', '--done', 'x', '--reason', 'x']), { code: 'type' });
  f.failing.add('PATCH /issues/20');
  await assert.rejects(f.run(['cooldown', 'edit', '20', '--what', 'w', '--reason', 'x']), { code: 'api' });
  f.board.setStatus = async () => { throw new ShapeUpError('graphql', 'A GitHub Project GraphQL request failed.'); };
  await assert.rejects(f.run(['scope', 'start', '11', '--reason', 'x']), { code: 'graphql' });
  assert.deepEqual(comments(f), []);
});
test('a comment that fails after the change says so', async () => {
  const f = fixture();
  f.failing.add('POST /issues/11/comments');
  await assert.rejects(f.run(['scope', 'start', '11', '--reason', 'Started.']), {
    code: 'comment', message: /^#11 was changed, but its reason comment failed: GitHub API request failed \(HTTP 500\)\. Post the reason on #11 by hand\.$/ });
  assert.deepEqual(f.calls.filter(c => c[0] === 'status'), [['status', 'I11', 'doing']]);
  assert.deepEqual(f.out, []);
  f.failing.add('POST /issues/11/comments');
  f.files.set('report.md', reports.scope);
  await assert.rejects(f.run(['scope', 'done', '11', '--report-file', 'report.md']), {
    code: 'comment', message: /^#11 was changed, but its report comment failed: .* Post the report on #11 by hand\.$/ });
  assert.deepEqual(f.calls.filter(c => c[0] === 'status').at(-1), ['status', 'I11', 'done']);
});

const issue = (number, labels, item, extra = {}) => ({ number, labels, state: 'open', stateReason: null, parent: null, body: '', item, ...extra });
test('audit finds drift between issues, the board and the hill chart', () => {
  const item = extra => ({ status: s.bet, appetite: '1 cycle', cycle, hill: null, ...extra });
  const findings = audit([
    issue(1, ['pitch'], item(), { body: '<!-- hill:start -->\n![](x)\n<!-- hill:values 2=0 3=40 -->\n<!-- hill:end -->' }),
    issue(2, ['scope'], item(), { parent: 1 }),
    issue(3, ['scope'], item({ hill: 45 }), { parent: 1 }),
    issue(4, ['scope'], item()),
    issue(5, ['pitch'], null),
    issue(6, ['pitch'], item({ appetite: null, status: null })),
    issue(7, ['scope'], item({ status: s.bet }), { parent: 1, state: 'closed', stateReason: 'completed' }),
    issue(8, ['scope'], item({ cycle: null }), { parent: 1 }),
    issue(9, ['scope'], item({ status: s.done }), { parent: 1 }),
  ], config);
  assert.deepEqual(findings.map(f => `${f.number} ${f.rule}`), [
    '3 is drawn at 40 but the board has 45',
    '4 has no parent pitch',
    '5 is not on the board',
    '6 has no status',
    '6 has no appetite',
    '7 was closed as completed but its status is Bet',
    '7 is drawn at nothing but the board has 0',
    '8 is Bet but has no cycle',
    '8 is in a different cycle from its pitch (none / Cycle 2)',
    '8 is drawn at nothing but the board has 0',
    '9 is open but its status is Done',
    '9 is drawn at nothing but the board has 0',
  ]);
});
