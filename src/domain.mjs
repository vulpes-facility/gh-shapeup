export class ShapeUpError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ShapeUpError';
    this.code = code;
  }
}

export const hillStart = '<!-- hill:start -->';
export const hillEnd = '<!-- hill:end -->';

export function validPosition(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

export function requirePosition(value) {
  if (!validPosition(value)) {
    throw new ShapeUpError('position', 'Hill Position must be an integer from 0 to 100.');
  }
  return value;
}

// A position given as text, on the command line or as an Action input.
export function parsePosition(text) {
  if (!/^[0-9]{1,3}$/.test(text)) throw new ShapeUpError('position', 'Hill Position must be an integer from 0 to 100.');
  return requirePosition(Number(text));
}

// An empty Hill Position counts as 0, both when drawing and when comparing.
export const positionOf = value => requirePosition(value ?? 0);

export function requireType(issue, type, config) {
  const labels = new Set(issue.labels.map(label => label.name));
  if (!labels.has(config[`${type}Label`]) ||
      labels.has(config[type === 'scope' ? 'pitchLabel' : 'scopeLabel'])) {
    throw new ShapeUpError('type', type === 'scope'
      ? 'The hill chart only draws issues that carry the scope label and not the pitch label.'
      : 'The parent issue must carry the pitch label and not the scope label.');
  }
}

// Markers count only on their own line, so a sentence that quotes them is left alone.
const blockPattern = /^<!-- hill:start -->\n([\s\S]*?)^<!-- hill:end -->$/m;
const valuesPattern = /^<!-- hill:values((?: [1-9][0-9]*=[0-9]{1,3})*) -->$/m;

export function drawnValues(body) {
  const block = blockPattern.exec(String(body ?? '').replace(/\r\n/g, '\n'));
  const values = block && valuesPattern.exec(block[1]);
  if (!values) return null;
  return new Map(values[1].trim().split(' ').filter(Boolean).map(pair => pair.split('=').map(Number)));
}

export function sameValues(drawn, scopes) {
  return drawn !== null && drawn.size === scopes.length &&
    scopes.every(scope => drawn.get(scope.number) === scope.position);
}

export function chartUrl(repository, branch, pitchNumber, sha) {
  // Absolute, because the Projects side panel resolves a relative link against the project page.
  return `https://github.com/${repository}/blob/${branch}/hills/pitch-${pitchNumber}.svg?raw=true&v=${String(sha).slice(0, 7)}`;
}

export function hillBlock(url, scopes, alt = 'Hill chart') {
  const values = [...scopes].sort((a, b) => a.number - b.number)
    .map(scope => ` ${scope.number}=${scope.position}`).join('');
  return `![${alt}](${url})\n<!-- hill:values${values} -->`;
}

export function withHill(body, block) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const section = `${hillStart}\n${block}\n${hillEnd}`;
  if (blockPattern.test(text)) return text.replace(blockPattern, () => section);
  return `${section}\n\n${text}`;
}

export function escapeXml(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '�')
    .replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    })[character]);
}

// A normal curve centred on 50 with 0 and 100 three standard deviations out, lowered so both ends meet the baseline.
const bell = position => Math.exp(-((position - 50) ** 2) / (2 * (50 / 3) ** 2));

export function pointAt(position) {
  requirePosition(position);
  const height = (bell(position) - bell(0)) / (1 - bell(0));
  return { x: 80 + position * 10.4, y: Number((342 - 230 * height).toFixed(3)) };
}

const ellipsis = (text, limit) => {
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : text;
};

// Joins ascending legend numbers into runs, as in "1, 4, 7–9"; past the limit the rest become "+N".
export function badgeLabel(numbers, limit = 24) {
  const runs = [];
  for (const number of numbers) {
    const last = runs.at(-1);
    if (last && number === last.to + 1) last.to = number;
    else runs.push({ from: number, to: number });
  }
  const tokens = runs.flatMap(({ from, to }) => to - from >= 2 ? [{ text: `${from}–${to}`, count: to - from + 1 }]
    : Array.from({ length: to - from + 1 }, (_, i) => ({ text: `${from + i}`, count: 1 })));
  let label = '', shown = 0;
  for (const token of tokens) {
    const next = label ? `${label}, ${token.text}` : token.text;
    if (label && next.length > limit) break;
    label = next;
    shown += token.count;
  }
  return shown < numbers.length ? `${label} +${numbers.length - shown}` : label;
}

