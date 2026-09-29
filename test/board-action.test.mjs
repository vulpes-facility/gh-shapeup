import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotation, cliArgs, commands, main, markdownReader, readInputs, runBoard } from '../src/board-action.mjs';
import { ShapeUpError } from '../src/domain.mjs';
import { config, fixture, reports } from './cli-fixture.mjs';

const s = config.statuses;
const tokens = { 'project-token': 'project-secret', 'github-token': 'github-secret' };
const read = values => readInputs(name => ({ ...tokens, ...values })[name] ?? '');
const names = ['number', 'pitch', 'title', 'body', 'position', 'reason', 'report'];

// Every input each command takes, with values the fixture accepts.
const valid = {
  'scope new': { pitch: '10', title: 'Autosave', body: '## Done means\n\nSaving a setting writes it at once.\n' },
  'scope edit': { number: '11', title: 'Renamed', body: '## Done means\n\nMerged.\n', reason: 'Clearer.' },
  'scope start': { number: '11', reason: 'Started.' },
  'scope hill': { number: '11', position: '45', reason: '  The approach is settled.\r\n\r\n- data model\n' },
  'scope done': { number: '11', report: reports.scope },
  'pitch done': { number: '10', report: reports.pitch },
  'bug new': { title: 'It freezes', body: '## Symptom\n\nFrozen.\n\n## Steps\n\n1. Press it\n\n## Expected\n\nIt moves.\n' },
};
const input = (command, extra = {}) => ({ command, ...valid[command], ...extra });

test('the board Action takes only the commands a cycle runs from a workflow', () => {
  assert.deepEqual(Object.keys(commands), Object.keys(valid));
  for (const command of Object.keys(valid)) {
    const { inputs } = read(input(command));
    assert.deepEqual([inputs.kind, inputs.action], command.split(' '), command);
  }
  for (const command of ['pitch new', 'pitch edit', 'pitch bet', 'pitch unbet', 'pitch break', 'cooldown new', 'cooldown edit',
    'scope drop', 'bug edit', 'audit', 'init', 'scope  hill', 'Scope hill', 'scope hill; exit 1', '']) {
    assert.throws(() => read({ command, number: '11' }), { code: 'input',
      message: 'command must be one of: scope new, scope edit, scope start, scope hill, scope done, pitch done, bug new.' }, command);
  }
  assert.equal(read(input('scope start', { command: ' scope start\n' })).inputs.command, 'scope start');
});

test('each command refuses an input it needs that is missing or blank, and any input it does not take', () => {
  for (const [command, spec] of Object.entries(commands)) {
    const takes = [...spec.needs, ...(spec.takes ?? [])];
    for (const name of spec.needs) {
      for (const blank of ['', ' \n\t ']) {
        assert.throws(() => read(input(command, { [name]: blank })), { code: 'input', message: `${command} needs the ${name} input.` }, `${command} ${name}`);
      }
    }
    for (const name of names.filter(name => !takes.includes(name))) {
      assert.throws(() => read(input(command, { [name]: '1' })), { code: 'input',
        message: `${command} does not take the ${name} input. It takes ${takes.join(', ')}.` }, `${command} ${name}`);
    }
  }
  assert.throws(() => read(input('scope edit', { title: '', body: '' })), { code: 'input', message: 'scope edit needs at least one of title, body.' });
  assert.deepEqual(Object.keys(read(input('scope edit', { title: '' })).inputs), ['command', 'kind', 'action', 'number', 'body', 'reason']);
});

