import { EMBED_CATALOG } from '@/api/embeds.generated';
import type { FlashcardContent } from '@/features/materials/blocks';
import type {
  ChartBlock,
  GraphBlock,
  GraphElement,
  PlotBlock,
  Question,
  QuestionPart,
} from '@/features/questions/types';
import nearLimitGraphSvg from './fixtures/near-limit-graph.svg?raw';

/* Embeds at their limits for the "Near-limit" files in Biology 101: every
 * count sits at its cap and every text at its length cap. Byte caps are met
 * from just under, and Mermaid (which has no cap of ours that draws) sits
 * just under mermaid.js's own 50,000 characters and 500 edges. Opening them
 * is slow on purpose: the diagrams take seconds to draw. */

const limits = EMBED_CATALOG.limits;
const WORDS =
  'osmosis diffusion membrane transport gradient protein channel carrier vesicle ribosome nucleus cytoplasm ';

/** `prefix` padded with biology words to exactly `length` characters. */
export function filled(prefix: string, length: number) {
  return (prefix + WORDS.repeat(Math.ceil(length / WORDS.length))).slice(
    0,
    length
  );
}

/** mermaid.js's own caps (its `maxTextSize` and `maxEdges` defaults): past
 * either it draws an error instead of the diagram. */
export const MERMAID_TEXT_MAX = 50_000;
export const MERMAID_EDGES_MAX = 500;

export function nearLimitFlowchart() {
  const nodes = 300;
  const lines = ['flowchart TD'];
  for (let i = 0; i < nodes; i++)
    lines.push(`  n${i}["${filled(`Step ${i}: `, 120)}"]`);
  let edges = 0;
  for (; edges < nodes - 1; edges++)
    lines.push(`  n${edges} --> n${edges + 1}`);
  for (let i = 0; edges < MERMAID_EDGES_MAX - 5; i++, edges++)
    lines.push(`  n${i % nodes} --> n${(i * 7 + 3) % nodes}`);
  return lines.join('\n');
}

export function nearLimitMindmap() {
  const lines = ['mindmap', '  root((Cell biology))'];
  for (let i = 0; i < 42; i++) {
    lines.push(`    Branch ${i}`);
    for (let j = 0; j < 20; j++)
      lines.push(`      ${filled(`Leaf ${i}.${j} `, 50)}`);
  }
  return lines.join('\n');
}

export const NEAR_LIMIT_CAPTION = filled(
  'Near-limit caption: ',
  limits.BLOCK_CAPTION_MAX
);
const DESCRIPTION = filled(
  'Near-limit description: ',
  limits.QUESTION_DESCRIPTION_MAX
);

export function nearLimitChart(): ChartBlock {
  const labels = Array.from(
    { length: limits.QUESTION_CHART_LABELS_MAX },
    (_, i) => filled(`Sample ${i + 1} `, limits.QUESTION_CHART_LABEL_MAX)
  );
  return {
    description: DESCRIPTION,
    gridlines: 'fine',
    kind: 'line',
    labels,
    series: Array.from(
      { length: limits.QUESTION_CHART_SERIES_MAX },
      (_, s) => ({
        name: filled(`Series ${s + 1} `, limits.QUESTION_CHART_SERIES_NAME_MAX),
        values: labels.map((_, i) =>
          Math.round(
            limits.QUESTION_CHART_VALUE_MAX *
              (0.5 + 0.45 * Math.sin((i + s * 8) / 6))
          )
        ),
      })
    ),
    title: filled('Near-limit chart ', limits.QUESTION_CHART_TITLE_MAX),
    type: 'chart',
    xTitle: filled('Sample ', limits.QUESTION_CHART_TITLE_MAX),
    yTitle: filled('Molecules ', limits.QUESTION_CHART_TITLE_MAX),
  };
}

