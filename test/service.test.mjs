import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HillService } from '../src/service.mjs';
import { ShapeUpError, drawnValues } from '../src/domain.mjs';
import { parseConfig } from '../src/config.mjs';

const config = parseConfig(readFileSync('examples/shapeup.json', 'utf8'));
const repository = 'owner/repo';
const template = '<!-- hill:start -->\n<!-- ![Hill chart](https://github.com/owner/repo/blob/generated/shapeup/hills/pitch-<number>.svg?raw=true&v=<commit>) -->\n<!-- hill:end -->\n\n## Problem\n\nBody';
const issue = (number, label, extra = {}) => ({ number, title: `Issue ${number}`, labels: [{ name: label }],
  repository_url: `https://api.github.com/repos/${repository}`, state: 'open', state_reason: null, body: '', ...extra });

function fixture() {
  const pitch = issue(10, 'pitch', { body: template, sub_issues_summary: { total: 3 } });
  const issues = new Map([[10, pitch], [11, issue(11, 'scope')], [12, issue(12, 'scope')],
    [13, issue(13, 'scope', { state: 'closed', state_reason: 'not_planned' })],
    [20, issue(20, 'pitch', { body: '', sub_issues_summary: { total: 0 } })],
    [40, issue(40, 'pitch', { body: '', sub_issues_summary: { total: 1 } })], [41, issue(41, 'scope')]]);
  const values = new Map([[11, 20], [12, null], [13, 70], [41, 10]]);
  const open = [10, 20];
  const writes = [], bodies = [];
  const store = {
    files: new Map(), sha: null, loads: 0,
    async load() { this.loads++; },
    async read(path) { return this.files.get(path) ?? null; },
    async write(files, message) {
      const changed = Object.entries(files).filter(([path, value]) => this.files.get(path) !== value);
      if (changed.length) { changed.forEach(([path, value]) => this.files.set(path, value)); writes.push({ files, message }); this.sha = `abcdef${writes.length}999`; }
      return this.sha;
    },
  };
  const api = {
    repository, fieldChecks: 0,
    async requireField() { this.fieldChecks++; },
    async issue(number) { return issues.get(number); },
    async parent(number) { return [11, 12, 13].includes(number) ? issues.get(10) : number === 41 ? issues.get(40) : null; },
    async children(number) { return ({ 10: [11, 12, 13], 40: [41] })[number]?.map(n => issues.get(n)) ?? []; },
    async positions(numbers) { return new Map(numbers.map(n => [n, values.get(n) ?? null])); },
    async openPitches() { return open.map(n => issues.get(n)); },
    async updateBody(number, body) { bodies.push({ number, body }); issues.get(number).body = body; },
  };
  const service = new HillService(api, store, config);
  const comment = (number = 12, extra = {}) => ({ action: 'created', issue: issues.get(number),
    comment: { id: 1, body: 'The unknowns are solved, so this moves over the top.', user: { login: 'owner', type: 'User' } }, ...extra });
  return { service, api, store, issues, values, open, writes, bodies, comment };
}

