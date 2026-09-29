import { readFileSync } from 'node:fs';
import { Cli, parseArgs } from '../src/cli.mjs';
import { parseConfig } from '../src/config.mjs';
import { ShapeUpError } from '../src/domain.mjs';

// A Cli on a fake repository and board: pitch #10 with scopes #11 and #12 on Cycle 2, cooldown #20 and bug #21.
export const config = parseConfig(readFileSync('examples/shapeup.json', 'utf8'));
const s = config.statuses;
export const reports = {
  pitch: '## Outcome\n\nPlayers can pay.\n\n## Scopes\n\n- #11 merged\n- #12 merged\n\n## Accepted limits\n\nNo refunds yet.\n\n## Follow-ups\n\nNone.\n',
  scope: '## Outcome\n\nMerged.\n\n## Evidence\n\n- Pull request #5, tests pass.\n\n## Follow-ups\n\nNone.\n',
};
export const cycle = { title: 'Cycle 2', id: 'c2' };

export function fixture() {
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
