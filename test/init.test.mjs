import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from '../src/cli.mjs';
import { parseConfig } from '../src/config.mjs';
import { ShapeUpError } from '../src/domain.mjs';
import { Init, fieldSpecs, labelSpecs } from '../src/init.mjs';

const config = parseConfig(readFileSync('examples/shapeup.json', 'utf8'));
const s = config.statuses;

const readyFields = () => [
  { id: 'F-status', name: 'Status', dataType: 'SINGLE_SELECT', options: Object.values(s).map((name, i) => ({ id: `o${i}`, name })) },
  { id: 'F-appetite', name: 'Appetite', dataType: 'SINGLE_SELECT', options: [{ id: 'a1', name: '1 cycle' }, { id: 'a2', name: '2 cycles' }] },
  { id: 'F-cycle', name: 'Cycle', dataType: 'ITERATION' },
  { id: 'F-hill', name: 'Hill Position', dataType: 'NUMBER' },
];

function fixture({ labels = ['pitch', 'scope', 'cooldown', 'bug'], project = { fields: readyFields() }, createdNumber = 7, fail = () => false } = {}) {
  const calls = [];
  const api = {
    repository: 'octo/repo',
    async rest(path, options = {}) {
      calls.push(['rest', options.method ?? 'GET', path, options.body]);
      if (fail(calls.at(-1))) throw new ShapeUpError('api', 'GitHub API request failed (HTTP 500).');
      if ((options.method ?? 'GET') === 'GET') return labels.includes(decodeURIComponent(path.replace('/labels/', ''))) ? { name: path } : null;
      return {};
    },
    async graphql(query, variables, options = {}) {
      const name = /(createProjectV2Field|createProjectV2|deleteProjectV2Field|updateProjectV2Field)\(/.exec(query)?.[1] ?? 'read';
      calls.push(['graphql', name, variables, options]);
      if (fail(calls.at(-1))) throw new ShapeUpError('graphql', 'A GitHub Project GraphQL request failed.');
      if (name === 'read') return { owner: { id: 'U1', projectV2: project && { id: 'P1', number: 1, url: 'https://x/1', fields: { nodes: project.fields } } }, repository: { id: 'R1' } };
      if (name === 'createProjectV2') return { createProjectV2: { projectV2: { id: 'P2', number: createdNumber, url: `https://x/${createdNumber}`,
        fields: { nodes: [{ id: 'F-default', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'd1', name: 'Todo' }, { id: 'd2', name: 'Done' }] }] } } } };
      return {};
    },
  };
  const out = [];
  const init = new Init({ api, config, out: line => out.push(line), today: () => '2026-09-26' });
  return { calls, out, run: force => init.run({ force }), writes: () => calls.filter(c => (c[0] === 'rest' && c[1] !== 'GET') || (c[0] === 'graphql' && c[1] !== 'read')) };
}

test('arguments: init takes --force as a flag without a value', () => {
  assert.deepEqual(parseArgs(['init']), { kind: 'init', action: null, number: null, options: {}, footnotes: [] });
  assert.deepEqual(parseArgs(['init', '--force']).options, { force: true });
});

test('init only warns when the labels, the project and its fields already exist', async () => {
  const f = fixture();
  await f.run(false);
  assert.deepEqual(f.writes(), []);
  assert.equal(f.out.filter(line => line.startsWith('warning: ')).length, 4 + 1 + 4);
  assert.ok(f.calls.find(c => c[1] === 'read')[3].notFound, 'a missing project is not an error');
});

test('init creates what is missing and names it from the config', async () => {
  const f = fixture({ labels: ['bug'], project: { fields: readyFields().filter(field => field.name === 'Status') } });
  await f.run(false);
  const labels = f.writes().filter(c => c[0] === 'rest').map(c => c[3]);
  assert.deepEqual(labels.map(label => label.name), ['pitch', 'scope', 'cooldown']);
  assert.ok(labels.every(label => /^[0-9a-f]{6}$/.test(label.color) && label.description));
  const created = f.writes().filter(c => c[1] === 'createProjectV2Field').map(c => c[2].input);
  assert.deepEqual(created.map(input => [input.name, input.dataType]), [['Appetite', 'SINGLE_SELECT'], ['Cycle', 'ITERATION'], ['Hill Position', 'NUMBER']]);
  assert.deepEqual(created[0].singleSelectOptions.map(option => option.name), ['1 cycle', '2 cycles']);
  assert.deepEqual(created[1].iterationConfiguration, { startDate: '2026-09-26', duration: 7, iterations: [] });
});

