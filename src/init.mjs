import { ShapeUpError } from './domain.mjs';

// Creates the labels, the project and its fields that the config names.
// Whatever already exists is only reported; --force brings it back to what the config says.

const labelColors = { pitch: '5319e7', scope: '1d76db', cooldown: '0e8a16', bug: 'd73a4a' };
const labelDescriptions = {
  pitch: 'A shaped pitch for the betting table.',
  scope: 'A piece of a bet pitch and one dot on its hill chart.',
  cooldown: 'Small work for the cooldown: fixes, exploration, cleanup.',
  bug: 'Something does not work as expected.',
};
const statusColors = { shaped: 'GRAY', bet: 'BLUE', doing: 'YELLOW', done: 'GREEN', dropped: 'RED' };
const statusDescriptions = {
  shaped: 'Shaped and waiting at the betting table.',
  bet: 'Bet on a cycle.',
  doing: 'Being built.',
  done: 'Finished within its cycle.',
  dropped: 'Closed by the circuit breaker.',
};

export function labelSpecs(config) {
  return Object.keys(labelColors).map(kind => ({
    name: config[`${kind}Label`], color: labelColors[kind], description: labelDescriptions[kind] }));
}

export function fieldSpecs(config) {
  return [
    { name: config.statusField, dataType: 'SINGLE_SELECT', options: Object.entries(config.statuses).map(([key, name]) => ({
      name, color: statusColors[key] ?? 'GRAY', description: statusDescriptions[key] ?? '' })) },
    { name: config.appetiteField, dataType: 'SINGLE_SELECT', options: Object.entries(config.appetites).map(([key, name]) => ({
      name, color: 'GRAY', description: `An appetite of ${key} cycle${key === '1' ? '' : 's'}.` })) },
    { name: config.cycleField, dataType: 'ITERATION' },
    { name: config.hillField, dataType: 'NUMBER' },
  ];
}

const fieldNodes = `fields(first:50) { nodes {
  ... on ProjectV2Field { id name dataType }
  ... on ProjectV2SingleSelectField { id name dataType options { id name } }
  ... on ProjectV2IterationField { id name dataType }
} }`;

export class Init {
  constructor({ api, config, out = console.log, today = () => new Date().toISOString().slice(0, 10) }) {
    this.api = api;
    this.config = config;
    this.out = out;
    this.today = today;
  }

  warn(message) { this.out(`warning: ${message}`); }

  // Each change is recorded once made, so a run that stops can say what it made and what failed. Between changes,
  // doing is null, so a failed read is not taken for the change before it.
  async change(label, run) {
    this.doing = label;
    const result = await run();
    this.made.push(label);
    this.doing = null;
    return result;
  }

  // A second run finds the project by the configured number and sets up a project it did not create only with --force,
  // so after creating one it needs the new number and --force.
  finishLine(force) {
    if (this.createdNumber === undefined) return `To finish, run init${force ? ' --force' : ''} again: it leaves alone what already matches the config.`;
    if (this.createdNumber !== this.config.projectNumber) return `To finish, set "projectNumber": ${this.createdNumber} in the config, then run init --force.`;
    return 'To finish, run init --force again: the project this run created is set up only with --force.';
  }

  async run({ force = false } = {}) {
    this.made = [];
    this.doing = null;
    this.createdNumber = undefined;
    try {
      await this.labels(force);
      const project = await this.project();
      // A project made just now has only GitHub's default fields, so nothing on it can be lost.
      await this.fields(project, force || project.created);
    } catch (error) {
      // Nothing is rolled back; a second run leaves alone what the first one made.
      if (!this.made.length) throw error;
      throw new ShapeUpError('partial', [
        `init stopped after ${this.made.length} change${this.made.length === 1 ? '' : 's'}. Nothing was rolled back.`,
        'Made:', ...this.made.map(label => `- ${label}`),
        'Failed:', `- ${this.doing ?? 'reading from GitHub after the last change'}: ${error.message}`,
        'Not attempted: the rest of init.',
        this.finishLine(force),
      ].join('\n'));
    }
    this.out('Still by hand: turn on the project workflows "Auto-add to project" (for this repository) and "Auto-add sub-issues to project",');
    this.out('add the repository secret SHAPEUP_PROJECT_TOKEN, and copy the templates, the workflow and the CLI wrapper from examples/.');
  }

