/* Card thumbnails for MSW: page-1 images and opening text on file fixtures,
   a mock of the server's material preview extractor (the Go one is the
   reference, server/internal/materialdoc), and a gallery of materials whose
   previews cover every note block, first-question type, flashcard front and
   Mermaid type of the approved mock. */
import type {
  Flashcard,
  MaterialPreview,
  PreviewBlock,
  Question,
  QuestionBlock,
  QuizPreviewQuestion,
} from '@/api/types';
import {
  flashcardsNode,
  type MaterialValue,
  mermaidNode,
  quizNode,
} from '@/features/materials/document';
import { GAP_MARKER } from '@/features/questions/types';
import { biologyQuizQuestions } from './biologyQuiz';
import paperPdf from './fixtures/thumbs/2604.03051v1-pdf.webp';
import courseGuideXlsx from './fixtures/thumbs/course-guide-xlsx.webp';
import handbookDocx from './fixtures/thumbs/handbook-docx.webp';
import llmPptx from './fixtures/thumbs/jp_llm2-pptx.webp';
import gradebookXlsx from './fixtures/thumbs/large-gradebook-xlsx.webp';
import lectureDeckPdf from './fixtures/thumbs/lecture_deck-pdf.webp';
import lecturePptx from './fixtures/thumbs/lecture-pptx.webp';
import newspaperPdf from './fixtures/thumbs/newspaper_scan-pdf.webp';
import photo from './fixtures/thumbs/synthetic-photo.webp';
import {
  bullet,
  codeBlock,
  equation,
  heading,
  image,
  p,
  quote,
  table,
  todo,
} from './noteContent/helpers';

/** Presigned page-1 images by file id. `Broken preview.png` points at a
 * missing image so the card's one-time icon fallback shows. */
export const FILE_THUMBNAILS: Record<string, string> = {
  'bio-office-docx': handbookDocx,
  'bio-office-pptx': lecturePptx,
  'bio-office-pptx-long': llmPptx,
  'bio-office-xlsx': courseGuideXlsx,
  'bio-office-xlsx-long': gradebookXlsx,
  f_1: lectureDeckPdf,
  f_4: paperPdf,
  f_5: photo,
  f_6: newspaperPdf,
  'mock-preview-image': '/mock-thumbnails/missing.webp',
};

/** Opening characters of text-kind files. */
export const FILE_TEXT: Record<string, string> = {
  'bio-state-ready': '# Biology notes\n\nStored without indexing.\n',
  f_2: '# Organelles cheatsheet\n\n## Energy\n- Mitochondrion: aerobic respiration, ATP\n- Chloroplast: photosynthesis\n\n## Proteins\n- Ribosome: translation\n- Rough ER: folding, transport\n- Golgi: packaging\n\n| organelle | membrane |\n|-----------|----------|\n| nucleus   | double   |',
  f_3: 'Osmosis notes\n\nWater moves across a partially permeable membrane\nfrom a dilute solution to a concentrated one.\n\nPotato cylinders in 0.0 M to 1.0 M sucrose:\n0.0 M  +8.2 %\n0.2 M  +3.1 %\n0.4 M  -1.4 %\n0.6 M  -5.0 %',
  f_7: '# Taylor series\n\n## Definition\nf(x) = sum f^(n)(a) (x - a)^n / n!\n\n## Common series\n- e^x = 1 + x + x^2/2! + ...\n- sin x = x - x^3/3! + ...\n- cos x = 1 - x^2/2! + ...',
};

/* ---------------- preview extractor (mock) ---------------- */

const NOTE_TEXT = 600;
const NOTE_BLOCKS = 8;
const STEM = 200;
const CHOICE = 60;
const CHOICES = 4;
const CODE_LINES = 6;
const SOURCE = 1024;

type Node = {
  type?: string;
  text?: string;
  children?: Node[];
  [key: string]: unknown;
};

function plain(node: Node): string {
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'inline_equation') return String(node.texExpression ?? '');
  return (node.children ?? []).map(plain).join('');
}

