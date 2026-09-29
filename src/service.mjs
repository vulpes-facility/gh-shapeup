import { ShapeUpError, chartUrl, drawnValues, hillBlock, positionOf, renderHill, requireType, sameValues, withHill } from './domain.mjs';

export class HillService {
  constructor(api, store, config, renderer = renderHill) {
    this.api = api;
    this.store = store;
    this.config = config;
    this.renderer = renderer;
  }
  sameRepository(issue) {
    return issue.repository_url === `https://api.github.com/repos/${this.api.repository}`;
  }
  async initialize() {
    await this.api.requireField(this.config);
    await this.store.load();
  }
  // Scopes closed as not planned left the bet, so they leave the chart too.
  async scopes(pitch) {
    const children = (await this.api.children(pitch.number)).filter(child => {
      // Cross-repository sub-issues cannot be identified by local number alone.
      if (!this.sameRepository(child)) throw new ShapeUpError('relation', 'Sub-issues from another repository are not supported.');
      if (!child.labels.some(label => label.name === this.config.scopeLabel)) return false;
      requireType(child, 'scope', this.config);
      return !(child.state === 'closed' && child.state_reason === 'not_planned');
    });
    const values = await this.api.positions(children.map(child => child.number), this.config);
    return children.map(child => ({ number: child.number, title: child.title, position: positionOf(values.get(child.number)) }));
  }
  async draw(pitch, scopes) {
    let svg;
    try { svg = this.renderer(pitch, scopes); } catch {
      throw new ShapeUpError('render', 'Drawing the SVG failed. Run a manual rebuild.');
    }
    const sha = await this.store.write({ [`hills/pitch-${pitch.number}.svg`]: svg },
      `chore(shapeup): draw pitch #${pitch.number}`);
    const url = chartUrl(this.api.repository, this.config.generatedBranch, pitch.number, sha);
    const body = withHill(pitch.body, hillBlock(url, scopes, this.config.chartAlt));
    if (body !== String(pitch.body ?? '').replace(/\r\n/g, '\n')) await this.api.updateBody(pitch.number, body);
    return 'drawn';
  }
  async pitchOf(scope) {
    const pitch = await this.api.parent(scope.number);
    if (!pitch) return null;
    if (!this.sameRepository(pitch)) throw new ShapeUpError('relation', 'The parent pitch must be in the same repository.');
    requireType(pitch, 'pitch', this.config);
    return pitch;
  }
  // A new comment on a scope is the signal to reconcile.
  async comment(event) {
    if (event.action !== 'created' || !event.issue || event.issue.pull_request ||
        event.comment?.user?.type === 'Bot' ||
        !event.issue.labels?.some(label => label.name === this.config.scopeLabel)) return 'ignored';
    requireType(event.issue, 'scope', this.config);
    const pitch = await this.pitchOf(event.issue);
    if (!pitch) return 'no-pitch';
    return this.reconcile(pitch, event.issue.number);
  }
  // Opening, closing or reopening a scope changes which dots the chart shows.
  async lifecycle(event) {
    if (!['opened', 'closed', 'reopened'].includes(event.action) || !event.issue ||
        !event.issue.labels?.some(label => label.name === this.config.scopeLabel)) return 'ignored';
    requireType(event.issue, 'scope', this.config);
    const pitch = await this.pitchOf(event.issue);
    if (!pitch) return 'no-pitch';
    return this.reconcile(pitch);
  }
  // A queue that keeps only the latest pending run can cancel signals, so every run also aligns
  // each open pitch with scopes; a signal whose pending run was cancelled is caught up here.
  async reconcile(pitch, commented) {
    await this.initialize();
    const scopes = await this.scopes(pitch);
    if (commented && !scopes.some(child => child.number === commented)) {
      throw new ShapeUpError('relation', 'The parent and sub-issue relation does not match. Check it and run again.');
    }
    const drawn = await this.align(pitch, scopes) ? [pitch.number] : [];
    const others = (await this.api.openPitches(this.config))
      .filter(other => other.number !== pitch.number && other.sub_issues_summary?.total > 0);
    const failures = [];
    for (const other of others) {
      try {
        requireType(other, 'pitch', this.config);
        if (await this.align(other, await this.scopes(other))) drawn.push(other.number);
      } catch (error) {
        failures.push({ number: other.number, code: error instanceof ShapeUpError ? error.code : 'unexpected' });
      }
    }
    if (failures.length) throw new ShapeUpError('reconcile', `Could not align other pitches: ${failures.map(f => `#${f.number} (${f.code})`).join(', ')}. Run a manual rebuild.`);
    return drawn.length ? `drawn ${drawn.map(number => `#${number}`).join(' ')}` : 'unchanged';
  }
  // Aligns one pitch, named by its number or by one of its scopes. The board Action calls it after its change,
  // since the comment it posts as a bot does not wake the hill chart workflow.
  async redraw(number, type) {
    const pitch = type === 'scope' ? await this.pitchOf({ number }) : await this.api.issue(number);
    if (!pitch) return 'no-pitch';
    requireType(pitch, 'pitch', this.config);
    await this.initialize();
    return await this.align(pitch, await this.scopes(pitch)) ? `drawn #${pitch.number}` : 'unchanged';
  }
  // Draws only when the board no longer matches the values last drawn in the pitch body.
  async align(pitch, scopes) {
    if (sameValues(drawnValues(pitch.body), scopes)) return false;
    await this.draw(pitch, scopes);
    return true;
  }
  async rebuild(input) {
    if (input !== '' && !/^[1-9][0-9]*$/.test(input)) throw new ShapeUpError('input', 'pitch_number must be a positive integer.');
    if (input && !Number.isSafeInteger(Number(input))) throw new ShapeUpError('input', 'pitch_number is too large.');
    await this.initialize();
    const pitches = input ? [await this.api.issue(Number(input))] : await this.api.openPitches(this.config);
    const failures = [];
    let count = 0;
    for (const pitch of pitches) {
      try {
        requireType(pitch, 'pitch', this.config);
        const scopes = await this.scopes(pitch);
        // Without an explicit number, only pitches that already have scopes get a chart.
        if (!input && !scopes.length) continue;
        await this.draw(pitch, scopes);
        count++;
      } catch (error) {
        failures.push({ number: pitch.number, code: error instanceof ShapeUpError ? error.code : 'unexpected' });
      }
    }
    if (failures.length) throw new ShapeUpError('rebuild', `Some pitches were not redrawn: ${failures.map(f => `#${f.number} (${f.code})`).join(', ')}.`);
    return count;
  }
}