export function nearLimitPlot(): PlotBlock {
  const points = limits.QUESTION_PLOT_POINTS_MAX;
  return {
    description: DESCRIPTION,
    kind: 'line',
    lines: Array.from({ length: limits.QUESTION_PLOT_MARKS_MAX }, (_, i) => ({
      axis: i % 2 ? 'y' : 'x',
      label: filled(`Line ${i + 1} `, limits.QUESTION_PLOT_LABEL_MAX),
      value: i % 2 ? i * 4 : i * 6,
    })),
    marks: Array.from({ length: limits.QUESTION_PLOT_MARKS_MAX }, (_, i) => ({
      label: filled(`Mark ${i + 1} `, limits.QUESTION_PLOT_LABEL_MAX),
      x: i * 7,
      y: 20 + 15 * Math.sin(i * 7 * 0.15),
    })),
    series: Array.from({ length: limits.QUESTION_PLOT_SERIES_MAX }, (_, s) => ({
      name: filled(`Curve ${s + 1} `, limits.QUESTION_PLOT_LABEL_MAX),
      points: Array.from({ length: points }, (_, i): [number, number] => [
        i,
        Math.round((20 + 15 * Math.sin(i * 0.15 + s) + s * 5) * 100) / 100,
      ]),
    })),
    title: filled('Near-limit plot ', limits.QUESTION_PLOT_TITLE_MAX),
    type: 'plot',
    unit: filled('µm ', limits.QUESTION_PLOT_TITLE_MAX),
    xTitle: filled('Time (s) ', limits.QUESTION_PLOT_TITLE_MAX),
    yTitle: filled('Concentration (mM) ', limits.QUESTION_PLOT_TITLE_MAX),
  };
}

/** The graph's recipe; its SVG is drawn from it by
 * `renderGraphSvg` into fixtures/near-limit-graph.svg. */
export function nearLimitGraphRecipe(): Omit<GraphBlock, 'image'> {
  const points = 30;
  const name = (i: number) => filled(`P${i} `, limits.QUESTION_GRAPH_NAME_MAX);
  const term = (k: number) => {
    let out = `${k}`;
    for (let n = 1; ; n++) {
      const next = `${out}+0.${n}*sin(${n}*x)`;
      if (next.length > limits.QUESTION_GRAPH_TERM_MAX) return out;
      out = next;
    }
  };
  const elements: GraphElement[] = [
    ...Array.from(
      { length: points },
      (_, i): GraphElement => ({
        coords: [
          Math.round(8 * Math.cos((i / points) * 2 * Math.PI) * 100) / 100,
          Math.round(8 * Math.sin((i / points) * 2 * Math.PI) * 100) / 100,
        ],
        id: `p${i}`,
        name: name(i),
        type: 'point',
      })
    ),
    {
      id: 'polygon',
      points: Array.from(
        { length: limits.QUESTION_GRAPH_POLYGON_MAX },
        (_, i) => `p${i}`
      ),
      shade: true,
      type: 'polygon',
    },
    ...Array.from(
      { length: 8 },
      (_, k): GraphElement => ({
        domain: [-10, 10],
        id: `f${k}`,
        term: term(k - 4),
        type: 'functiongraph',
      })
    ),
    ...Array.from(
      { length: 6 },
      (_, i): GraphElement => ({
        id: `s${i}`,
        points: [`p${12 + i}`, `p${18 + i}`],
        ticks: (i % 3) + 1,
        type: 'segment',
      })
    ),
    { center: 'p24', id: 'circle', radius: 1.5, type: 'circle' },
    { id: 'line', points: ['p25', 'p26'], type: 'line' },
    { center: 'p27', id: 'arc', points: ['p28', 'p29'], type: 'arc' },
    { center: 'p28', id: 'sector', points: ['p29', 'p0'], type: 'sector' },
    {
      id: 'angle',
      label: filled('θ ', limits.QUESTION_GRAPH_NAME_MAX),
      points: ['p1', 'p2', 'p3'],
      type: 'angle',
    },
  ];
  while (elements.length < limits.QUESTION_GRAPH_ELEMENTS_MAX) {
    const i = elements.length;
    elements.push({
      coords: [-9, 9 - (i % 10) * 1.6],
      id: `t${i}`,
      text: filled(`Label ${i} `, limits.QUESTION_GRAPH_LABEL_MAX),
      type: 'text',
    });
  }
  return {
    board: { axis: true, bbox: [-11, 11, 11, -11], grid: true },
    description: DESCRIPTION,
    elements,
    height: limits.QUESTION_GRAPH_DIMENSION_MAX,
    type: 'graph',
    width: limits.QUESTION_GRAPH_DIMENSION_MAX,
  };
}

export function nearLimitGraph(): GraphBlock {
  return { ...nearLimitGraphRecipe(), image: { svg: nearLimitGraphSvg } };
}