/** The first blocks of a note, at most 8 and 600 characters of text. */
export function notePreview(value: MaterialValue): MaterialPreview {
  const blocks: PreviewBlock[] = [];
  let budget = NOTE_TEXT;
  const take = (text: string) => {
    const out = text.slice(0, Math.max(budget, 0));
    budget -= out.length;
    return out;
  };
  for (const node of value as Node[]) {
    if (blocks.length >= NOTE_BLOCKS || budget <= 0) break;
    const last = blocks.at(-1);
    const text = plain(node).trim();
    const level = /^h([1-6])$/.exec(node.type ?? '')?.[1];
    if (level) blocks.push({ level: Number(level), t: 'h', text: take(text) });
    else if (node.type === 'p' && node.listStyleType === 'todo') {
      const item = { done: node.checked === true, text: take(text) };
      if (last?.t === 'todo') last.items.push(item);
      else blocks.push({ items: [item], t: 'todo' });
    } else if (node.type === 'p' && node.listStyleType) {
      if (last?.t === 'ul') last.items.push(take(text));
      else blocks.push({ items: [take(text)], t: 'ul' });
    } else if (node.type === 'p' && text)
      blocks.push({ t: 'p', text: take(text) });
    else if (node.type === 'table')
      blocks.push({
        rows: (node.children ?? [])
          .slice(0, 4)
          .map((row) =>
            (row.children ?? []).slice(0, 4).map((cell) => take(plain(cell)))
          ),
        t: 'table',
      });
    else if (node.type === 'equation')
      blocks.push({ t: 'math', tex: take(String(node.texExpression ?? '')) });
    else if (node.type === 'code_block')
      blocks.push({
        lang: typeof node.lang === 'string' ? node.lang : undefined,
        t: 'code',
        text: take(
          (node.children ?? []).slice(0, CODE_LINES).map(plain).join('\n')
        ),
      });
    else if (node.type === 'blockquote' || node.type === 'callout')
      blocks.push({ t: 'quote', text: take(text) });
    else if (node.type === 'img') blocks.push({ t: 'image' });
  }
  return { blocks, kind: 'note' };
}

const textOf = (blocks: QuestionBlock[]) =>
  blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join(' ');
const cut = (items: string[]) =>
  items.slice(0, CHOICES).map((item) => item.slice(0, CHOICE));

/** A quiz's first question: its prompt (the first part's text, else the
 * stem's), with gaps marked U+0001, and up to four short choices. Matching
 * gives only its left-hand prompts and ordering only its item count, so the
 * preview holds no part of the key. */
export function questionPreview(question: Question): QuizPreviewQuestion {
  const part = question.parts[0];
  const { answer } = part;
  const stem = (textOf(part.blocks) || textOf(question.stem))
    .replace(GAP_MARKER, '\u0001')
    .slice(0, STEM);
  const hasChart = [...question.stem, ...part.blocks].some(
    (block) => block.type === 'chart' || block.type === 'graph'
  );
  return {
    stem,
    type: answer.type,
    ...(hasChart && { hasChart }),
    ...(answer.type === 'mcq' && {
      options: cut(answer.options),
    }),
    ...(answer.type === 'ordering' && { itemCount: answer.items.length }),
    ...(answer.type === 'matching' && {
      prompts: cut(answer.pairs.map((pair) => pair.left)),
    }),
  };
}

export function quizPreview(questions: Question[]): MaterialPreview {
  return {
    kind: 'quiz',
    questionCount: questions.length,
    ...(questions[0] && { first: questionPreview(questions[0]) }),
  };
}

export function flashcardsPreview(cards: Flashcard[]): MaterialPreview {
  return {
    cardCount: cards.length,
    kind: 'flashcards',
    ...(cards[0] && {
      first: { front: cards[0].front, hasImage: !!cards[0].image },
    }),
  };
}

/** The first Mermaid block, cut on a line boundary. */
export function mermaidPreview(
  kind: 'mindmap' | 'diagram',
  value: MaterialValue
): MaterialPreview | undefined {
  const node = (value as Node[]).find((n) => n.type === 'mermaid');
  if (typeof node?.source !== 'string') return;
  let source = node.source;
  if (source.length > SOURCE)
    source = source.slice(0, source.lastIndexOf('\n', SOURCE));
  return { kind, source };
}

/* ---------------- gallery ---------------- */

export interface GalleryMaterial {
  id: string;
  kind: 'note' | 'quiz' | 'flashcards' | 'mindmap' | 'diagram';
  title: string;
  /** Seeded straight into the trash, where diagram previews are visible. */
  trashed?: true;
  value: MaterialValue;
}

const CELL_ASSET = 'asset_mock_cell_diagram';