  async labels(force) {
    for (const label of labelSpecs(this.config)) {
      const path = `/labels/${encodeURIComponent(label.name)}`;
      const existing = await this.api.rest(path, { missing: true });
      if (!existing) {
        await this.change(`create label "${label.name}"`, () => this.api.rest('/labels', { method: 'POST', body: label }));
        this.out(`created label "${label.name}"`);
      } else if (force) {
        await this.change(`update label "${label.name}"`, () => this.api.rest(path, { method: 'PATCH', body: { color: label.color, description: label.description } }));
        this.out(`updated label "${label.name}"`);
      } else {
        this.warn(`label "${label.name}" exists; left as it is (--force updates it)`);
      }
    }
  }

  async project() {
    const c = this.config;
    const [repoOwner, repo] = this.api.repository.split('/');
    const data = await this.api.graphql(`query($owner:String!,$number:Int!,$repoOwner:String!,$repo:String!) {
      owner: ${c.projectOwnerType}(login:$owner) { id projectV2(number:$number) { id number url ${fieldNodes} } }
      repository(owner:$repoOwner,name:$repo) { id }
    }`, { owner: c.projectOwner, number: c.projectNumber, repoOwner, repo }, { notFound: true });
    const existing = data.owner?.projectV2;
    if (existing) {
      this.warn(`project #${existing.number} exists; left as it is`);
      return { id: existing.id, fields: existing.fields.nodes, created: false };
    }
    const created = (await this.change('create the project', () => this.api.graphql(`mutation($owner:ID!,$repository:ID!,$title:String!) {
      createProjectV2(input:{ownerId:$owner,repositoryId:$repository,title:$title}) { projectV2 { id number url ${fieldNodes} } }
    }`, { owner: data.owner.id, repository: data.repository.id, title: 'Betting table' }))).createProjectV2.projectV2;
    this.createdNumber = created.number;
    this.out(`created project #${created.number} ${created.url}`);
    if (created.number !== c.projectNumber) this.out(`set "projectNumber": ${created.number} in the config`);
    return { id: created.id, fields: created.fields.nodes, created: true };
  }

  async fields(project, force) {
    for (const spec of fieldSpecs(this.config)) {
      const field = project.fields.find(node => node.name === spec.name);
      if (!field) {
        await this.change(`create field "${spec.name}"`, () => this.create(project.id, spec));
        this.out(`created field "${spec.name}"`);
      } else if (field.dataType !== spec.dataType) {
        if (!force) { this.warn(`field "${spec.name}" is ${field.dataType}, not ${spec.dataType}; left as it is (--force recreates it)`); continue; }
        await this.change(`delete field "${spec.name}" of type ${field.dataType}`,
          () => this.api.graphql(`mutation($field:ID!) { deleteProjectV2Field(input:{fieldId:$field}) { clientMutationId } }`, { field: field.id }));
        await this.change(`create field "${spec.name}" as ${spec.dataType}`, () => this.create(project.id, spec));
        this.out(`recreated field "${spec.name}" as ${spec.dataType}`);
      } else if (spec.options && force) {
        // Keeping the id of an option with the same name keeps the items that hold it.
        const options = spec.options.map(option => {
          const same = field.options.find(item => item.name === option.name);
          return same ? { id: same.id, ...option } : option;
        });
        await this.change(`set the options of field "${spec.name}"`, () => this.api.graphql(`mutation($field:ID!,$options:[ProjectV2SingleSelectFieldOptionInput!]) {
          updateProjectV2Field(input:{fieldId:$field,singleSelectOptions:$options}) { clientMutationId }
        }`, { field: field.id, options }));
        this.out(`updated the options of field "${spec.name}"`);
      } else {
        this.warn(`field "${spec.name}" exists; left as it is${spec.options ? ' (--force sets its options)' : ''}`);
      }
    }
  }

  create(projectId, spec) {
    const extra = spec.options ? { singleSelectOptions: spec.options }
      : spec.dataType === 'ITERATION' ? { iterationConfiguration: { startDate: this.today(), duration: 7, iterations: [] } } : {};
    return this.api.graphql(`mutation($input:CreateProjectV2FieldInput!) { createProjectV2Field(input:$input) { clientMutationId } }`,
      { input: { projectId, dataType: spec.dataType, name: spec.name, ...extra } });
  }
}
