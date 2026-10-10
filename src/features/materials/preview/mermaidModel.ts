/** A light reader for the six Mermaid types that card previews draw
 * (flowchart, sequence, state, pie, timeline, mindmap). It never loads
 * Mermaid: anything else, or source it cannot read, is `null` and the card
 * keeps its kind icon. */

export type FlowShape = 'rect' | 'round' | 'circle' | 'diamond';

export type MermaidModel =
  | { type: 'mindmap'; root: string; children: string[] }
  | {
      type: 'flowchart';
      direction: 'TD' | 'LR';
      nodes: { id: string; label: string; shape: FlowShape }[];
      edges: { from: string; to: string; label?: string }[];
    }
  | {
      type: 'sequence';
      actors: string[];
      messages: { from: number; to: number; text: string }[];
    }
  | { type: 'state'; title?: string; states: string[] }
  | { type: 'pie'; slices: { label: string; value: number }[] }
  | { type: 'timeline'; events: { period: string; text: string }[] };

const HEADER = {
  flowchart: /^(?:flowchart|graph)\b\s*([A-Za-z]{2})?/,
  mindmap: /^mindmap\b/,
  pie: /^pie\b/,
  sequence: /^sequenceDiagram\b/,
  state: /^stateDiagram(?:-v2)?\b/,
  timeline: /^timeline\b/,
};

export function parseMermaidPreview(source: string): MermaidModel | null {
  const { lines, title } = readLines(source);
  const header = lines[0]?.trim() ?? '';
  const body = lines.slice(1);
  if (HEADER.mindmap.test(header)) return mindmap(body);
  const flow = HEADER.flowchart.exec(header);
  if (flow) return flowchart(flow[1], body);
  if (HEADER.sequence.test(header)) return sequence(body);
  if (HEADER.state.test(header)) return state(body, title);
  if (HEADER.pie.test(header)) return pie(body);
  if (HEADER.timeline.test(header)) return timeline(body);
  return null;
}

const NEWLINES = /\r\n?/g;
const TITLE = /^\s*title:\s*(.+)$/;

/** Non-blank lines without comments, directives or the front matter, whose
 * `title:` is kept. */
function readLines(source: string): { lines: string[]; title?: string } {
  let raw = source.replace(NEWLINES, '\n').split('\n');
  let title: string | undefined;
  const start = raw.findIndex((line) => line.trim());
  if (raw[start]?.trim() === '---') {
    const end = raw.findIndex((line, i) => i > start && line.trim() === '---');
    if (end < 0) return { lines: [] };
    for (const line of raw.slice(start + 1, end)) {
      const match = TITLE.exec(line);
      if (match) title = unquote(match[1]);
    }
    raw = raw.slice(end + 1);
  }
  return {
    lines: raw.filter((line) => line.trim() && !line.trim().startsWith('%%')),
    title,
  };
}

const QUOTED = /^"(.*)"$/s;
const BACKTICKED = /^`(.*)`$/s;
const LINE_BREAK = /<br\s*\/?>/gi;

