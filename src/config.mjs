import { readFile } from 'node:fs/promises';
import { ShapeUpError } from './domain.mjs';

export const defaultConfigPath = '.github/shapeup.json';

// Each kind maps CLI parameters to the ## sections of its issue template.
export const defaultKinds = {
  pitch: { template: 'pitch.md', sections: { problem: 'Problem', solution: 'Solution', 'rabbit-holes': 'Rabbit holes', 'no-gos': 'No-gos' },
    required: ['problem', 'solution', 'rabbit-holes', 'no-gos'] },
  scope: { template: 'scope.md', sections: { done: 'Done means' }, required: ['done'] },
  cooldown: { template: 'cooldown.md', sections: { what: 'What', why: 'Why', done: 'Done means' }, required: ['what', 'done'] },
  bug: { template: 'bug.md', sections: { symptom: 'Symptom', steps: 'Steps', expected: 'Expected', environment: 'Environment' },
    required: ['symptom', 'steps', 'expected'] },
};

// The completion report that pitch done and scope done post is these ## sections, in order.
// A template file of that name in templateDir, if there is one, is the template instead.
export const defaultReports = {
  pitch: { template: 'pitch-report.md', sections: ['Outcome', 'Scopes', 'Accepted limits', 'Follow-ups'] },
  scope: { template: 'scope-report.md', sections: ['Outcome', 'Evidence', 'Follow-ups'] },
};

export const defaults = {
  statusField: 'Status',
  appetiteField: 'Appetite',
  cycleField: 'Cycle',
  hillField: 'Hill Position',
  statuses: { shaped: 'Shaped', bet: 'Bet', doing: 'In progress', done: 'Done', dropped: 'Dropped' },
  appetites: { 1: '1 cycle', 2: '2 cycles' },
  pitchLabel: 'pitch',
  scopeLabel: 'scope',
  cooldownLabel: 'cooldown',
  bugLabel: 'bug',
  assignee: null,
  templateDir: '.github/ISSUE_TEMPLATE',
  generatedBranch: 'generated/shapeup',
  chartAlt: 'Hill chart',
};

// Parameters the CLI reads itself on new, edit and done, so no section can take their names.
export const reserved = ['title', 'from', 'footnote', 'reason', 'reason-file', 'report', 'report-file'];

const fail = message => { throw new ShapeUpError('config', message); };
const text = value => typeof value === 'string' && value.trim() !== '';

// Only the project's location is required; every other key has a default.
export function parseConfig(source) {
  let raw;
  try { raw = JSON.parse(source); } catch { fail('The config file is not valid JSON.'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('The config file must hold a JSON object.');
  const config = { ...defaults, ...raw,
    statuses: { ...defaults.statuses, ...raw.statuses },
    appetites: raw.appetites ?? defaults.appetites,
    kinds: { ...defaultKinds, ...raw.kinds },
    reports: { ...defaultReports, ...raw.reports } };
  if (!text(config.projectOwner)) fail('projectOwner is required.');
  if (!['user', 'organization'].includes(config.projectOwnerType)) fail('projectOwnerType must be "user" or "organization".');
  if (!Number.isSafeInteger(config.projectNumber) || config.projectNumber < 1) fail('projectNumber must be a positive integer.');
  for (const key of ['statusField', 'appetiteField', 'cycleField', 'hillField', 'pitchLabel', 'scopeLabel', 'cooldownLabel', 'bugLabel', 'templateDir', 'chartAlt']) {
    if (!text(config[key])) fail(`${key} must be a non-empty string.`);
  }
  for (const [key, value] of Object.entries(config.statuses)) if (!text(value)) fail(`statuses.${key} must be a non-empty string.`);
  if (!Object.keys(config.appetites).length || Object.values(config.appetites).some(value => !text(value))) {
    fail('appetites must map each appetite to a non-empty option name.');
  }
  if (config.assignee !== null && !text(config.assignee)) fail('assignee must be a login or null.');
  if (!/^generated\/[A-Za-z0-9._/-]+$/.test(config.generatedBranch)) fail('generatedBranch must start with "generated/".');
  for (const [kind, spec] of Object.entries(config.kinds)) {
    if (!text(spec?.template) || !spec.sections || typeof spec.sections !== 'object') fail(`kinds.${kind} needs a template and sections.`);
    for (const [param, heading] of Object.entries(spec.sections)) {
      if (!/^[a-z][a-z0-9-]*$/.test(param) || !text(heading)) fail(`kinds.${kind}.sections.${param} is not a valid parameter and heading.`);
      if (reserved.includes(param)) fail(`kinds.${kind}.sections.${param} cannot name a section: --${param} is a parameter of the CLI itself.`);
    }
    spec.required ??= [];
    if (spec.required.some(param => !(param in spec.sections))) fail(`kinds.${kind}.required names a parameter that has no section.`);
  }
  for (const [kind, spec] of Object.entries(config.reports)) {
    if (!(kind in defaultReports)) fail(`reports.${kind} is not a report: only pitch and scope have one.`);
    if (!text(spec?.template) || !Array.isArray(spec.sections) || !spec.sections.length || !spec.sections.every(text)) {
      fail(`reports.${kind} needs a template and a list of section headings.`);
    }
    if (new Set(spec.sections).size !== spec.sections.length) fail(`reports.${kind}.sections names a heading twice.`);
  }
  return config;
}

export async function loadConfig(path = defaultConfigPath) {
  let source;
  try { source = await readFile(path, 'utf8'); } catch { fail(`Cannot read the config file ${path}.`); }
  return parseConfig(source);
}
