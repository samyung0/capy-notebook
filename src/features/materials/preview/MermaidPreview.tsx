import { type ReactNode, useMemo } from 'react';
import { type MermaidModel, parseMermaidPreview } from './mermaidModel';
import './livePreview.css';

/** Card drawings of the six supported Mermaid types on the 240×165 preview
 * canvas, in the approved mock's styles. Parsing and layout run once per
 * source in a memo; the viewBox does the scaling. Unsupported or unreadable
 * source has no drawing, so the caller shows the kind icon as for any
 * failed preview. */

const W = 240;
const H = 165;
const PALETTE = [
  'peach',
  'yellow',
  'green',
  'mauve',
  'sky',
  'red',
  'blue',
  'teal',
].map((name) => `var(--ctp-${name})`);
const color = (index: number) => PALETTE[index % PALETTE.length];

/** The drawing for `source`, or null when there is none to draw. */
export function useMermaidDrawing(source: string | undefined): ReactNode {
  return useMemo(() => {
    const model = source ? parseMermaidPreview(source) : null;
    return model ? draw(model) : null;
  }, [source]);
}

export function MermaidPreview({ drawing }: { drawing: ReactNode }) {
  return (
    <svg
      aria-hidden
      className="pv-svg"
      preserveAspectRatio="xMidYMid slice"
      viewBox={`0 0 ${W} ${H}`}
    >
      {drawing}
    </svg>
  );
}

function draw(model: MermaidModel): ReactNode {
  switch (model.type) {
    case 'mindmap':
      return mindmap(model.root, model.children);
    case 'flowchart':
      return flowchart(model);
    case 'sequence':
      return sequence(model.actors, model.messages);
    case 'state':
      return cycle(model.states, model.title);
    case 'pie':
      return pie(model.slices);
    case 'timeline':
      return timeline(model.events);
  }
}

/* ---------------- text and arrows ---------------- */

/** Wide (CJK and fullwidth) characters take a whole em, others about half. */
function charWidth(char: string, size: number): number {
  return (char.codePointAt(0) ?? 0) >= 0x2e_80 ? size : size * 0.56;
}

function textWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) width += charWidth(char, size);
  return width;
}

/** `text` cut with an ellipsis to fit `max` px at `size`. */
function clip(text: string, size: number, max: number): string {
  if (textWidth(text, size) <= max) return text;
  let out = '';
  let width = charWidth('…', size);
  for (const char of text) {
    width += charWidth(char, size);
    if (width > max) break;
    out += char;
  }
  return `${out}…`;
}

function Label({
  x,
  y,
  size,
  children,
  muted,
  anchor = 'middle',
}: {
  x: number;
  y: number;
  size: number;
  children: string;
  muted?: boolean;
  anchor?: 'start' | 'middle' | 'end';
}) {
  return (
    <text
      className={muted ? 'pv-muted' : undefined}
      fontSize={size}
      textAnchor={anchor}
      x={x}
      y={y}
    >
      {children}
    </text>
  );
}

/** A filled arrowhead at (x, y), pointing away from (fromX, fromY). */
function Head({
  x,
  y,
  fromX,
  fromY,
}: {
  x: number;
  y: number;
  fromX: number;
  fromY: number;
}) {
  const angle = Math.atan2(y - fromY, x - fromX);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const back = 5;
  const half = 3;
  const points = [
    [x, y],
    [x - back * cos - half * sin, y - back * sin + half * cos],
    [x - back * cos + half * sin, y - back * sin - half * cos],
  ]
    .map((point) => point.map((value) => value.toFixed(1)).join(','))
    .join(' ');
  return <polygon className="pv-head" points={points} />;
}

function Arrow({
  x1,
  y1,
  x2,
  y2,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}) {
  return (
    <>
      <line className="pv-edge" x1={x1} x2={x2} y1={y1} y2={y2} />
      <Head fromX={x1} fromY={y1} x={x2} y={y2} />
    </>
  );
}

const spread = (count: number, from: number, to: number) =>
  Array.from({ length: count }, (_, i) =>
    count === 1 ? (from + to) / 2 : from + ((to - from) * i) / (count - 1)
  );

/* ---------------- mindmap ---------------- */

const pillWidth = (text: string, size: number) => textWidth(text, size) + 14;