/** An interactive block just under HTML_EMBED_MAX_BYTES: a filterable table. */
export function nearLimitHtml(index = 0) {
  const head = [
    `<label>Filter: <input id="q${index}" placeholder="organelle"></label>`,
    `<table id="t${index}" style="width:100%;font:12px sans-serif"><tbody>`,
  ].join('\n');
  const tail = [
    '</tbody></table>',
    '<script>',
    `const q = document.getElementById('q${index}');`,
    `const rows = [...document.querySelectorAll('#t${index} tr')];`,
    'q.oninput = () => rows.forEach((r) => { r.hidden = !r.textContent.includes(q.value); });',
    '</script>',
  ].join('\n');
  const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
  const room = limits.HTML_EMBED_MAX_BYTES - 64 - bytes(head) - bytes(tail);
  const rows: string[] = [];
  for (let size = 0, i = 0; ; i++) {
    const row = `<tr><td>${i}</td><td>${filled(`Organelle ${i} `, 80)}</td></tr>\n`;
    if (size + bytes(row) > room) break;
    rows.push(row);
    size += bytes(row);
  }
  return `${head}\n${rows.join('')}${tail}`;
}

function nearLimitPart(id: string, index: number): QuestionPart {
  const text = (prompt: string) => [
    { text: `${prompt} (part ${index + 1})`, type: 'text' as const },
  ];
  switch (index % 5) {
    case 0:
      return {
        answer: {
          correct: [index % 4],
          options: ['Nucleus', 'Mitochondrion', 'Ribosome', 'Golgi body'],
          type: 'mcq',
        },
        blocks: text('Which organelle makes ATP?'),
        id,
        marks: 1,
        solution: [],
      };
    case 1:
      return {
        answer: { correct: index % 2 === 0, type: 'boolean' },
        blocks: text('Osmosis needs ATP.'),
        id,
        marks: 1,
        solution: [],
      };
    case 2:
      return {
        answer: { accepted: ['osmosis'], type: 'short' },
        blocks: text('Name the diffusion of water across a membrane.'),
        id,
        marks: 1,
        solution: [],
      };
    case 3:
      return {
        answer: { accepted: [['bilayer']], type: 'gaps' },
        blocks: text('The membrane is a phospholipid (1) ______'),
        id,
        marks: 1,
        solution: [],
      };
    default: {
      const items = limits.QUIZ_MARKSCHEME_MAX;
      return {
        answer: {
          accepted: [filled('Model answer: ', limits.QUIZ_OPEN_ANSWER_MAX)],
          hints: [],
          type: 'open',
        },
        blocks: text('Explain how the sodium-potassium pump keeps a gradient.'),
        id,
        marks: limits.QUESTION_MARKS_MAX,
        markscheme: Array.from({ length: items }, (_, i) => ({
          marks: limits.QUESTION_MARKS_MAX / items,
          text: filled(`Point ${i + 1}: `, 200),
        })),
        solution: [],
      };
    }
  }
}

/** QUIZ_PARTS_MAX parts, QUIZ_QUESTION_PARTS_MAX to a question, and every
 * fifth part open: QUIZ_OPEN_PARTS_MAX open parts in all. */
export function nearLimitQuestions(prefix: string): Question[] {
  const questions: Question[] = [];
  for (let part = 0; part < limits.QUIZ_PARTS_MAX; ) {
    const q = questions.length;
    const count = Math.min(
      limits.QUIZ_QUESTION_PARTS_MAX,
      limits.QUIZ_PARTS_MAX - part
    );
    questions.push({
      id: `${prefix}_q${q}`,
      labels: 'letters',
      layout: 'paper',
      parts: Array.from({ length: count }, (_, i) =>
        nearLimitPart(`${prefix}_q${q}:p${i}`, part + i)
      ),
      stem:
        q === 0
          ? [
              {
                text: filled('Read the passage. ', limits.QUESTION_TEXT_MAX),
                type: 'text',
              },
            ]
          : [],
    });
    part += count;
  }
  return questions;
}

/** Cards at both face caps, as many as fit just under the document size cap
 * (2 MiB of JSON: about 1,400 cards, 7,000 nodes). */
export function nearLimitCards(prefix: string): FlashcardContent[] {
  return Array.from({ length: 1400 }, (_, i) => ({
    back: filled(`Back ${i + 1}: `, limits.CARD_BACK_MAX),
    front: filled(`Front ${i + 1}: `, limits.CARD_FRONT_MAX),
    id: `${prefix}_${i}`,
  }));
}
