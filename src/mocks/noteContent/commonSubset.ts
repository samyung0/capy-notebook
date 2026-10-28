import {
  createMaterialDocumentWithMetrics,
  type MaterialValue,
} from '@/features/materials/document';
import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import {
  bullet,
  callout,
  codeBlock,
  embeddedFlashcards,
  embeddedQuiz,
  heading,
  image,
  inlineEquation,
  link,
  numbered,
  p,
  quote,
  table,
  text,
  todo,
} from './helpers';

/**
 * The bench's common-subset note (todo-blocksuite-spike.md, "6. Measure"):
 * only the blocks both editors render for real — paragraphs, headings, lists,
 * code, tables, quotes, callouts, images, inline equations, links and
 * material refs — at the load-test note's size, so Plate and BlockSuite open,
 * type and scroll the same content. The load-test note also holds blocks
 * BlockSuite shows as placeholders (columns, TOC, Mermaid, video, equations).
 */
/** Filler paragraphs between two feature blocks, as the load-test note. */
const PADS_PER_SPICE = 16;
const SPICE_KINDS = 10;

const FILLER_UNIT =
  'chloroplasts capture light energy in the thylakoid membranes while the calvin cycle fixes carbon dioxide into sugars in the stroma. ';

function filler(charCount: number): string {
  return FILLER_UNIT.repeat(Math.ceil(charCount / FILLER_UNIT.length)).slice(
    0,
    charCount
  );
}

const CELL_IMAGE = 'asset_mock_cell_diagram';

function skeleton(noteId: string, readyText: string): MaterialValue {
  return [
    heading(1, readyText),
    p([
      text('Generated fixture with only the blocks both editors render: '),
      text('bold', { bold: true }),
      text(', '),
      text('italic', { italic: true }),
      text(', '),
      text('code', { code: true }),
      text(', a '),
      link('link', 'https://openstax.org/details/books/biology-2e'),
      text(' and '),
      inlineEquation('6CO_2 + 6H_2O \\rightarrow C_6H_{12}O_6 + 6O_2'),
      text('.'),
    ]),
    heading(2, 'Lists'),
    bullet('Bulleted pigment'),
    bullet('Nested pigment', 2),
    numbered('Numbered light reaction step'),
    todo('Checked lab item', true),
    todo('Open lab item'),
    quote('Light is the source of all the energy in the living world.'),
    callout('Info callout in the common-subset skeleton.', 'info'),
    callout('Warning callout in the common-subset skeleton.', 'warning'),
    codeBlock(
      [
        'def photosynthesis_rate(light: float) -> float:',
        '    return light * 0.04  # rough fixation',
      ],
      'python'
    ),
    table(
      ['Stage', 'Site', 'Output'],
      [
        ['Light reactions', 'Thylakoid', 'ATP, NADPH'],
        ['Calvin cycle', 'Stroma', 'G3P'],
      ]
    ),
    { ...image(CELL_IMAGE, 'cell.svg', 'A cell diagram'), id: 'img_common_0' },
    embeddedQuiz(noteId, 'mat_embed_perf_common_quiz', {
      questions: [
        {
          id: 'perf_common_q1',
          labels: 'letters',
          layout: 'paper',
          level: 'recall',
          parts: [
            {
              answer: {
                correct: [0],
                options: ['Chloroplast', 'Nucleus', 'Ribosome'],
                type: 'mcq',
              },
              blocks: [
                { text: 'Where does photosynthesis run?', type: 'text' },
              ],
              id: 'perf_common_q1:part',
              marks: 1,
              solution: [{ text: 'In the chloroplast.', type: 'text' }],
            },
          ],
          stem: [],
        },
      ],
    }),
    embeddedFlashcards(noteId, 'mat_embed_perf_common_cards', [
      {
        back: 'Ribulose bisphosphate',
        front: 'RuBP expands to?',
        id: 'fc_pc_1',
      },
    ]),
    heading(2, 'Bulk filler (size load)'),
  ];
}

