import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usage } from '../src/cli.mjs';

const read = path => readFileSync(path, 'utf8');
const plugin = JSON.parse(read('plugins/gh-shapeup/.claude-plugin/plugin.json'));
const skill = read('plugins/gh-shapeup/skills/shapeup/SKILL.md');

// vulpes-facility/claude-plugins lists the plugin from plugins/gh-shapeup of this repository, under the plugin's name.
test('the plugin is named gh-shapeup, at the CLI\'s version', () => {
  assert.equal(plugin.name, 'gh-shapeup');
  assert.equal(plugin.version, JSON.parse(read('package.json')).version);
  assert.equal(plugin.repository, 'https://github.com/vulpes-facility/gh-shapeup');
});

test('the skill names itself, and tells Claude to run every command the CLI takes and no other', () => {
  assert.match(skill, /^---\nname: shapeup\ndescription: .+\n---\n/);
  const commands = new Set([...skill.matchAll(/`gh shapeup ([a-z]+(?: (?:new|edit|bet|unbet|break|done|start|hill|drop))?)[ `]/g)].map(match => match[1]));
  const cli = new Set([...usage.matchAll(/^ {2}([a-z]+(?: [a-z]+)?)(?= |$)/gm)].map(match => match[1]));
  assert.ok(cli.size > 15);
  assert.deepEqual([...commands].sort(), [...cli].sort());
});