// Names live in non-overlapping legend rows; badges retain the exact curve position.
export function renderHill(pitch, inputScopes) {
  const scopes = [...inputScopes].sort((a, b) => a.number - b.number);
  const height = Math.max(500, 455 + scopes.length * 38);
  const colors = ['#136f63', '#ab4600', '#3f58a8', '#923a78', '#696400', '#096a91'];
  const curve = Array.from({ length: 101 }, (_, n) => {
    const point = pointAt(n);
    return `${n ? 'L' : 'M'}${point.x.toFixed(1)},${point.y}`;
  }).join(' ');
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${escapeXml(`Hill Chart · Pitch #${pitch.number} · ${pitch.title}`)}</title>`,
    '<desc id="desc">The left side is figuring things out and the right side is making it happen. The numbered legend lists every scope and its position.</desc>',
    `<rect width="1200" height="${height}" rx="16" fill="#fbfaf6"/>`,
    '<g font-family="sans-serif" fill="#263a38">',
    `<text x="42" y="38" font-size="16" fill="#526d67">SHAPE UP / HILL CHART · PITCH #${pitch.number}</text>`,
    `<text x="42" y="76" font-size="25" font-weight="700"><title>${escapeXml(pitch.title)}</title>${escapeXml(ellipsis(pitch.title, 46))}</text>`,
    '<line x1="600" y1="100" x2="600" y2="356" stroke="#a4b3ab" stroke-dasharray="5 7"/>',
    `<path d="${curve}" fill="none" stroke="#78938a" stroke-width="3"/>`,
    '<text x="80" y="380" font-size="17">Figuring things out</text>',
    '<text x="1120" y="380" text-anchor="end" font-size="17">Making it happen</text>',
  ];
  const color = index => colors[index % colors.length];
  const full = scope => `#${scope.number} ${scope.title} · ${scope.position}`;
  // Scopes at the same position share one badge that lists their legend numbers.
  const groups = [];
  scopes.forEach((scope, index) => {
    const group = groups.find(candidate => candidate.position === scope.position);
    if (group) group.members.push({ scope, index });
    else groups.push({ position: scope.position, members: [{ scope, index }] });
  });
  // Allocate a fixed-height badge lane for nearby groups, without moving their dots.
  // Connectors are drawn before every badge, so no connector crosses a badge.
  const connectors = [], badges = [], occupied = [];
  for (const group of groups) {
    const point = pointAt(group.position);
    const label = badgeLabel(group.members.map(member => member.index + 1));
    // Commas and spaces are about half as wide as digits in a 12px sans-serif face.
    const width = Math.max(22, Math.ceil(Array.from(label).reduce((sum, c) => sum + (', '.includes(c) ? 3.4 : 6.8), 0)) + 14);
    const x = Math.min(Math.max(point.x, 42 + width / 2), 1158 - width / 2);
    let lane = 0;
    while (occupied.some(badge => badge.lane === lane && Math.abs(badge.x - x) < (badge.width + width) / 2 + 10)) lane++;
    occupied.push({ x, width, lane });
    // Clear the curve across the badge's whole width, not only at its own dot.
    const edges = [x - width / 2, x + width / 2];
    const ys = [point.y, ...edges.map(edge => pointAt(Math.round(Math.min(100, Math.max(0, (edge - 80) / 10.4)))).y),
      ...(edges[0] < 600 && edges[1] > 600 ? [pointAt(50).y] : [])];
    // Crowded spots use the legend as the unambiguous label once lanes reach the header.
    const above = Math.min(...ys) - 22 - lane * 26;
    const badgeY = above >= 100 ? above : Math.max(...ys) + 22 + lane * 26;
    if (badgeY > 335) continue;
    const fill = group.members.length === 1 ? color(group.members[0].index) : '#526d67';
    connectors.push(`<line x1="${point.x}" y1="${point.y + (badgeY > point.y ? 7 : -7)}" x2="${x}" y2="${badgeY}" stroke="${fill}" opacity="0.5"/>`);
    badges.push(`<g><title>${escapeXml(group.members.map(member => full(member.scope)).join('\n'))}</title><rect x="${x - width / 2}" y="${badgeY - 11}" width="${width}" height="22" rx="11" fill="${fill}"/><text x="${x}" y="${badgeY + 4}" text-anchor="middle" font-size="12" fill="white">${label}</text></g>`);
  }
  parts.push(...connectors);
  scopes.forEach((scope, index) => {
    const point = pointAt(scope.position);
    parts.push(`<circle data-scope="${scope.number}" data-position="${scope.position}" cx="${point.x}" cy="${point.y}" r="7" fill="${color(index)}" stroke="#fff" stroke-width="2"><title>${escapeXml(full(scope))}</title></circle>`);
  });
  parts.push(...badges);
  scopes.forEach((scope, index) => {
    const y = 454 + index * 38;
    parts.push(`<g><title>${escapeXml(full(scope))}</title><circle cx="55" cy="${y - 5}" r="12" fill="${color(index)}"/><text x="55" y="${y - 1}" text-anchor="middle" font-size="12" fill="white">${index + 1}</text><text x="80" y="${y}" font-size="17">${escapeXml(ellipsis(`#${scope.number} ${scope.title}`, 53))}</text><text x="1145" y="${y}" text-anchor="end" font-size="17" font-weight="700">${scope.position}</text></g>`);
  });
  if (!scopes.length) parts.push('<text x="42" y="455" font-size="17">No scopes yet.</text>');
  parts.push('</g></svg>');
  return `${parts.join('\n')}\n`;
}