function mindmap(root: string, all: string[]): ReactNode {
  const children = all.slice(0, 8);
  const wide = children.length > 6;
  const [cx, cy, rx, ry] = wide ? [120, 80, 92, 60] : [120, 80, 86, 56];
  const size = wide ? 8 : 9.5;
  const nodes = children.map((child, i) => {
    const angle = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / children.length;
    const label = clip(child, size, 86);
    const width = pillWidth(label, size);
    const x = Math.min(
      Math.max(cx + Math.cos(angle) * rx, width / 2 + 4),
      W - 4 - width / 2
    );
    const y = Math.min(
      Math.max(cy + Math.sin(angle) * ry, size + 2),
      H - size - 2
    );
    return { label, stroke: color(i), width, x, y };
  });
  const rootLabel = clip(root, 10.5, 110);
  const rootWidth = pillWidth(rootLabel, 10.5) + 6;
  return (
    <>
      {nodes.map((node) => (
        <path
          className="pv-branch"
          d={`M${cx} ${cy} Q ${(cx + node.x) / 2} ${cy}, ${node.x} ${node.y}`}
          key={node.label + node.x}
          style={{ stroke: node.stroke }}
        />
      ))}
      {nodes.map((node) => (
        <g key={node.label + node.y}>
          <rect
            className="pv-node"
            height={size * 2}
            rx={size}
            style={{ stroke: node.stroke }}
            width={node.width}
            x={node.x - node.width / 2}
            y={node.y - size}
          />
          <Label size={size} x={node.x} y={node.y + size * 0.36}>
            {node.label}
          </Label>
        </g>
      ))}
      <rect
        className="pv-root"
        height={26}
        rx={13}
        width={rootWidth}
        x={cx - rootWidth / 2}
        y={cy - 13}
      />
      <text
        className="pv-root-text"
        fontSize={10.5}
        textAnchor="middle"
        x={cx}
        y={cy + 3.8}
      >
        {rootLabel}
      </text>
    </>
  );
}

/* ---------------- flowchart ---------------- */

