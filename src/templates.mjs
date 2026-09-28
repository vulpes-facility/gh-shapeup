import { ShapeUpError } from './domain.mjs';

export const footnotesStart = '<!-- footnotes:start -->';
export const footnotesEnd = '<!-- footnotes:end -->';
export const footnoteTemplate = '<!-- [^name]: description -->';

const normalize = text => String(text ?? '').replace(/\r\n/g, '\n');

function frontMatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new ShapeUpError('template', 'The template has no front matter.');
  const value = key => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(match[1]);
    return line ? line[1].trim() : null;
  };
  const unquote = raw => (raw ?? '').replace(/^"(.*)"$/, '$1');
  const labels = [...(value('labels') ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1]);
  return { title: unquote(value('title')), labels, rest: text.slice(match[0].length) };
}

// A body is a preamble, ## sections in order, and a trailing footnote block.
export function parseBody(text) {
  const body = normalize(text);
  const footStart = body.lastIndexOf(`\n${footnotesStart}\n`);
  const head = footStart === -1 ? body : body.slice(0, footStart + 1);
  const foot = footStart === -1 ? null : body.slice(footStart + 1);
  const parts = head.split(/^## (.+)$/m);
  const preamble = parts[0];
  const sections = [];
  for (let i = 1; i < parts.length; i += 2) sections.push({ heading: parts[i].trim(), content: parts[i + 1].trim() });
  return { preamble, sections, footnotes: foot === null ? null : parseFootnotes(foot) };
}

export function parseFootnotes(block) {
  const notes = new Map();
  for (const line of normalize(block).split('\n')) {
    const match = /^\[\^([^\]\s]+)\]:\s?(.*)$/.exec(line);
    if (match) notes.set(match[1], match[2]);
  }
  return notes;
}

export function renderBody({ preamble, sections, footnotes }) {
  const lines = [preamble.trim()];
  for (const section of sections) lines.push(`## ${section.heading}\n\n${section.content}`.trimEnd());
  const notes = [...(footnotes ?? new Map())].map(([name, text]) => `[^${name}]: ${text}`);
  lines.push([footnotesStart, footnoteTemplate, ...notes, footnotesEnd].join('\n'));
  return `${lines.filter(Boolean).join('\n\n')}\n`;
}

export function loadTemplate(kind, spec, text) {
  if (!spec) throw new ShapeUpError('kind', `Unknown issue kind: ${kind}`);
  const { title, labels, rest } = frontMatter(normalize(text));
  const parsed = parseBody(rest);
  const headings = parsed.sections.map(section => section.heading);
  for (const heading of Object.values(spec.sections)) {
    if (!headings.includes(heading)) throw new ShapeUpError('template', `The template ${spec.template} has no "## ${heading}" section.`);
  }
  if (parsed.footnotes === null) throw new ShapeUpError('template', `The template ${spec.template} has no footnote markers.`);
  return { kind, spec, prefix: title, labels, ...parsed };
}

// A report template is its ## sections; without a template file, the config's headings are the template.
export function loadReport(kind, spec, text) {
  if (text === null) return { kind, spec, headings: [...spec.sections] };
  const headings = parseBody(text).sections.map(section => section.heading);
  for (const heading of spec.sections) {
    if (!headings.includes(heading)) throw new ShapeUpError('template', `The report template ${spec.template} has no "## ${heading}" section.`);
  }
  return { kind, spec, headings };
}

const visible = text => text.replace(/<!--[\s\S]*?-->/g, '').trim() !== '';

// A report has exactly the template's sections, in its order, each with more than guidance comments.
// It is posted as given, so nothing is reordered or dropped.
export function checkReport(template, text) {
  const report = parseBody(text);
  const listed = template.headings.map(heading => `## ${heading}`).join(', ');
  if (visible(report.preamble)) throw new ShapeUpError('input', `The report must start with its first section, "## ${template.headings[0]}".`);
  const headings = report.sections.map(section => section.heading);
  const missing = template.headings.find(heading => !headings.includes(heading));
  if (missing) throw new ShapeUpError('input', `The report has no "## ${missing}" section. It needs ${listed}.`);
  if (headings.join('\n') !== template.headings.join('\n')) {
    throw new ShapeUpError('input', `The report must have exactly these sections, in this order: ${listed}.`);
  }
  const empty = report.sections.find(section => !visible(section.content));
  if (empty) throw new ShapeUpError('input', `The report's "## ${empty.heading}" section is empty. Write what applies, or that nothing does.`);
  return text;
}

// Parameters that name a section fill it; a file given with --from supplies ## sections by heading.
export function sectionValues(spec, options, fromText) {
  const values = new Map();
  if (fromText !== undefined) {
    const byHeading = new Map(parseBody(fromText).sections.map(section => [section.heading, section.content]));
    for (const heading of Object.values(spec.sections)) {
      if (byHeading.has(heading)) values.set(heading, byHeading.get(heading));
    }
  }
  for (const [param, heading] of Object.entries(spec.sections)) {
    if (options[param] !== undefined) values.set(heading, String(options[param]).trim());
  }
  return values;
}

export function footnoteValues(list) {
  const notes = new Map();
  for (const item of list ?? []) {
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)=(.+)$/s.exec(item);
    if (!match) throw new ShapeUpError('input', `--footnote must look like name=description: ${item}`);
    notes.set(match[1], match[2].trim());
  }
  return notes;
}

export function composeBody(template, values, notes) {
  const missing = template.spec.required.filter(param => !values.get(template.spec.sections[param]));
  if (missing.length) throw new ShapeUpError('input', `Missing sections: ${missing.map(p => `--${p}`).join(', ')}`);
  const sections = template.sections.map(section => ({ heading: section.heading,
    content: values.get(section.heading) ?? section.content }));
  return renderBody({ preamble: template.preamble, sections, footnotes: notes });
}

// Editing keeps everything that is not named, including hill markers in the preamble.
export function editBody(body, values, notes) {
  const parsed = parseBody(body);
  for (const heading of values.keys()) {
    if (!parsed.sections.some(section => section.heading === heading)) {
      parsed.sections.push({ heading, content: '' });
    }
  }
  const sections = parsed.sections.map(section => ({ heading: section.heading,
    content: values.has(section.heading) ? values.get(section.heading) : section.content }));
  const footnotes = new Map(parsed.footnotes ?? []);
  for (const [name, text] of notes) footnotes.set(name, text);
  return renderBody({ preamble: parsed.preamble, sections, footnotes });
}

export function titleFor(template, title) {
  const text = String(title ?? '').trim();
  if (!text) throw new ShapeUpError('input', '--title is required.');
  return text.startsWith(template.prefix) ? text : `${template.prefix}${text}`;
}
