import {
  createMaterialDocumentWithMetrics,
  flashcardsNode,
  type MaterialValue,
  mermaidNode,
  quizNode,
} from '@/features/materials/document';
import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import {
  bullet,
  callout,
  codeBlock,
  columns,
  equation,
  heading,
  hr,
  inlineEquation,
  link,
  mention,
  numbered,
  p,
  quote,
  table,
  text,
  toc,
  todo,
  youtube,
} from './helpers';

/**
 * Near-2MB Biology note for document-size load testing.
 * Seeded only when VITE_LOAD_TEST_SEED=true (build is intentionally heavy).
 */
const TARGET_CONTENT_BYTES = Math.floor(
  MATERIAL_DOCUMENT_LIMITS.maxContentBytes * 0.95
);
const NODE_HEADROOM = 64;

const FILLER_UNIT =
  'mitochondria synthesize adenosine triphosphate across the inner membrane while enzymes regulate gradient flow during aerobic respiration cycles. ';

function filler(charCount: number): string {
  if (charCount <= 0) return '';
  return FILLER_UNIT.repeat(Math.ceil(charCount / FILLER_UNIT.length)).slice(
    0,
    charCount
  );
}

function featureSkeleton(): MaterialValue {
  return [
    heading(1, 'Load test — near 2MB feature soup'),
    toc(),
    p([
      text('Generated fixture for document-size load testing. Target ≈ '),
      text('1.9 MB', { bold: true }),
      text(' encoded JSON, under '),
      text(String(MATERIAL_DOCUMENT_LIMITS.maxNodes), { code: true }),
      text(' nodes. Excludes uploaded media ('),
      text('img', { code: true }),
      text('/'),
      text('audio', { code: true }),
      text('/'),
      text('file', { code: true }),
      text(').'),
    ]),
    heading(2, 'Marks & inlines'),
    p([
      text('bold', { bold: true }),
      text(' '),
      text('italic', { italic: true }),
      text(' '),
      text('underline', { underline: true }),
      text(' '),
      text('strike', { strikethrough: true }),
      text(' '),
      text('code', { code: true }),
      text(' '),
      text('kbd', { kbd: true }),
      text(' '),
      text('highlight', { highlight: true }),
      text(' H'),
      text('2', { subscript: true }),
      text('O E=mc'),
      text('2', { superscript: true }),
      text(' '),
      text('red', { color: '#dc2626' }),
      text(' '),
      text('tint', { backgroundColor: '#fef9c3' }),
      text(' '),
      text('big', { fontSize: '22px' }),
      text(' '),
      text('serif', { fontFamily: 'Georgia, serif' }),
      text(' '),
      link('OpenStax', 'https://openstax.org/details/books/biology-2e'),
      text(' '),
      mention('Kate Malone'),
      text(' '),
      inlineEquation('PV = nRT'),
    ]),
    p('Centered banner for alignment stress.', { align: 'center' }),
    p('Right-aligned caption.', { align: 'right' }),
    heading(3, 'Lists'),
    bullet('Bulleted organelle'),
    numbered('Numbered pathway step'),
    todo('Checked prep item', true),
    todo('Open prep item'),
    quote('Evolution is the light that makes biology coherent.'),
    hr(),
    callout('Info callout in the load-test skeleton.', 'info'),
    callout('Success callout in the load-test skeleton.', 'success'),
    callout('Warning callout in the load-test skeleton.', 'warning'),
    callout('Danger callout in the load-test skeleton.', 'danger'),
    codeBlock(
      [
        'def respiration_flux(glucose: float) -> float:',
        '    return glucose * 30  # rough ATP yield',
      ],
      'python'
    ),
    table(
      ['Stage', 'Site', 'Yield'],
      [
        ['Glycolysis', 'Cytosol', '2 ATP'],
        ['Krebs', 'Matrix', '2 ATP'],
        ['ETC', 'Inner membrane', '~28 ATP'],
      ]
    ),
    columns(
      ['50%', '50%'],
      [
        p([text('Column A', { bold: true }), text(' — structure')]),
        p([text('Column B', { bold: true }), text(' — function')]),
      ]
    ),
    equation('\\Delta G = \\Delta H - T\\Delta S'),
    youtube('URUJD5NEXC8'),
    mermaidNode(
      'flowchart LR\n  Glucose --> Pyruvate --> Krebs --> ATP',
      'Compact respiration map',
      'mermaid_bio_load_test'
    ),
    quizNode(
      {
        questions: [
          {
            correct: [1],
            explanation: 'Mitochondria produce most ATP.',
            id: 'bio_load_q1',
            level: 'recall',
            options: [
              { value: 'Nucleus' },
              { value: 'Mitochondria' },
              { value: 'Ribosome' },
            ],
            prompt: 'Primary ATP organelle?',
            type: 'mcq',
          },
        ],
      },
      'quiz_bio_load_test'
    ),
    flashcardsNode(
      [
        {
          back: 'Adenosine triphosphate',
          front: 'ATP expands to?',
          id: 'fc_bio_load_1',
        },
      ],
      'fcset_bio_load_test'
    ),
    heading(2, 'Bulk filler (size load)'),
    p(
      'Everything below exists to approach the content-byte ceiling while staying feature-mixed.'
    ),
  ];
}