type Flow = Extract<MermaidModel, { type: 'flowchart' }>;
type Box = {
  label: string;
  diamond: boolean;
  rounded: boolean;
  stroke: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Ranks by longest path over the forward edges; edges into a node still on
 * the depth-first stack are back edges (loops), drawn as dashed curves. */
function rankNodes(flow: Flow) {
  const index = new Map(flow.nodes.map((node, i) => [node.id, i]));
  const edges = flow.edges.map((edge) => ({
    from: index.get(edge.from) ?? -1,
    label: edge.label,
    to: index.get(edge.to) ?? -1,
  }));
  const out = flow.nodes.map(() => [] as number[]);
  edges.forEach((edge, i) => {
    out[edge.from]?.push(i);
  });
  const state = new Uint8Array(flow.nodes.length);
  const back = new Set<number>();
  const visit = (node: number) => {
    state[node] = 1;
    for (const e of out[node]) {
      const next = edges[e].to;
      if (state[next] === 1) back.add(e);
      else if (state[next] === 0) visit(next);
    }
    state[node] = 2;
  };
  flow.nodes.forEach((_, node) => {
    if (state[node] === 0) visit(node);
  });
  const rank = new Array<number>(flow.nodes.length).fill(0);
  const indegree = new Array<number>(flow.nodes.length).fill(0);
  edges.forEach((edge, i) => {
    if (!back.has(i)) indegree[edge.to]++;
  });
  const queue = flow.nodes.map((_, i) => i).filter((i) => !indegree[i]);
  // The queue grows while it is walked, so every reachable node is ranked.
  for (const node of queue) {
    for (const e of out[node]) {
      if (back.has(e)) continue;
      const next = edges[e].to;
      rank[next] = Math.max(rank[next], rank[node] + 1);
      if (--indegree[next] === 0) queue.push(next);
    }
  }
  return { back, edges, rank };
}

function flowchart(flow: Flow): ReactNode {
  const vertical = flow.direction === 'TD';
  const { back, edges, rank } = rankNodes(flow);
  const maxLayers = vertical ? 5 : 4;
  const maxPerLayer = vertical ? 3 : 4;
  const layers = Array.from({ length: maxLayers }, (): number[] => []);
  flow.nodes.forEach((_, node) => {
    const layer = layers[rank[node]];
    if (layer && layer.length < maxPerLayer) layer.push(node);
  });
  const rows = layers.filter((layer) => layer.length);
  const nodeHeight = (node: number) =>
    flow.nodes[node].shape === 'diamond' ? (vertical ? 34 : 40) : 24;
  // Drop trailing layers until the column fits the canvas height.
  const layerHeight = (layer: number[]) => Math.max(...layer.map(nodeHeight));
  while (
    vertical &&
    rows.length > 1 &&
    rows.reduce((sum, layer) => sum + layerHeight(layer), 0) +
      4 * (rows.length - 1) >
      H - 20
  )
    rows.pop();

  const boxes = new Map<number, Box>();
  const place = (node: number, x: number, y: number, w: number) => {
    const { label, shape } = flow.nodes[node];
    boxes.set(node, {
      diamond: shape === 'diamond',
      h: nodeHeight(node),
      label,
      rounded: shape === 'round' || shape === 'circle',
      stroke: color(node),
      w,
      x,
      y,
    });
  };
  if (vertical) {
    const heights = rows.map(layerHeight);
    const total = heights.reduce((sum, h) => sum + h, 0);
    const gap =
      rows.length > 1 ? Math.min(13, (H - 20 - total) / (rows.length - 1)) : 0;
    let top = (H - total - gap * (rows.length - 1)) / 2;
    rows.forEach((layer, r) => {
      const w =
        layer.length === 1
          ? 124
          : Math.min(100, (220 - 8 * (layer.length - 1)) / layer.length);
      spread(
        layer.length,
        W / 2 - ((layer.length - 1) * (w + 8)) / 2,
        W / 2 + ((layer.length - 1) * (w + 8)) / 2
      ).forEach((x, i) => {
        place(layer[i], x, top + heights[r] / 2, w);
      });
      top += heights[r] + gap;
    });
  } else {
    const w = Math.min(70, (W - 16 - 18 * (rows.length - 1)) / rows.length);
    const xs = spread(
      rows.length,
      W / 2 - ((rows.length - 1) * (w + 18)) / 2,
      W / 2 + ((rows.length - 1) * (w + 18)) / 2
    );
    rows.forEach((layer, r) => {
      const step =
        layer.length > 1
          ? Math.min(80, (H - 20 - layerHeight(layer)) / (layer.length - 1))
          : 0;
      layer.forEach((node, i) => {
        const box = flow.nodes[node];
        const width =
          box.shape === 'diamond'
            ? w
            : Math.min(w, Math.max(36, textWidth(box.label, 9.5) + 16));
        place(node, xs[r], H / 2 + (i - (layer.length - 1) / 2) * step, width);
      });
    });
  }

  const lines: ReactNode[] = [];
  edges.forEach((edge, i) => {
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b || a === b) return;
    if (back.has(i)) {
      lines.push(<Loop a={a} b={b} key={i} vertical={vertical} />);
      return;
    }
    const [x1, y1, x2, y2] = vertical
      ? [a.x, a.y + a.h / 2, b.x, b.y - b.h / 2 - 1]
      : [a.x + a.w / 2, a.y, b.x - b.w / 2 - 1, b.y];
    lines.push(
      <g key={i}>
        <Arrow x1={x1} x2={x2} y1={y1} y2={y2} />
        {edge.label && (
          <Label
            anchor={vertical ? 'start' : 'middle'}
            muted
            size={8}
            x={vertical ? (x1 + x2) / 2 + 4 : (x1 + x2) / 2}
            y={vertical ? (y1 + y2) / 2 + 3 : (y1 + y2) / 2 - 4}
          >
            {clip(edge.label, 8, 40)}
          </Label>
        )}
      </g>
    );
  });
  return (
    <>
      {lines}
      {[...boxes].map(([node, box]) => (
        <FlowBox box={box} key={node} />
      ))}
    </>
  );
}

function FlowBox({ box }: { box: Box }) {
  const { x, y, w, h } = box;
  const size = box.diamond ? 9 : 9.5;
  return (
    <>
      {box.diamond ? (
        <polygon
          className="pv-node"
          points={`${x},${y - h / 2} ${x + w / 2},${y} ${x},${y + h / 2} ${x - w / 2},${y}`}
          style={{ stroke: box.stroke }}
        />
      ) : (
        <rect
          className="pv-node"
          height={h}
          rx={box.rounded ? h / 2 : 6}
          style={{ stroke: box.stroke }}
          width={w}
          x={x - w / 2}
          y={y - h / 2}
        />
      )}
      <Label size={size} x={x} y={y + size * 0.36}>
        {clip(box.label, size, box.diamond ? w * 0.62 : w - 8)}
      </Label>
    </>
  );
}

