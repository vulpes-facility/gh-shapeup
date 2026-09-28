import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaults, defaultKinds, defaultReports, parseConfig, reserved } from '../src/config.mjs';

const minimal = { projectOwner: 'octocat', projectOwnerType: 'user', projectNumber: 1 };
const parse = value => parseConfig(JSON.stringify(value));

test('only the project location is required; everything else has a default', () => {
  const config = parse(minimal);
  assert.equal(config.hillField, 'Hill Position');
  assert.equal(config.statuses.doing, 'In progress');
  assert.equal(config.generatedBranch, 'generated/shapeup');
  assert.equal(config.assignee, null);
  assert.deepEqual(config.kinds, defaultKinds);
  assert.deepEqual(config.reports, defaultReports);
  assert.deepEqual(config.reports.pitch.sections, ['Outcome', 'Scopes', 'Accepted limits', 'Follow-ups']);
  assert.deepEqual(config.reports.scope.sections, ['Outcome', 'Evidence', 'Follow-ups']);
  assert.deepEqual(parseConfig(readFileSync('examples/shapeup.json', 'utf8')).templateDir, defaults.templateDir);
});
test('partial statuses and kinds keep the defaults they do not name', () => {
  const kind = { template: 'p.md', sections: { goal: 'Goal' }, required: ['goal'] };
  const config = parse({ ...minimal, statuses: { done: 'Finished' }, kinds: { pitch: kind } });
  assert.equal(config.statuses.done, 'Finished');
  assert.equal(config.statuses.shaped, 'Shaped');
  assert.deepEqual(config.kinds.pitch, kind);
  assert.deepEqual(config.kinds.scope, defaultKinds.scope);
  const report = { template: 'done.md', sections: ['Outcome', 'Verification'] };
  const reported = parse({ ...minimal, reports: { scope: report } });
  assert.deepEqual(reported.reports.scope, report);
  assert.deepEqual(reported.reports.pitch, defaultReports.pitch);
});
test('invalid configs are named, not guessed', () => {
  for (const bad of [
    {},
    { ...minimal, projectOwnerType: 'team' },
    { ...minimal, projectNumber: 0 },
    { ...minimal, hillField: '' },
    { ...minimal, generatedBranch: 'main' },
    { ...minimal, appetites: {} },
    { ...minimal, kinds: { pitch: { template: 'p.md', sections: { Goal: 'Goal' } } } },
    { ...minimal, kinds: { pitch: { template: 'p.md', sections: { goal: 'Goal' }, required: ['other'] } } },
    { ...minimal, reports: { bug: { template: 'b.md', sections: ['Outcome'] } } },
    { ...minimal, reports: { scope: { template: 's.md', sections: [] } } },
    { ...minimal, reports: { scope: { template: 's.md', sections: ['Outcome', ''] } } },
    { ...minimal, reports: { scope: { template: 's.md', sections: ['Outcome', 'Outcome'] } } },
    { ...minimal, reports: { scope: { sections: ['Outcome'] } } },
    { ...minimal, reports: { scope: { template: 's.md', sections: { outcome: 'Outcome' } } } },
  ]) assert.throws(() => parse(bad), { code: 'config' }, JSON.stringify(bad));
  assert.throws(() => parseConfig('{'), { code: 'config' });
});
test('a section cannot take the name of a parameter the CLI reads itself', () => {
  assert.deepEqual(reserved, ['title', 'from', 'footnote', 'reason', 'reason-file', 'report', 'report-file']);
  for (const param of reserved) {
    assert.throws(() => parse({ ...minimal, kinds: { bug: { template: 'b.md', sections: { [param]: 'Heading' } } } }),
      { code: 'config', message: `kinds.bug.sections.${param} cannot name a section: --${param} is a parameter of the CLI itself.` });
  }
  assert.equal(parse({ ...minimal, kinds: { bug: { template: 'b.md', sections: { reasons: 'Reasons' } } } }).kinds.bug.sections.reasons, 'Reasons');
});
test('the schema lists every key the loader knows', () => {
  const schema = JSON.parse(readFileSync('config.schema.json', 'utf8'));
  for (const key of [...Object.keys(defaults), 'projectOwner', 'projectOwnerType', 'projectNumber', 'kinds', 'reports']) {
    assert.ok(key in schema.properties, key);
  }
  assert.deepEqual(Object.keys(schema.properties.statuses.properties), Object.keys(defaults.statuses));
  assert.deepEqual(Object.keys(schema.properties.reports.properties), Object.keys(defaultReports));
  assert.deepEqual(schema.$defs.kind.properties.sections.propertyNames.not.enum, reserved);
});