function spiceBlock(index: number): MaterialValue {
  switch (index % 8) {
    case 0:
      return [heading(3, `Filler section ${index}`)];
    case 1:
      return [bullet(`Spice bullet ${index}: membrane transport reminder`)];
    case 2:
      return [callout(`Spice callout ${index}: watch tonicity units.`, 'info')];
    case 3:
      return [
        codeBlock(
          [`# spice ${index}`, `yield_${index} = ${index} * 30`],
          'python'
        ),
      ];
    case 4:
      return [equation(`x_${index} = \\sum_{n=1}^{N} a_n`)];
    case 5:
      return [
        p([
          text(`Inline spice ${index}: `, { italic: true }),
          inlineEquation(`k_${index}`),
          text(' rate constant.'),
        ]),
      ];
    case 6:
      return [quote(`Spice quote ${index}: energy flows, matter cycles.`)];
    default:
      return [hr()];
  }
}

function countNodes(nodes: MaterialValue): number {
  const walk = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0;
    const record = node as { children?: unknown; text?: unknown };
    if (typeof record.text === 'string' && !('children' in record)) return 1;
    if (!Array.isArray(record.children)) return 1;
    return (
      1 + record.children.reduce<number>((sum, child) => sum + walk(child), 0)
    );
  };
  return nodes.reduce((sum, node) => sum + walk(node), 0);
}

/**
 * Build a Biology load-test document near the 2MB content-byte limit while
 * staying under maxNodes. Feature blocks come first; large paragraphs supply size.
 */
export function buildBiologyLoadTestValue(
  targetBytes = TARGET_CONTENT_BYTES
): MaterialValue {
  const value: MaterialValue = featureSkeleton();
  const encoder = new TextEncoder();

  const measure = (candidate: MaterialValue) => {
    const { document, metrics } = createMaterialDocumentWithMetrics(candidate);
    return {
      bytes: encoder.encode(JSON.stringify(document)).byteLength,
      metrics,
      value: document.value,
    };
  };

  let measured = measure(value);
  const hardNodeCap = MATERIAL_DOCUMENT_LIMITS.maxNodes - NODE_HEADROOM;
  const nodesLeft = Math.max(0, hardNodeCap - measured.metrics.nodeCount);
  const spiceEvery = 16;
  const spiceNodeEstimate = 6;
  // Single-leaf paragraphs normalize to 2 nodes; reserve room for spice blocks.
  const tentativePads = Math.max(1, Math.floor(nodesLeft / 2));
  const spiceSlots = Math.floor(tentativePads / spiceEvery);
  const purePads = Math.max(
    1,
    Math.floor((nodesLeft - spiceSlots * spiceNodeEstimate) / 2)
  );
  const bytesNeeded = Math.max(0, targetBytes - measured.bytes);
  const overheadPerPad = 96;
  const charsPerPad = Math.max(
    512,
    Math.floor(bytesNeeded / purePads) - overheadPerPad
  );

  let runningNodes = countNodes(value);

  for (let i = 0; i < purePads; i += 1) {
    if (i > 0 && i % spiceEvery === 0) {
      const spice = spiceBlock(i);
      const spiceNodes = countNodes(spice);
      if (runningNodes + spiceNodes + 2 > hardNodeCap) break;
      value.push(...spice);
      runningNodes += spiceNodes;
    }
    if (runningNodes + 2 > hardNodeCap) break;
    value.push(p(`Pad ${i}. ${filler(charsPerPad)}`));
    runningNodes += 2;
  }

  measured = measure(value);

  // Trim from the end if we overshot either hard limit.
  while (
    (measured.bytes > MATERIAL_DOCUMENT_LIMITS.maxContentBytes ||
      measured.metrics.nodeCount > MATERIAL_DOCUMENT_LIMITS.maxNodes) &&
    value.length > 0
  ) {
    value.pop();
    measured = measure(value);
  }

  // Top up the last plain paragraph if we landed short on bytes.
  if (
    measured.bytes < targetBytes &&
    measured.metrics.nodeCount <= MATERIAL_DOCUMENT_LIMITS.maxNodes
  ) {
    const last = value.at(-1);
    if (last && last.type === 'p' && Array.isArray(last.children)) {
      const lastText = last.children.find(
        (child) => child && typeof child === 'object' && 'text' in child
      ) as { text?: string } | undefined;
      if (lastText && typeof lastText.text === 'string') {
        lastText.text += filler(targetBytes - measured.bytes + 64);
        measured = measure(value);
        while (
          measured.bytes > MATERIAL_DOCUMENT_LIMITS.maxContentBytes &&
          typeof lastText.text === 'string' &&
          lastText.text.length > 0
        ) {
          const overflow =
            measured.bytes - MATERIAL_DOCUMENT_LIMITS.maxContentBytes;
          lastText.text = lastText.text.slice(
            0,
            Math.max(0, lastText.text.length - overflow - 8)
          );
          measured = measure(value);
        }
      }
    }
  }

  if (measured.metrics.nodeCount > MATERIAL_DOCUMENT_LIMITS.maxNodes) {
    throw new Error(
      `biology load-test note exceeded node limit (${measured.metrics.nodeCount})`
    );
  }
  if (measured.bytes > MATERIAL_DOCUMENT_LIMITS.maxContentBytes) {
    throw new Error(
      `biology load-test note exceeded byte limit (${measured.bytes})`
    );
  }

  return measured.value;
}