/** A dashed loop back to an earlier node, beside the column (TD) or under
 * the row (LR). */
function Loop({ a, b, vertical }: { a: Box; b: Box; vertical: boolean }) {
  if (vertical) {
    const [x1, y1, x2, y2] = [a.x + a.w / 2, a.y, b.x + b.w / 2 + 1, b.y];
    const cx = Math.min(W - 4, Math.max(x1, x2) + 28);
    return (
      <>
        <path
          className="pv-edge pv-dashed"
          d={`M${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
        />
        <Head fromX={cx} fromY={y2} x={x2} y={y2} />
      </>
    );
  }
  const [x1, y1, x2, y2] = [a.x, a.y + a.h / 2, b.x, b.y + b.h / 2 + 1];
  const cy = Math.min(H - 4, Math.max(y1, y2) + 26);
  return (
    <>
      <path
        className="pv-edge pv-dashed"
        d={`M${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`}
      />
      <Head fromX={x2} fromY={cy} x={x2} y={y2} />
    </>
  );
}

/* ---------------- sequence ---------------- */

const ACTOR_COLORS = ['mauve', 'sky', 'green', 'peach'].map(
  (name) => `var(--ctp-${name})`
);

function sequence(
  all: string[],
  allMessages: { from: number; to: number; text: string }[]
): ReactNode {
  const actors = all.slice(0, 4);
  const messages = allMessages
    .filter((m) => m.from < actors.length && m.to < actors.length)
    .slice(0, 5);
  const w = actors.length <= 3 ? 60 : 50;
  const xs = spread(actors.length, 10 + w / 2, W - 10 - w / 2);
  const step =
    messages.length > 1 ? Math.min(28, 100 / (messages.length - 1)) : 0;
  return (
    <>
      {actors.map((actor, i) => (
        <g key={actor + i}>
          <line
            className="pv-rule pv-dashed"
            x1={xs[i]}
            x2={xs[i]}
            y1={31}
            y2={158}
          />
          <rect
            className="pv-node"
            height={20}
            rx={6}
            style={{ stroke: ACTOR_COLORS[i] }}
            width={w}
            x={xs[i] - w / 2}
            y={10}
          />
          <Label size={9} x={xs[i]} y={23.2}>
            {clip(actor, 9, w - 6)}
          </Label>
        </g>
      ))}
      {messages.map((message, i) => {
        const y = 52 + i * step;
        const [a, b] = [xs[message.from], xs[message.to]];
        const self = message.from === message.to;
        const right = a < b;
        return (
          <g key={y}>
            {self ? (
              <>
                <path
                  className="pv-edge"
                  d={`M${a + 2} ${y - 6} h 14 v 10 h -11`}
                />
                <Head fromX={a + 16} fromY={y + 4} x={a + 3} y={y + 4} />
              </>
            ) : (
              <Arrow
                x1={a + (right ? 2 : -2)}
                x2={b + (right ? -4 : 4)}
                y1={y}
                y2={y}
              />
            )}
            {message.text && (
              <Label
                anchor={self ? 'start' : 'middle'}
                muted
                size={8.5}
                x={self ? a + 20 : (a + b) / 2}
                y={self ? y + 2 : y - 4}
              >
                {clip(message.text, 8.5, self ? 50 : Math.abs(b - a) - 6)}
              </Label>
            )}
          </g>
        );
      })}
    </>
  );
}

/* ---------------- state (cycle) ---------------- */

const STATE_COLORS = ['green', 'sky', 'yellow', 'red', 'mauve', 'peach'].map(
  (name) => `var(--ctp-${name})`
);

function cycle(all: string[], title?: string): ReactNode {
  const states = all.slice(0, 8);
  const compact = states.every((label) => textWidth(label, 11) <= 26);
  const [rx, ry] = states.length > 4 ? [86, 58] : [76, 56];
  return (
    <>
      <ellipse className="pv-rule pv-dashed" cx={120} cy={82} rx={rx} ry={ry} />
      {states.map((label, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / states.length;
        const x = 120 + Math.cos(angle) * rx;
        const y = 82 + Math.sin(angle) * ry;
        const stroke = STATE_COLORS[i % STATE_COLORS.length];
        if (compact)
          return (
            <g key={i}>
              <circle
                className="pv-node pv-thick"
                cx={x}
                cy={y}
                r={17}
                style={{ stroke }}
              />
              <Label size={11} x={x} y={y + 4}>
                {label}
              </Label>
            </g>
          );
        const text = clip(label, 9, 58);
        const w = textWidth(text, 9) + 14;
        const cx = Math.min(Math.max(x, w / 2 + 3), W - 3 - w / 2);
        return (
          <g key={i}>
            <rect
              className="pv-node"
              height={20}
              rx={10}
              style={{ stroke }}
              width={w}
              x={cx - w / 2}
              y={y - 10}
            />
            <Label size={9} x={cx} y={y + 3.2}>
              {text}
            </Label>
          </g>
        );
      })}
      {title && (
        <text
          className="pv-caption"
          fontSize={9.5}
          textAnchor="middle"
          x={120}
          y={86}
        >
          {clip(title, 9.5, 100)}
        </text>
      )}
    </>
  );
}

/* ---------------- pie ---------------- */

const PIE_COLORS = ['mauve', 'sky', 'peach', 'green', 'yellow'].map(
  (name) => `var(--ctp-${name})`
);

function pie(all: { label: string; value: number }[]): ReactNode {
  const total = all.reduce((sum, slice) => sum + slice.value, 0);
  const slices = all.slice(0, 5).map((slice, i) => ({
    ...slice,
    fill: PIE_COLORS[i],
    share: slice.value / total,
  }));
  const [cx, cy, r] = [74, 82, 54];
  let start = -Math.PI / 2;
  const top = 82 - slices.length * 11 + 9;
  return (
    <>
      {slices.map((slice, i) => {
        if (slice.share >= 1)
          return (
            <circle
              className="pv-slice"
              cx={cx}
              cy={cy}
              key={i}
              r={r}
              style={{ fill: slice.fill }}
            />
          );
        const end = start + slice.share * 2 * Math.PI;
        const d = `M${cx} ${cy} L${cx + r * Math.cos(start)} ${cy + r * Math.sin(start)} A${r} ${r} 0 ${slice.share > 0.5 ? 1 : 0} 1 ${cx + r * Math.cos(end)} ${cy + r * Math.sin(end)} Z`;
        start = end;
        return (
          <path
            className="pv-slice"
            d={d}
            key={i}
            style={{ fill: slice.fill }}
          />
        );
      })}
      {slices.map((slice, i) => {
        const y = top + i * 22;
        return (
          <g key={i}>
            <rect
              height={10}
              rx={3}
              style={{ fill: slice.fill }}
              width={10}
              x={146}
              y={y}
            />
            <Label anchor="start" size={9.5} x={162} y={y + 8.5}>
              {clip(slice.label, 9.5, 74)}
            </Label>
            <Label anchor="start" muted size={8} x={162} y={y + 18}>
              {`${Math.round(slice.share * 100)}%`}
            </Label>
          </g>
        );
      })}
    </>
  );
}

/* ---------------- timeline ---------------- */

function timeline(all: { period: string; text: string }[]): ReactNode {
  const events = all.slice(0, 5);
  const xs = spread(events.length, 34, 206);
  const room = events.length > 1 ? Math.min(100, 2 * (xs[1] - xs[0]) - 6) : 100;
  return (
    <>
      <line className="pv-rule pv-thick" x1={18} x2={222} y1={82} y2={82} />
      {events.map((event, i) => {
        const up = i % 2 === 0;
        return (
          <g key={xs[i]}>
            <circle className="pv-dot" cx={xs[i]} cy={82} r={5} />
            <text
              className="pv-strong"
              fontSize={10}
              textAnchor="middle"
              x={xs[i]}
              y={up ? 62 : 106}
            >
              {clip(event.period, 10, room)}
            </text>
            {event.text && (
              <Label muted size={8} x={xs[i]} y={up ? 50 : 118}>
                {clip(event.text, 8, room)}
              </Label>
            )}
          </g>
        );
      })}
    </>
  );
}