const notes: [string, MaterialValue][] = [
  [
    'Friday practical',
    [p('Bring lab coat and goggles on Friday. Practical starts 9:00 in B204.')],
  ],
  [
    'Photosynthesis overview',
    [
      p(
        'Photosynthesis takes place in the chloroplast and is commonly divided into the light-dependent reactions, which occur in the thylakoid membranes, and the light-independent reactions of the Calvin cycle, which occur in the stroma. In the light-dependent reactions, photons excite electrons in photosystem II; water is split to replace them, releasing oxygen. The electrons pass along an electron transport chain to photosystem I, pumping protons into the thylakoid lumen.'
      ),
    ],
  ],
  [
    'Revision plan · Unit 3',
    [
      heading(1, 'Revision plan · Unit 3'),
      heading(2, 'This week'),
      todo('Re-read enzyme notes', true),
      todo('Flashcards: key enzymes', true),
      todo('Past paper Q4–Q7'),
      todo('Ask about inhibition graph'),
      heading(2, 'Next week'),
      bullet('Respiration mindmap'),
      bullet('Practical write-up'),
    ],
  ],
  [
    'Titration results',
    [
      heading(1, 'Titration results'),
      p('Three runs against 0.100 M NaOH.'),
      table(
        ['Run', 'Start (mL)', 'End (mL)', 'Titre'],
        [
          ['1', '0.40', '23.15', '22.75'],
          ['2', '0.10', '22.80', '22.70'],
          ['3', '0.25', '22.95', '22.70'],
        ]
      ),
      p('Mean concordant titre: 22.70 mL.'),
    ],
  ],
  [
    'Michaelis–Menten derivation',
    [
      heading(1, 'Michaelis–Menten'),
      p('Initial rate as a function of substrate concentration:'),
      equation('v = \\frac{V_{max}[S]}{K_m + [S]}'),
      p(
        'Taking reciprocals gives the Lineweaver–Burk form, a straight line with slope Km/Vmax.'
      ),
    ],
  ],
  [
    'Plotting rate data',
    [
      heading(1, 'Plotting rate data'),
      codeBlock(
        [
          'import numpy as np',
          '# substrate in mM',
          's = np.array([0.5, 1, 2, 5, 10])',
          'v = vmax * s / (km + s)',
          'plt.plot(s, v, "o-")',
        ],
        'python'
      ),
      p('Fit with scipy.optimize.curve_fit.'),
    ],
  ],
  [
    'Animal cell under the microscope',
    [
      image(CELL_ASSET, 'animal-cell.svg'),
      heading(1, 'Animal cell'),
      p('Nucleus, mitochondria and the membrane are visible at ×400.'),
    ],
  ],
  [
    'Onion cell practical',
    [
      heading(1, 'Onion cell practical'),
      p('Stained with iodine; cell walls and nuclei stand out.'),
      image(CELL_ASSET, 'onion-cells.svg'),
      p('Drawn at ×100 and ×400.'),
    ],
  ],
  [
    'Microscope photos',
    [
      image(CELL_ASSET, 'slide-1.svg'),
      image(CELL_ASSET, 'slide-2.svg'),
      p('Slides 1 and 2 from Tuesday.'),
    ],
  ],
  ['Whiteboard snap', [image(CELL_ASSET, 'whiteboard.svg')]],
  [
    '細胞呼吸 筆記',
    [
      heading(1, '細胞呼吸 Cellular respiration'),
      p(
        '細胞呼吸是細胞將葡萄糖分解並釋放能量的過程，主要分為糖解作用、克氏循環與電子傳遞鏈三個階段。'
      ),
      bullet('糖解作用 Glycolysis'),
      bullet('克氏循環 Krebs cycle'),
    ],
  ],
  [
    'Inhibition',
    [
      heading(1, 'Inhibition'),
      quote(
        'Exam tip: competitive inhibition can be overcome by more substrate; non-competitive cannot.'
      ),
      p(
        'Competitive inhibitors bind the active site. Non-competitive inhibitors bind elsewhere and change its shape.'
      ),
    ],
  ],
  ['Untitled note', [p('')]],
];

/** Biology questions reordered so the first one has the wanted type, and a
 * chart or graph in its stem when `chart` says so. */
function quizStartingWith(
  type: Question['parts'][number]['answer']['type'],
  count: number,
  chart?: boolean
): MaterialValue {
  const hasChart = (q: Question) =>
    q.stem.some((block) => block.type === 'chart' || block.type === 'graph');
  const first = biologyQuizQuestions.find(
    (q) =>
      q.parts[0].answer.type === type &&
      (chart === undefined || hasChart(q) === chart)
  );
  if (!first) throw new Error(`No ${type} biology question`);
  const questions = [
    first,
    ...biologyQuizQuestions.filter((q) => q !== first),
  ].slice(0, count);
  return [quizNode({ questions })];
}