test('init --force updates labels and sets options, keeping the ids of options with the same name', async () => {
  const fields = readyFields();
  fields[0].options = [{ id: 'keep', name: s.shaped }, { id: 'gone', name: 'Todo' }];
  const f = fixture({ project: { fields } });
  await f.run(true);
  assert.deepEqual(f.writes().filter(c => c[0] === 'rest').map(c => c[1]), ['PATCH', 'PATCH', 'PATCH', 'PATCH']);
  const status = f.writes().find(c => c[1] === 'updateProjectV2Field' && c[2].field === 'F-status')[2].options;
  assert.deepEqual(status.map(option => [option.id ?? null, option.name]), Object.values(s).map(name => [name === s.shaped ? 'keep' : null, name]));
  assert.ok(status.every(option => option.color && option.description !== undefined));
});

test('a field of the wrong type is only reported, and --force recreates it', async () => {
  const fields = readyFields();
  fields[3] = { id: 'F-text', name: 'Hill Position', dataType: 'TEXT' };
  const plain = fixture({ project: { fields } });
  await plain.run(false);
  assert.deepEqual(plain.writes(), []);
  assert.ok(plain.out.some(line => line.includes('"Hill Position" is TEXT, not NUMBER')));
  const forced = fixture({ project: { fields } });
  await forced.run(true);
  const writes = forced.writes().filter(c => c[0] === 'graphql').map(c => c[1]);
  assert.deepEqual(writes.slice(-2), ['deleteProjectV2Field', 'createProjectV2Field']);
  assert.equal(forced.writes().find(c => c[1] === 'deleteProjectV2Field')[2].field, 'F-text');
});

test('a missing project is created, linked to the repository, and set up without --force', async () => {
  const f = fixture({ project: null });
  await f.run(false);
  const create = f.writes().find(c => c[1] === 'createProjectV2')[2];
  assert.deepEqual(create, { owner: 'U1', repository: 'R1', title: 'Betting table' });
  assert.ok(f.out.includes('set "projectNumber": 7 in the config'));
  const status = f.writes().find(c => c[1] === 'updateProjectV2Field')[2];
  assert.equal(status.field, 'F-default');
  assert.deepEqual(status.options.map(option => option.name), Object.values(s));
  assert.deepEqual(f.writes().filter(c => c[1] === 'createProjectV2Field').map(c => c[2].input.name), ['Appetite', 'Cycle', 'Hill Position']);
});

test('the specs follow the config names', () => {
  const renamed = parseConfig(JSON.stringify({ projectOwner: 'o', projectOwnerType: 'user', projectNumber: 1,
    pitchLabel: 'idea', statusField: 'State', statuses: { shaped: 'Ready' } }));
  assert.equal(labelSpecs(renamed)[0].name, 'idea');
  const [status] = fieldSpecs(renamed);
  assert.equal(status.name, 'State');
  assert.equal(status.options[0].name, 'Ready');
});

test('init that fails after a change says what it made and that running it again finishes', async () => {
  const f = fixture({ labels: ['bug'], project: { fields: readyFields().filter(field => field.name === 'Status') },
    fail: call => call[1] === 'createProjectV2Field' && call[2].input.name === 'Cycle' });
  await assert.rejects(f.run(false), { code: 'partial', message: [
    'init stopped after 4 changes. Nothing was rolled back.',
    'Made:', '- create label "pitch"', '- create label "scope"', '- create label "cooldown"', '- create field "Appetite"',
    'Failed:', '- create field "Cycle": A GitHub Project GraphQL request failed.',
    'Not attempted: the rest of init.',
    'To finish, run init again: it leaves alone what already matches the config.',
  ].join('\n') });
  const fields = readyFields();
  fields[3] = { id: 'F-hill', name: 'Hill Position', dataType: 'TEXT' };
  const g = fixture({ project: { fields }, fail: call => call[1] === 'createProjectV2Field' });
  await assert.rejects(g.run(true), { code: 'partial', message: /^init stopped after 7 changes\. [\s\S]*- delete field "Hill Position" of type TEXT\nFailed:\n- create field "Hill Position" as NUMBER: A GitHub Project GraphQL request failed\.\nNot attempted: the rest of init\.\nTo finish, run init --force again: / });
  // A failure before any change is reported as it is.
  const h = fixture({ labels: [], fail: call => call[0] === 'rest' && call[1] === 'POST' });
  await assert.rejects(h.run(false), { code: 'api', message: 'GitHub API request failed (HTTP 500).' });
});