test('first comment draws every open scope, counting an empty value as 0 and skipping not-planned scopes', async () => {
  const f = fixture();
  assert.equal(await f.service.comment(f.comment()), 'drawn #10');
  assert.deepEqual([...drawnValues(f.issues.get(10).body)], [[11, 20], [12, 0]]);
  assert.match(f.issues.get(10).body, /!\[Hill chart\]\(https:\/\/github\.com\/owner\/repo\/blob\/generated\/shapeup\/hills\/pitch-10\.svg\?raw=true&v=abcdef1\)/);
  assert.match(f.issues.get(10).body, /\n\n## Problem\n\nBody$/);
  const svg = f.store.files.get('hills/pitch-10.svg');
  assert.match(svg, /data-scope="12" data-position="0"/);
  assert.doesNotMatch(svg, /data-scope="13"/);
});
test('the configured alt text is written into the pitch body', async () => {
  const f = fixture();
  f.service.config = { ...config, chartAlt: 'Progress' };
  await f.service.comment(f.comment());
  assert.match(f.issues.get(10).body, /!\[Progress\]\(https:/);
});
test('a comment leaves every chart alone when all of them match the board', async () => {
  const f = fixture();
  await f.service.comment(f.comment());
  assert.equal(await f.service.comment(f.comment()), 'unchanged');
  assert.equal(f.writes.length, 1);
  assert.equal(f.bodies.length, 1);
});
test('a comment also draws a sibling that moved without its own comment', async () => {
  const f = fixture();
  await f.service.comment(f.comment());
  f.values.set(11, 90);
  assert.equal(await f.service.comment(f.comment(12)), 'drawn #10');
  assert.deepEqual([...drawnValues(f.issues.get(10).body)], [[11, 90], [12, 0]]);
});
test('a changed value with a reason comment redraws the whole chart', async () => {
  const f = fixture();
  await f.service.comment(f.comment());
  f.values.set(12, 45);
  f.values.set(11, 90);
  assert.equal(await f.service.comment(f.comment(12)), 'drawn #10');
  assert.deepEqual([...drawnValues(f.issues.get(10).body)], [[11, 90], [12, 45]]);
  assert.match(f.issues.get(10).body, /v=abcdef2\)/);
});
test('PR comments, bot comments, edits and non-scope issues are ignored before any API call', async () => {
  const f = fixture();
  f.api.parent = () => { throw Error('must not call'); };
  const events = [f.comment(), f.comment(), f.comment(), f.comment(10)];
  events[0] = { ...events[0], issue: { ...events[0].issue, pull_request: {} } };
  events[1] = { ...events[1], comment: { ...events[1].comment, user: { login: 'github-actions[bot]', type: 'Bot' } } };
  events[2] = { ...events[2], action: 'edited' };
  for (const event of events) assert.equal(await f.service.comment(event), 'ignored');
});
test('a scope without a pitch is skipped without reading the board', async () => {
  const f = fixture();
  f.issues.set(30, issue(30, 'scope'));
  assert.equal(await f.service.comment(f.comment(30)), 'no-pitch');
  assert.equal(f.api.fieldChecks, 0);
});
for (const [name, mutate, code] of [
  ['ambiguous labels', f => { f.issues.get(12).labels.push({ name: 'pitch' }); }, 'type'],
  ['wrong parent type', f => { f.issues.get(10).labels = [{ name: 'scope' }]; }, 'type'],
  ['foreign child', f => { f.issues.get(11).repository_url = 'https://api.github.com/repos/other/repo'; }, 'relation'],
  ['out of range value', f => { f.values.set(11, 101); }, 'position'],
  ['missing field', f => { f.api.requireField = async () => { throw new ShapeUpError('field', 'Missing'); }; }, 'field'],
]) {
  test(`${name} fails before writes`, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(f.service.comment(f.comment()), { code });
    assert.equal(f.writes.length, 0);
    assert.equal(f.bodies.length, 0);
  });
}
test('closing a scope as not planned removes its dot; closing as completed keeps it', async () => {
  const f = fixture();
  await f.service.comment(f.comment());
  Object.assign(f.issues.get(11), { state: 'closed', state_reason: 'not_planned' });
  assert.equal(await f.service.lifecycle({ action: 'closed', issue: f.issues.get(11) }), 'drawn #10');
  assert.deepEqual([...drawnValues(f.issues.get(10).body)], [[12, 0]]);
  Object.assign(f.issues.get(12), { state: 'closed', state_reason: 'completed' });
  assert.equal(await f.service.lifecycle({ action: 'closed', issue: f.issues.get(12) }), 'unchanged');
});
test('every run also aligns other open pitches with scopes, so a cancelled pending run loses nothing', async () => {
  const f = fixture();
  await f.service.comment(f.comment());
  f.open.push(40); // its own signal was cancelled while waiting in the queue
  assert.equal(await f.service.comment(f.comment()), 'drawn #40');
  assert.deepEqual([...drawnValues(f.issues.get(40).body)], [[41, 10]]);
  assert.equal(f.issues.get(20).body, '');
  assert.equal(await f.service.lifecycle({ action: 'reopened', issue: f.issues.get(41) }), 'unchanged');
});
test('the signalling pitch is aligned even when it is no longer open', async () => {
  const f = fixture();
  f.open.splice(0);
  Object.assign(f.issues.get(10), { state: 'closed' });
  assert.equal(await f.service.lifecycle({ action: 'closed', issue: f.issues.get(12) }), 'drawn #10');
});
test('another pitch failing does not stop the signalling pitch, but fails the run', async () => {
  const f = fixture();
  f.open.push(40);
  f.issues.get(41).repository_url = 'https://api.github.com/repos/other/repo';
  await assert.rejects(f.service.comment(f.comment()), { code: 'reconcile', message: /#40 \(relation\)/ });
  assert.deepEqual([...drawnValues(f.issues.get(10).body)], [[11, 20], [12, 0]]);
});
test('renderer failure leaves the pitch body untouched', async () => {
  const f = fixture();
  f.service.renderer = () => { throw new Error('render'); };
  await assert.rejects(f.service.comment(f.comment()), { code: 'render' });
  assert.equal(f.issues.get(10).body, template);
  assert.equal(f.writes.length, 0);
});
test('redraw aligns only the pitch it is given, by its number or by one of its scopes', async () => {
  const f = fixture();
  f.open.push(40);
  assert.equal(await f.service.redraw(12, 'scope'), 'drawn #10');
  assert.deepEqual(f.writes.map(write => Object.keys(write.files)), [['hills/pitch-10.svg']]);
  assert.deepEqual([...drawnValues(f.issues.get(10).body)], [[11, 20], [12, 0]]);
  assert.equal(await f.service.redraw(10, 'pitch'), 'unchanged');
  f.values.set(11, 55);
  assert.equal(await f.service.redraw(10, 'pitch'), 'drawn #10');
  assert.equal(f.issues.get(40).body, '');
  assert.equal(await f.service.redraw(41, 'scope'), 'drawn #40');
  f.issues.set(30, issue(30, 'scope'));
  assert.equal(await f.service.redraw(30, 'scope'), 'no-pitch');
  await assert.rejects(f.service.redraw(11, 'pitch'), { code: 'type' });
});
test('manual rebuild draws open pitches that have scopes, or one given pitch', async () => {
  const f = fixture();
  assert.equal(await f.service.rebuild(''), 1);
  assert.equal(f.bodies.at(-1).number, 10);
  assert.equal(await f.service.rebuild('20'), 1);
  assert.match(f.issues.get(20).body, /^<!-- hill:start -->\n!\[Hill chart\]\(.*pitch-20\.svg.*\)\n<!-- hill:values -->\n<!-- hill:end -->/);
  await assert.rejects(f.service.rebuild('1;exit'), { code: 'input' });
});