test('numbers, positions, titles and texts are checked, and no message repeats what an input holds', () => {
  const secret = 'SECRET';
  const refused = [
    ...['0', '-1', '1.5', '1e3', '0x10', '012', '2147483648', '11 12', `11${secret}`].map(value =>
      [input('scope start', { number: value }), 'input', 'number must be an issue number from 1 to 2147483647.']),
    [input('scope new', { pitch: '99999999999' }), 'input', 'pitch must be an issue number from 1 to 2147483647.'],
    ...['101', '-1', '4.5', '1000', secret].map(value => [input('scope hill', { position: value }), 'position', 'Hill Position must be an integer from 0 to 100.']),
    [input('bug new', { title: `It ${secret}\nfreezes` }), 'input', 'title must be one line.'],
    [input('bug new', { title: 'x'.repeat(257) }), 'input', 'title is longer than 256 characters.'],
    [input('bug new', { title: `It\u0007${secret}` }), 'input', 'title holds a control character other than tab and newline.'],
    [input('scope start', { reason: 'x'.repeat(4001) }), 'input', 'reason is longer than 4,000 characters.'],
    [input('scope start', { reason: `Started.\u0000${secret}` }), 'input', 'reason holds a control character other than tab and newline.'],
    [input('scope start', { reason: `Started.\u001b[31m${secret}` }), 'input', 'reason holds a control character other than tab and newline.'],
    [input('bug new', { body: 'x'.repeat(65_537) }), 'input', 'body is longer than 65,536 characters.'],
    [input('scope done', { report: 'x'.repeat(65_537) }), 'input', 'report is longer than 65,536 characters.'],
    [input('scope done', { report: `${reports.scope}\u007f` }), 'input', 'report holds a control character other than tab and newline.'],
  ];
  for (const [values, code, message] of refused) assert.throws(() => read(values), { code, message }, JSON.stringify(values).slice(0, 80));
  const accepted = read(input('scope hill', { number: ' 2147483647 ', position: '100', reason: `${'😀'.repeat(3999)}\t` })).inputs;
  assert.deepEqual([accepted.number, accepted.position], [2147483647, 100]);
  assert.equal(read(input('scope hill', { position: '0' })).inputs.position, 0);
  assert.equal(read(input('bug new', { title: `  ${'x'.repeat(256)}  ` })).inputs.title, 'x'.repeat(256));
  // Markdown is passed on as given, with its line endings and surrounding space.
  assert.equal(read(input('scope hill')).inputs.reason, valid['scope hill'].reason);
});

test('github-token is always needed, and project-token for every command but bug new', () => {
  for (const command of Object.keys(valid)) {
    assert.throws(() => read(input(command, { 'github-token': ' ' })), { code: 'input', message: 'The github-token input is empty.' }, command);
  }
  for (const command of Object.keys(valid).filter(command => command !== 'bug new')) {
    assert.throws(() => read(input(command, { 'project-token': '' })), { code: 'input',
      message: `The project-token input is empty, and ${command} changes the project.` }, command);
  }
  assert.deepEqual(read(input('bug new', { 'project-token': '' })).tokens, { project: '', github: 'github-secret' });
  assert.deepEqual(read(input('scope start', { 'project-token': ' project-secret\n' })).tokens, { project: 'project-secret', github: 'github-secret' });
});

test('inputs become the arguments the CLI would parse, and the Markdown is read where the CLI reads a file', async () => {
  const args = command => cliArgs(read(input(command)).inputs);
  assert.deepEqual(args('scope new'), { kind: 'scope', action: 'new', number: null, options: { pitch: '10', title: 'Autosave', from: 'body' }, footnotes: [] });
  assert.deepEqual(args('scope edit').options, { title: 'Renamed', from: 'body', 'reason-file': 'reason' });
  assert.deepEqual(args('scope hill'), { kind: 'scope', action: 'hill', number: 11, options: { position: '45', 'reason-file': 'reason' }, footnotes: [] });
  assert.deepEqual(args('pitch done').options, { 'report-file': 'report' });
  const { inputs } = read(input('scope hill'));
  const readText = markdownReader(inputs);
  assert.equal(await readText('reason'), valid['scope hill'].reason);
  for (const name of ['body', 'report', 'title', '../etc/passwd']) await assert.rejects(readText(name), { code: 'input' }, name);
});

// Runs the Action's command on the CLI fixture, with a hill chart that records what it is asked to align.
function board(values, prepare = () => {}) {
  const f = fixture();
  prepare(f);
  const { inputs } = read(values);
  const log = [];
  const redraws = [];
  const hill = { async redraw(number, type) { redraws.push([number, type]); return `drawn #${type === 'pitch' ? number : 10}`; } };
  f.cli.readText = markdownReader(inputs);
  f.cli.out = line => log.push(line);
  return { f, log, redraws, hill, run: () => runBoard(inputs, { cli: f.cli, hill, log: line => log.push(line) }) };
}
const comments = f => f.calls.filter(c => c[0] === 'rest' && c[2].endsWith('/comments')).map(c => [c[2], c[3].body]);
const closeScopes = f => { for (const n of [11, 12]) Object.assign(f.issues.get(n), { state: 'closed', stateReason: 'completed' }); };