function unquote(text: string): string {
  return text
    .trim()
    .replace(QUOTED, '$1')
    .replace(BACKTICKED, '$1')
    .replace(LINE_BREAK, ' ')
    .trim();
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const CLASS_SUFFIX = /:::[\w-]+$/;

/* ---------------- mindmap ---------------- */

const MINDMAP_SHAPE =
  /^[^\s([{)]*\s*(?:\(\(|\)\)|\{\{|\(|\)|\[)(.*?)(?:\)\)|\(\(|\}\}|\)|\(|\])$/;
const MINDMAP_DECORATION = /^\s*(::icon|:::)/;
const MINDMAP_CLASS = /:::.*$/;

function mindmapLabel(line: string): string {
  const text = line.trim().replace(MINDMAP_CLASS, '');
  return unquote(MINDMAP_SHAPE.exec(text)?.[1] ?? text);
}

function mindmap(body: string[]): MermaidModel | null {
  const nodes = body.filter((line) => !MINDMAP_DECORATION.test(line));
  if (!nodes.length) return null;
  const rootIndent = indentOf(nodes[0]);
  const rest = nodes.slice(1).filter((line) => indentOf(line) > rootIndent);
  const childIndent = Math.min(...rest.map(indentOf));
  return {
    children: rest
      .filter((line) => indentOf(line) === childIndent)
      .map(mindmapLabel),
    root: mindmapLabel(nodes[0]),
    type: 'mindmap',
  };
}

/* ---------------- flowchart ---------------- */

const FLOW_SKIP =
  /^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/;
const NODE_ID = /^[\p{L}\p{N}_]+/u;
const NODE_CLASS = /^:::[\w-]+/;
const AMPERSAND = /^\s*&\s*/;
const LEFT_TO_RIGHT = /^(LR|RL)$/i;
/** Openers longest first, each with its closer and drawn shape. */
const OPENERS: [string, string, FlowShape][] = [
  ['(((', ')))', 'circle'],
  ['((', '))', 'circle'],
  ['([', '])', 'round'],
  ['[(', ')]', 'rect'],
  ['[[', ']]', 'rect'],
  ['{{', '}}', 'rect'],
  ['[/', '/]', 'rect'],
  ['[\\', '\\]', 'rect'],
  ['(', ')', 'round'],
  ['[', ']', 'rect'],
  ['{', '}', 'diamond'],
  ['>', ']', 'rect'],
];
/** `-->`, `---`, `-.->`, `==>`, `--x`, `-- text -->`, `-. text .->`, then an
 * optional `|label|`. */
const LINK =
  /^\s*<?(?:(?:--|==|-\.)\s+([^-=.>|\s][^>]*?)\s*(?:--+|==+|\.+-)|--+|==+|-\.+-?|~~~)[>xo]?\s*(?:\|([^|]*)\|)?\s*/;

type FlowNode = { id: string; label?: string; shape: FlowShape };

/** One node reference at the start of `text`, or null when it is malformed
 * (an unclosed shape). */
function readNode(text: string): { node: FlowNode; rest: string } | null {
  const id = NODE_ID.exec(text)?.[0];
  if (!id) return null;
  let rest = text.slice(id.length);
  const opener = OPENERS.find(([open]) => rest.startsWith(open));
  let node: FlowNode = { id, shape: 'rect' };
  if (opener) {
    const [open, close, shape] = opener;
    const inner = rest.slice(open.length);
    // A quoted label may hold brackets of its own.
    const quoteEnd = inner.startsWith('"') ? inner.indexOf('"', 1) : 0;
    if (quoteEnd < 0) return null;
    const end = inner.indexOf(close, quoteEnd);
    if (end < 0) return null;
    node = { id, label: unquote(inner.slice(0, end)), shape };
    rest = inner.slice(end + close.length);
  }
  return { node, rest: rest.replace(NODE_CLASS, '') };
}

/** `A & B` */
function readGroup(text: string): { nodes: FlowNode[]; rest: string } | null {
  const nodes: FlowNode[] = [];
  let rest = text;
  for (;;) {
    const read = readNode(rest.trimStart());
    if (!read) return null;
    nodes.push(read.node);
    const amp = AMPERSAND.exec(read.rest);
    if (!amp) return { nodes, rest: read.rest };
    rest = read.rest.slice(amp[0].length);
  }
}

function flowchart(direction: string | undefined, body: string[]) {
  const nodes = new Map<string, { label: string; shape: FlowShape }>();
  const edges: { from: string; to: string; label?: string }[] = [];
  const add = (node: FlowNode) => {
    const known = nodes.get(node.id);
    if (!known || node.label !== undefined)
      nodes.set(node.id, {
        label: node.label ?? known?.label ?? node.id,
        shape: node.label === undefined ? (known?.shape ?? 'rect') : node.shape,
      });
  };
  const statements = body.flatMap((line) => line.split(';'));
  for (const raw of statements) {
    const statement = raw.trim();
    if (!statement || FLOW_SKIP.test(statement)) continue;
    let group = readGroup(statement);
    if (!group) return null;
    group.nodes.forEach(add);
    while (group.rest.trim()) {
      const link = LINK.exec(group.rest);
      if (!link) return null;
      const label = unquote(link[2] ?? link[1] ?? '') || undefined;
      const next = readGroup(group.rest.slice(link[0].length));
      if (!next) return null;
      next.nodes.forEach(add);
      for (const from of group.nodes)
        for (const to of next.nodes)
          edges.push({ from: from.id, label, to: to.id });
      group = next;
    }
  }
  if (!nodes.size) return null;
  return {
    direction: direction && LEFT_TO_RIGHT.test(direction) ? 'LR' : 'TD',
    edges,
    nodes: [...nodes].map(([id, node]) => ({ id, ...node })),
    type: 'flowchart',
  } satisfies MermaidModel;
}

/* ---------------- sequence ---------------- */

const SEQ_SKIP =
  /^(autonumber|title|activate|deactivate|note|loop|alt|else|opt|par|and|critical|option|break|rect|end|box|destroy|links?|properties|details)\b/i;
const SEQ_CREATE = /^create\s+/;
const PARTICIPANT = /^(?:participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/;
const MESSAGE =
  /^(.+?)\s*<{0,2}-{1,2}(?:>>|>|x|\))\s*[+-]?\s*(.+?)\s*(?::\s*(.*))?$/;

function sequence(body: string[]): MermaidModel | null {
  const actors: string[] = [];
  const labels = new Map<string, string>();
  const index = (id: string) => {
    let at = actors.indexOf(id);
    if (at < 0) at = actors.push(id) - 1;
    return at;
  };
  const messages: { from: number; to: number; text: string }[] = [];
  for (const raw of body) {
    const line = raw.trim().replace(SEQ_CREATE, '');
    const participant = PARTICIPANT.exec(line);
    if (participant) {
      const id = unquote(participant[1]);
      index(id);
      if (participant[2]) labels.set(id, unquote(participant[2]));
      continue;
    }
    if (SEQ_SKIP.test(line)) continue;
    const message = MESSAGE.exec(line);
    if (!message) return null;
    messages.push({
      from: index(unquote(message[1])),
      text: (message[3] ?? '').trim(),
      to: index(unquote(message[2])),
    });
  }
  if (!actors.length) return null;
  return {
    actors: actors.map((id) => labels.get(id) ?? id),
    messages,
    type: 'sequence',
  };
}

/* ---------------- state ---------------- */

const STATE_SKIP = /^(note|direction|classDef|class|--|}|\[\*\]\s*$)/;
const NOTE_START = /^note\b/;
const STATE_ALIAS = /^state\s+"(.+)"\s+as\s+(\S+)/;
const STATE_DECLARED = /^state\s+(\S+?)(?:\s*<<\w+>>)?\s*\{?$/;
const TRANSITION = /^(.+?)\s*-->\s*(.+?)(?:\s*:.*)?$/;
const DESCRIBED = /^([^\s:]+)\s*:/;
const BARE_STATE = /^[^\s:]+$/;

function state(body: string[], title?: string): MermaidModel | null {
  const states: string[] = [];
  const labels = new Map<string, string>();
  const add = (raw: string) => {
    const id = raw.trim().replace(CLASS_SUFFIX, '');
    if (id && id !== '[*]' && !states.includes(id)) states.push(id);
  };
  let note = false;
  for (const raw of body) {
    const line = raw.trim();
    // A multi-line note runs to `end note`.
    if (note || (NOTE_START.test(line) && !line.includes(':'))) {
      note = line !== 'end note';
      continue;
    }
    if (STATE_SKIP.test(line)) continue;
    const alias = STATE_ALIAS.exec(line);
    if (alias) {
      labels.set(alias[2], alias[1]);
      add(alias[2]);
      continue;
    }
    const declared = STATE_DECLARED.exec(line);
    if (declared) {
      add(declared[1]);
      continue;
    }
    const transition = TRANSITION.exec(line);
    if (transition) {
      add(transition[1]);
      add(transition[2]);
      continue;
    }
    const described = DESCRIBED.exec(line);
    if (described) {
      add(described[1]);
      continue;
    }
    if (BARE_STATE.test(line)) add(line);
    else return null;
  }
  if (!states.length) return null;
  return {
    states: states.map((id) => labels.get(id) ?? id),
    title,
    type: 'state',
  };
}

/* ---------------- pie ---------------- */

const PIE_SKIP = /^(title|showData|accTitle|accDescr)\b/;
const SLICE = /^"(.+)"\s*:\s*(\d+(?:\.\d+)?)$/;

function pie(body: string[]): MermaidModel | null {
  const slices: { label: string; value: number }[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (PIE_SKIP.test(line)) continue;
    const slice = SLICE.exec(line);
    if (!slice) return null;
    const value = Number(slice[2]);
    if (value > 0) slices.push({ label: slice[1].trim(), value });
  }
  return slices.length ? { slices, type: 'pie' } : null;
}

/* ---------------- timeline ---------------- */

const TIMELINE_SKIP = /^(title|section|accTitle|accDescr)\b/;
/** Events after the period split on a colon followed by a space. */
const EVENT_SPLIT = /:\s/;

function timeline(body: string[]): MermaidModel | null {
  const events: { period: string; text: string }[] = [];
  for (const raw of body) {
    const line = raw.trim();
    if (TIMELINE_SKIP.test(line)) continue;
    // `: event` continues the previous period.
    if (line.startsWith(':')) continue;
    const at = line.indexOf(':');
    const period = (at < 0 ? line : line.slice(0, at)).trim();
    const text =
      at < 0
        ? ''
        : line
            .slice(at + 1)
            .split(EVENT_SPLIT)[0]
            .trim();
    events.push({ period, text });
  }
  return events.length ? { events, type: 'timeline' } : null;
}