function spice(index: number): MaterialValue {
  switch (index % SPICE_KINDS) {
    case 0:
      return [heading(3, `Filler section ${index}`)];
    case 1:
      return [bullet(`Spice bullet ${index}`), bullet(`Nested ${index}`, 2)];
    case 2:
      return [numbered(`Spice step ${index}`), todo(`Spice task ${index}`)];
    case 3:
      return [callout(`Spice callout ${index}: watch the units.`, 'success')];
    case 4:
      return [
        codeBlock([`# spice ${index}`, `rate_${index} = ${index} * 0.04`]),
      ];
    case 5:
      return [quote(`Spice quote ${index}: energy flows, matter cycles.`)];
    case 6:
      return [table(['Pigment', 'Peak'], [[`Chlorophyll ${index}`, '430 nm']])];
    case 7:
      return [
        {
          ...image(CELL_IMAGE, 'cell.svg', `Figure ${index}`),
          id: `img_common_${index}`,
        },
      ];
    case 8:
      return [
        p([
          text(`Inline spice ${index}: `, { italic: true }),
          inlineEquation(`k_{${index}}`),
          text(' see '),
          link('the source', `https://example.com/spice/${index}`),
          text('.'),
        ]),
      ];
    default:
      return [heading(2, `Filler chapter ${index}`)];
  }
}

const pad = (index: number, chars: number) =>
  p(`Pad ${index}. ${filler(chars)}`);

/** `PADS_PER_SPICE` pads, then one feature block, from `from` on. */
function cycle(from: number, chars: number): MaterialValue {
  const blocks: MaterialValue = [];
  for (let i = from; i < from + PADS_PER_SPICE; i += 1)
    blocks.push(pad(i, chars));
  blocks.push(...spice(from / PADS_PER_SPICE));
  return blocks;
}

/**
 * The common-subset note at `size` (the load-test note's content bytes and
 * node count): just under both, within a pad of the bytes. Like the load-test
 * builder it prices one cycle of every feature kind against the real
 * serializer and sizes the run arithmetically, so the 2 MB document is
 * serialized only a few times.
 */
export function buildCommonSubsetValue(
  noteId: string,
  readyText: string,
  size: { bytes: number; nodes: number }
): MaterialValue {
  const targetBytes = Math.min(
    size.bytes,
    MATERIAL_DOCUMENT_LIMITS.maxContentBytes
  );
  const nodeCap = Math.min(size.nodes, MATERIAL_DOCUMENT_LIMITS.maxNodes);
  const encoder = new TextEncoder();
  const measure = (candidate: MaterialValue) => {
    const { document, metrics } = createMaterialDocumentWithMetrics(candidate);
    return {
      bytes: encoder.encode(JSON.stringify(document)).byteLength,
      nodes: metrics.nodeCount,
      value: document.value,
    };
  };

  const value = skeleton(noteId, readyText);
  const base = measure(value);
  // Every spice kind once, with empty pads: the fixed cost of a cycle.
  const sample: MaterialValue = [];
  for (let k = 0; k < SPICE_KINDS; k += 1)
    sample.push(...cycle(k * PADS_PER_SPICE, 0));
  const sampled = measure([...value, ...sample]);
  const cycleNodes = (sampled.nodes - base.nodes) / SPICE_KINDS;
  const cycleBytes = (sampled.bytes - base.bytes) / SPICE_KINDS;

  const cycles = Math.max(1, Math.floor((nodeCap - base.nodes) / cycleNodes));
  const chars = Math.max(
    0,
    Math.floor(
      ((targetBytes - base.bytes) / cycles - cycleBytes) / PADS_PER_SPICE
    )
  );
  for (let c = 0; c < cycles; c += 1)
    value.push(...cycle(c * PADS_PER_SPICE, chars));

  let measured = measure(value);
  // Spice sizes vary by index: trim whole blocks from the end when over.
  while (measured.bytes > targetBytes || measured.nodes > nodeCap) {
    value.splice(
      value.length -
        Math.max(1, Math.ceil((measured.bytes - targetBytes) / (chars + 64)))
    );
    measured = measure(value);
  }
  return measured.value;
}