test('each command runs through the CLI, posts its Markdown as given, and aligns the chart it changes', async () => {
  for (const [command, number, redraws, check, prepare] of [
    ['scope new', 30, [[10, 'pitch']], f => {
      const create = f.calls.find(c => c[2] === '/issues');
      assert.equal(create[3].title, 'Scope: Autosave');
      assert.match(create[3].body, /## Done means\n\nSaving a setting writes it at once\./);
      assert.ok(f.calls.some(c => c[2] === '/issues/10/sub_issues'));
      assert.deepEqual(f.calls.filter(c => c[0] === 'hill'), [['hill', 'item-N30', 0]]);
    }],
    ['scope edit', 11, [], f => {
      const patch = f.calls.find(c => c[1] === 'PATCH' && c[2] === '/issues/11')[3];
      assert.equal(patch.title, 'Scope: Renamed');
      assert.match(patch.body, /## Done means\n\nMerged\./);
      assert.deepEqual(comments(f), [['/issues/11/comments', 'Clearer.']]);
    }],
    ['scope start', 11, [], f => {
      assert.deepEqual(f.calls.filter(c => c[0] === 'status'), [['status', 'I11', 'doing'], ['status', 'I10', 'doing']]);
      assert.deepEqual(comments(f), [['/issues/11/comments', 'Started.']]);
    }],
    ['scope hill', 11, [[11, 'scope']], f => {
      assert.deepEqual(f.calls.filter(c => c[0] !== 'load').map(c => c.slice(0, 3)), [['hill', 'I11', 45], ['rest', 'POST', '/issues/11/comments']]);
      assert.deepEqual(comments(f), [['/issues/11/comments', valid['scope hill'].reason]]);
    }],
    ['scope done', 11, [[11, 'scope']], f => {
      assert.equal(f.issues.get(11).state, 'closed');
      assert.equal(f.issues.get(11).item.status, s.done);
      assert.deepEqual(comments(f), [['/issues/11/comments', reports.scope]]);
    }],
    ['pitch done', 10, [], f => {
      assert.equal(f.issues.get(10).item.status, s.done);
      assert.deepEqual(comments(f), [['/issues/10/comments', reports.pitch]]);
    }, closeScopes],
    ['bug new', 30, [], f => {
      const create = f.calls.find(c => c[2] === '/issues');
      assert.equal(create[3].title, 'Bug: It freezes');
      assert.match(create[3].body, /## Steps\n\n1\. Press it/);
      assert.deepEqual(create[3].labels, ['bug']);
      assert.ok(!f.calls.some(c => ['load', 'add', 'status'].includes(c[0])));
    }],
  ]) {
    const b = board(input(command), prepare);
    assert.deepEqual(await b.run(), { result: 'changed', number }, command);
    assert.deepEqual(b.redraws, redraws, command);
    check(b.f);
  }
});

test('a result that already holds is a notice: nothing changes, nothing is posted, and the chart is still aligned', async () => {
  for (const [values, redraws, message, prepare] of [
    [input('scope start', { number: '12' }), [], '#12 is already In progress. Nothing changed, and the reason was not posted.',
      f => { f.issues.get(10).item.status = s.doing; }],
    [input('scope hill', { position: '30' }), [[11, 'scope']], '#11 is already at 30 on the hill. Nothing changed, and the reason was not posted.'],
    [input('scope done'), [[11, 'scope']], '#11 is already done: closed as completed and Done. Nothing changed, and the report was not posted.',
      f => { Object.assign(f.issues.get(11), { state: 'closed', stateReason: 'completed' }); f.issues.get(11).item.status = s.done; }],
  ]) {
    const b = board(values, prepare);
    assert.deepEqual(await b.run(), { result: 'unchanged', number: values.number === '12' ? 12 : 11 }, values.command);
    assert.deepEqual(b.f.calls.filter(c => c[0] !== 'load'), [], values.command);
    assert.deepEqual(b.redraws, redraws, values.command);
    assert.ok(b.log.includes(`::notice::${message}`), values.command);
  }
});

test('any other refusal fails the step before any change, and leaves the chart alone', async () => {
  for (const [values, code, message, prepare] of [
    [input('scope start'), 'input', /^#11 is finished \(Done\) and is not started again\./, f => { f.issues.get(11).item.status = s.done; }],
    [input('scope hill', { number: '10' }), 'type', '#10 is not a scope issue.'],
    [input('scope start'), 'input', /^#11 cannot start: its pitch #10 is Shaped,/, f => { f.issues.get(10).item.status = s.shaped; }],
    [input('scope hill'), 'input', /^#11 was dropped \(Dropped\), so its hill position stays\./, f => { f.issues.get(11).item.status = s.dropped; }],
    [input('scope new', { body: '## Notes\n\nNo section the config names.\n' }), 'input', 'Missing sections: --done'],
    [input('scope done', { report: reports.scope.replace('## Evidence', '## Proof') }), 'input', /^The report has no "## Evidence" section\./],
    [input('pitch done'), 'input', 'Scopes are still open: #11, #12. Finish each with scope done, or cut it with scope drop.'],
  ]) {
    const b = board(values, prepare);
    await assert.rejects(b.run(), { code, message }, values.command);
    assert.deepEqual(b.f.calls.filter(c => c[0] !== 'load'), [], values.command);
    assert.deepEqual(b.redraws, [], values.command);
  }
});

test('a command that stops part-way fails with the CLI\'s message, and a new one says not to run it again', async () => {
  const b = board(input('scope new'));
  b.f.failing.add('POST /issues/10/sub_issues');
  await assert.rejects(b.run(), { code: 'partial', message: /^scope new stopped after 1 of 6 changes\.[\s\S]*Running the command again would create another issue\.$/ });
  assert.deepEqual(b.redraws, []);
});

test('a chart that is not drawn is a warning, and the step still succeeds', async () => {
  for (const [error, why] of [
    [new ShapeUpError('conflict', 'Updating the generated branch conflicted. Nothing was forced; run it again.'), 'Updating the generated branch conflicted. Nothing was forced; run it again.'],
    [new Error('fetch failed: project-secret'), 'An internal error occurred.'],
  ]) {
    const b = board(input('scope hill'));
    b.hill.redraw = async () => { throw error; };
    assert.deepEqual(await b.run(), { result: 'changed', number: 11 });
    assert.deepEqual(b.log.at(-1), `::warning::The hill chart was not redrawn: ${why} Redraw it by running the hill chart workflow by hand with the pitch number.`);
    assert.ok(!b.log.join('\n').includes('project-secret'));
  }
});

test('the log holds no token and none of the Markdown inputs', async () => {
  const log = [];
  for (const command of Object.keys(valid)) {
    const b = board(input(command), command === 'pitch done' ? closeScopes : undefined);
    await b.run();
    log.push(...b.log);
  }
  const text = log.join('\n');
  assert.match(text, /^#11 hill 30 → 45$/m);
  for (const hidden of ['project-secret', 'github-secret', 'The approach is settled', 'Saving a setting', 'Pull request #5', 'Players can pay', 'Frozen', 'Clearer']) {
    assert.ok(!text.includes(hidden), hidden);
  }
});

test('an annotation stays one workflow command whatever its message holds', () => {
  assert.equal(annotation('error', 'a 100% match\r\nMade:\n::set-output name=result::changed'),
    '::error::a 100%25 match%0D%0AMade:%0A::set-output name=result::changed');
});

test('main reads its inputs from the environment, refuses before any call, and writes its outputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shapeup-board-'));
  const configPath = join(dir, 'shapeup.json');
  const outputPath = join(dir, 'output');
  // The step runs in the repository root, where examples/ISSUE_TEMPLATE holds the bug template.
  await writeFile(configPath, JSON.stringify({ ...JSON.parse(readFileSync('examples/shapeup.json', 'utf8')), templateDir: 'examples/ISSUE_TEMPLATE' }));
  await writeFile(outputPath, '');
  const env = values => ({ GITHUB_REPOSITORY: 'o/r', GITHUB_OUTPUT: outputPath, INPUT_CONFIG: configPath,
    ...Object.fromEntries(Object.entries({ ...tokens, ...values }).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value])) });
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.push([options.method, new URL(url).pathname, options.headers.Authorization]);
    return new Response(JSON.stringify({ number: 31, id: 310, node_id: 'N31', html_url: 'https://github.com/o/r/issues/31' }), { status: 201 });
  };
  try {
    const log = [];
    await assert.rejects(main(env({ command: 'pitch bet', number: '10' }), line => log.push(line)), { code: 'input' });
    await assert.rejects(main(env({ ...input('bug new'), number: '11' }), line => log.push(line)), { code: 'input' });
    assert.deepEqual(seen, []);
    await main(env(input('bug new')), line => log.push(line));
    assert.deepEqual(seen, [['POST', '/repos/o/r/issues', 'Bearer github-secret']]);
    assert.equal(await readFile(outputPath, 'utf8'), 'result=changed\nnumber=31\n');
    assert.deepEqual(log, ['#31 https://github.com/o/r/issues/31']);
  } finally {
    globalThis.fetch = original;
  }
});