const quizzes: [string, MaterialValue][] = [
  ['Respiration · multiple choice', quizStartingWith('mcq', 12, false)],
  ['Membrane facts', quizStartingWith('boolean', 13)],
  ['Osmosis recall', quizStartingWith('short', 6)],
  ['Rate of photosynthesis', quizStartingWith('open', 3, true)],
  ['Organelle locations', quizStartingWith('matching', 10)],
  ['Mitosis stages', quizStartingWith('ordering', 5)],
  ['Cell biology blanks', quizStartingWith('gaps', 9)],
  ['Surface area graphs', quizStartingWith('mcq', 4, true)],
  ['Single question', quizStartingWith('short', 1)],
];

function deck(count: number, front: string, image = false): MaterialValue {
  return [
    flashcardsNode(
      Array.from({ length: count }, (_, i) => ({
        back: `Answer ${i + 1}`,
        front: i === 0 ? front : `Term ${i + 1}`,
        id: '',
        ...(image && i === 0 && { image: { assetId: CELL_ASSET } }),
      }))
    ),
  ];
}

const decks: [string, MaterialValue][] = [
  ['Key enzymes', deck(24, 'Michaelis constant (Km)')],
  [
    'Temperature and enzymes',
    deck(
      40,
      'Describe what happens to the rate of an enzyme-controlled reaction as temperature rises above the optimum, and explain why.'
    ),
  ],
  ['Identify the organelle', deck(12, 'Name the labelled organelle', true)],
  ['生物 詞彙', deck(120, '光合作用')],
  ['Label the diagram', deck(6, '', true)],
  [
    'Microscopy',
    deck(
      18,
      'Identify the stage of mitosis shown and describe what the chromosomes are doing.',
      true
    ),
  ],
  ['Physics formulae', deck(8, 'E = hf')],
  ['Transport terms', deck(2, 'Osmosis')],
  ['Just started', deck(1, 'Mitochondrion')],
];

const mermaid: [string, 'mindmap' | 'diagram', string][] = [
  [
    'Enzymes',
    'mindmap',
    'mindmap\n  root((Enzymes))\n    Structure\n    Inhibition\n    Kinetics',
  ],
  [
    'Cellular respiration',
    'mindmap',
    'mindmap\n  root((Respiration))\n    Glycolysis\n    Link reaction\n    ETC\n    ATP yield\n    Krebs cycle',
  ],
  [
    'Biology HL syllabus',
    'mindmap',
    'mindmap\n  root((Biology HL))\n    Cells\n    Molecules\n    Genetics\n    Ecology\n    Evolution\n    Physiology\n    Plants\n    Metabolism',
  ],
  [
    'ATP production flow',
    'diagram',
    'flowchart TD\n  G[Glucose] --> Y[Glycolysis]\n  Y --> K[Krebs cycle]\n  K --> E[Electron transport]\n  E -.-> Y',
  ],
  [
    'Acid or base?',
    'diagram',
    'flowchart LR\n  S[Sample] --> D{pH < 7?}\n  D -->|yes| A[Acid]\n  D -->|no| B[Base]',
  ],
  [
    'Upload sequence',
    'diagram',
    'sequenceDiagram\n  Student->>App: upload\n  App->>Server: parse\n  Server-->>App: ready\n  App-->>Student: notify',
  ],
  [
    'Cell cycle',
    'diagram',
    '---\ntitle: Cell cycle\n---\nstateDiagram-v2\n  G1 --> S\n  S --> G2\n  G2 --> M\n  M --> G1',
  ],
  [
    'Diet breakdown',
    'diagram',
    'pie\n  "Carbohydrate" : 45\n  "Fat" : 30\n  "Protein" : 25',
  ],
  [
    'History of cell biology',
    'diagram',
    'timeline\n  1665 : Hooke sees cells\n  1838 : Cell theory\n  1953 : DNA helix\n  2003 : Human genome',
  ],
  [
    'Organelle classes',
    'diagram',
    'classDiagram\n  Organelle <|-- Mitochondrion\n  Organelle <|-- Ribosome',
  ],
];

export const GALLERY: GalleryMaterial[] = [
  ...notes.map(([title, value], i) => ({
    id: `mat_thumb_note_${i}`,
    kind: 'note' as const,
    title,
    value,
  })),
  ...quizzes.map(([title, value], i) => ({
    id: `mat_thumb_quiz_${i}`,
    kind: 'quiz' as const,
    title,
    value,
  })),
  ...decks.map(([title, value], i) => ({
    id: `mat_thumb_cards_${i}`,
    kind: 'flashcards' as const,
    title,
    value,
  })),
  ...mermaid.map(([title, kind, source], i) => ({
    id: `mat_thumb_${kind}_${i}`,
    kind,
    title,
    trashed: true as const,
    value: [mermaidNode(source)],
  })),
];
