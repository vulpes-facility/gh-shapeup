import { appendFile } from 'node:fs/promises';
import { Board } from './board.mjs';
import { Cli, reportTemplateReader, templateReader } from './cli.mjs';
import { loadConfig } from './config.mjs';
import { ShapeUpError, parsePosition } from './domain.mjs';
import { GitHub } from './github.mjs';
import { HillService } from './service.mjs';
import { GeneratedStore } from './store.mjs';

// The commands a cycle runs from a workflow: the inputs each needs, the ones it also takes (at least one of them),
// and the chart it aligns, named by the pitch input or by the scope in number.
// Shaping, betting, the circuit breaker, dropping a scope, cooldown work, bug edits and init stay with people on the CLI.
export const commands = {
  'scope new': { needs: ['pitch', 'title', 'body'], chart: 'pitch' },
  'scope edit': { needs: ['number', 'reason'], takes: ['title', 'body'] },
  'scope start': { needs: ['number', 'reason'] },
  'scope hill': { needs: ['number', 'position', 'reason'], chart: 'scope' },
  'scope done': { needs: ['number', 'report'], chart: 'scope' },
  'pitch done': { needs: ['number', 'report'] },
  'bug new': { needs: ['title', 'body'], project: false },
};

const names = ['number', 'pitch', 'title', 'body', 'position', 'reason', 'report'];
// The Markdown inputs take the places of the CLI's files: body is --from, reason --reason-file, report --report-file.
const files = { body: 'from', reason: 'reason-file', report: 'report-file' };
// The title, body and report limits are GitHub's, so a text is refused before the change instead of by the API after it.
const limits = { title: 256, body: 65_536, reason: 4_000, report: 65_536 };
// GraphQL's Int.
const largest = 2_147_483_647;

const fail = message => { throw new ShapeUpError('input', message); };

function issueNumber(name, value) {
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > largest) fail(`${name} must be an issue number from 1 to ${largest}.`);
  return Number(value);
}

function text(name, value) {
  if (name === 'title' && /[\r\n]/.test(value)) fail('title must be one line.');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) fail(`${name} holds a control character other than tab and newline.`);
  if (Array.from(value).length > limits[name]) fail(`${name} is longer than ${limits[name].toLocaleString('en-US')} characters.`);
  return value;
}

// Checks every input before the first call to GitHub. A blank input counts as not given,
// and no message repeats what an input holds.
export function readInputs(read) {
  const command = read('command').trim();
  const spec = commands[command];
  if (!spec) fail(`command must be one of: ${Object.keys(commands).join(', ')}.`);
  const takes = [...spec.needs, ...(spec.takes ?? [])];
  const given = names.filter(name => read(name).trim() !== '');
  const unread = given.find(name => !takes.includes(name));
  if (unread) fail(`${command} does not take the ${unread} input. It takes ${takes.join(', ')}.`);
  const missing = spec.needs.find(name => !given.includes(name));
  if (missing) fail(`${command} needs the ${missing} input.`);
  if (spec.takes && !spec.takes.some(name => given.includes(name))) fail(`${command} needs at least one of ${spec.takes.join(', ')}.`);
  const [kind, action] = command.split(' ');
  const inputs = { command, kind, action };
  for (const name of given) {
    const value = read(name);
    if (name === 'number' || name === 'pitch') inputs[name] = issueNumber(name, value.trim());
    else if (name === 'position') inputs.position = parsePosition(value.trim());
    // Markdown is passed on as given, as a file would be.
    else inputs[name] = text(name, name === 'title' ? value.trim() : value);
  }
  const tokens = { project: read('project-token').trim(), github: read('github-token').trim() };
  if (!tokens.github) fail('The github-token input is empty.');
  if (spec.project !== false && !tokens.project) fail(`The project-token input is empty, and ${command} changes the project.`);
  return { inputs, tokens };
}

// The arguments the CLI would parse for the same command.
export function cliArgs(inputs) {
  const options = {};
  for (const name of ['pitch', 'title', 'position']) if (inputs[name] !== undefined) options[name] = String(inputs[name]);
  for (const [name, option] of Object.entries(files)) if (inputs[name] !== undefined) options[option] = name;
  return { kind: inputs.kind, action: inputs.action, number: inputs.number ?? null, options, footnotes: [] };
}

// The Cli reads the Markdown inputs by name where it would read a file.
export const markdownReader = inputs => async name => {
  if (!(name in files) || inputs[name] === undefined) throw new ShapeUpError('input', `There is no ${name} input.`);
  return inputs[name];
};

// A workflow command is one line: escaping % and line breaks keeps a message whole and keeps any text in it from starting another command.
export const annotation = (level, message) =>
  `::${level}::${String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`;

// Runs the command with the Cli, then aligns the chart of the pitch it changed, and returns the step's outputs.
// A result that already holds changes nothing and posts nothing, and it is a notice, not a failure,
// so a workflow that returns to a station can run the same step again.
export async function runBoard(inputs, { cli, hill, log = console.log }) {
  const spec = commands[inputs.command];
  const outputs = { result: 'changed', number: inputs.number };
  try {
    // Every message the Cli returns starts with the issue it names; after new, that is the issue it created.
    const named = /^#([0-9]+)/.exec(await cli.run(cliArgs(inputs)));
    if (named) outputs.number = Number(named[1]);
  } catch (error) {
    if (!(error instanceof ShapeUpError && error.code === 'holds')) throw error;
    log(annotation('notice', `${error.message} Nothing changed, and the ${inputs.report === undefined ? 'reason' : 'report'} was not posted.`));
    outputs.result = 'unchanged';
  }
  if (spec.chart) {
    try {
      log(`Hill chart: ${await hill.redraw(spec.chart === 'pitch' ? inputs.pitch : inputs.number, spec.chart)}`);
    } catch (error) {
      // The change is made and posted by now, and running a new command again would make another issue.
      const why = error instanceof ShapeUpError ? error.message : 'An internal error occurred.';
      log(annotation('warning', `The hill chart was not redrawn: ${why} Redraw it by running the hill chart workflow by hand with the pitch number.`));
    }
  }
  return outputs;
}

// Action inputs arrive as INPUT_<NAME> with the name upper-cased and hyphens kept.
// The step runs in the checked-out repository, which holds the config and the issue and report templates.
export async function main(env = process.env, log = console.log) {
  const read = name => env[`INPUT_${name.toUpperCase()}`] ?? '';
  const { inputs, tokens } = readInputs(read);
  const config = await loadConfig(read('config').trim() || undefined);
  const api = new GitHub({ repository: env.GITHUB_REPOSITORY, repositoryToken: tokens.github, projectToken: tokens.project });
  const root = process.cwd();
  const cli = new Cli({ api, board: new Board(api, config), config, readTemplate: templateReader(root, config),
    readReportTemplate: reportTemplateReader(root), readText: markdownReader(inputs), out: log });
  const hill = new HillService(api, new GeneratedStore(api, config.generatedBranch), config);
  const outputs = await runBoard(inputs, { cli, hill, log });
  const lines = Object.entries(outputs).filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${value}\n`);
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, lines.join(''));
}
