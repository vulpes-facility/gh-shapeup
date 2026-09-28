import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cli, credentials, findRoot, parseArgs } from '../src/cli.mjs';
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
      if (path === '/issues' && options.method === 'POST') { const number = next++; return { number, id: number * 10, node_id: `N${number}`, html_url: `https://x/${number}` }; }
      return {};
    },
    async children(number) { return [...issues.values()].filter(i => i.parent === number).map(i => ({ number: i.number, labels: i.labels.map(name => ({ name })) })); },
  };
  const board = {
    async load() { calls.push(['load']); },
    async issue(number) { const issue = issues.get(number); if (!issue) throw new Error(`no ${number}`); return structuredClone(issue); },
    async add(node) { calls.push(['add', node]); return `item-${node}`; },
    async setStatus(item, key) { calls.push(['status', item, key]); },
    async setAppetite(item, value) { calls.push(['appetite', item, value]); },
    async setCycle(item, id) { calls.push(['cycle', item, id]); },
    async setHill(item, value) { calls.push(['hill', item, value]); },
    async clear(item, field) { calls.push(['clear', item, field]); },
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
test('pitch bet and unbet move the pitch and its open scopes together', async () => {
  const f = fixture();
  f.issues.get(10).item.status = s.shaped;
  f.issues.get(11).item.status = s.shaped;
  await f.run(['pitch', 'bet', '10', '--cycle', 'Cycle 2', '--reason', 'Bet at the table.']);
  assert.deepEqual(f.calls.filter(c => ['status', 'cycle'].includes(c[0])),
    [['status', 'I10', 'bet'], ['cycle', 'I10', 'c2'], ['cycle', 'I11', 'c2'], ['status', 'I11', 'bet'], ['cycle', 'I12', 'c2']]);
  const g = fixture();
  await g.run(['pitch', 'unbet', '10', '--reason', 'Not this cycle.']);
  assert.deepEqual(g.calls.filter(c => c[0] === 'clear').map(c => c[1]), ['I10', 'I11', 'I12']);
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
  [['pitch', 'bet', '10', '--cycle', 'Cycle 2'], 10],
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
