import { EMBED_CATALOG } from '@/api/embeds.generated';
import { QUESTION_MARKS_MAX } from '@/api/limits.generated';

export const QUESTION_TYPES = [
  'mcq',
  'boolean',
  'short',
  'matching',
  'ordering',
  'open',
  'gaps',
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type CognitiveLevel = 'recall' | 'application' | 'analysis';

export type TextBlock = { type: 'text'; text: string; label?: string };
type ChartEmbed = Extract<
  (typeof EMBED_CATALOG.embeds)[number],
  { kind: 'chart' }
>;
/** The chart kinds, from the embed catalog's chart schema. */
export const CHART_KINDS = (() => {
  const embed = EMBED_CATALOG.embeds.find(
    (e): e is ChartEmbed => e.kind === 'chart'
  );
  if (!embed) throw new Error('The embed catalog has no chart.');
  return embed.schema.properties.kind.enum;
})();
export type ChartKind = (typeof CHART_KINDS)[number];

export type ChartBlock = {
  type: 'chart';
  kind: ChartKind;
  title: string;
  labels: string[];
  /** One value per label; null draws nothing (an empty cell). */
  series: { name: string; values: (number | null)[] }[];
  xTitle?: string;
  yTitle?: string;
  gridlines?: 'normal' | 'fine';
  /** A caption in notes and the accessible label (optional). */
  description?: string;
};
/** Series of [x, y] points over numeric axes: drawn as straight segments in
 * x order (`line`, the default) or as dots (`scatter`), with optional dashed
 * reference lines and labelled points. */
export type PlotBlock = {
  type: 'plot';
  kind?: 'line' | 'scatter';
  title: string;
  xTitle: string;
  yTitle: string;
  unit?: string;
  series: { name: string; points: [number, number][] }[];
  lines?: { axis: 'x' | 'y'; value: number; label?: string }[];
  marks?: { x: number; y: number; label: string }[];
  /** A caption in notes and the accessible label (optional). */
  description?: string;
};
export type GraphElement =
  | {
      type: 'functiongraph';
      id: string;
      term: string;
      domain?: [number, number];
      dash?: boolean;
      hidden?: boolean;
    }
  | {
      type: 'point';
      id: string;
      name?: string;
      coords: [number, number];
      hidden?: boolean;
    }
  | {
      type: 'line';
      id: string;
      points: [string, string];
      dash?: boolean;
      hidden?: boolean;
    }
  | {
      type: 'segment';
      id: string;
      points: [string, string];
      dash?: boolean;
      /** 1 to 3 hatch marks; segments with the same count are equal in length. */
      ticks?: number;
      hidden?: boolean;
    }
  | {
      type: 'circle';
      id: string;
      center: string;
      radius: number;
      dash?: boolean;
      hidden?: boolean;
    }
  | {
      type: 'text';
      id: string;
      coords: [number, number];
      text: string;
      hidden?: boolean;
    }
  | {
      /** The non-reflex angle at the middle point; 90° draws the square mark. */
      type: 'angle';
      id: string;
      points: [string, string, string];
      label?: string;
      hidden?: boolean;
    }
  | {
      /** Counterclockwise from the first point to the second around `center`. */
      type: 'arc';
      id: string;
      center: string;
      points: [string, string];
      dash?: boolean;
      hidden?: boolean;
    }
  | {
      type: 'sector';
      id: string;
      center: string;
      points: [string, string];
      dash?: boolean;
      shade?: boolean;
      hidden?: boolean;
    }
  | {
      type: 'polygon';
      id: string;
      points: string[];
      dash?: boolean;
      shade?: boolean;
      hidden?: boolean;
    };
export type GraphBlock = {
  type: 'graph';
  board: {
    bbox: [number, number, number, number];
    axis: boolean;
    grid: boolean;
  };
  elements: GraphElement[];
  image: { url: string } | { svg: string };
  width: number;
  height: number;
  /** Alt text and grading text (optional). */
  description?: string;
  attribution?: string;
};
export type TableBlock = { type: 'table'; header: boolean; rows: string[][] };
export type ImageBlock = {
  type: 'image';
  /** Bank images are public URLs; quiz images are private workspace editor assets. */
  image: { url: string } | { assetId: string };
  width: number;
  height: number;
  /** Alt text and grading text (optional). */
  description?: string;
  attribution?: string;
};
export type QuestionBlock =
  | TextBlock
  | ChartBlock
  | PlotBlock
  | GraphBlock
  | TableBlock
  | ImageBlock;

export type QuestionAnswer =
  /** One or more correct options, answered with checkboxes (Epo 2026-10-15). */
  | { type: 'mcq'; options: string[]; correct: number[] }
  | { type: 'boolean'; correct: boolean }
  | { type: 'short'; accepted: string[]; unit?: string }
  | {
      type: 'matching';
      options: string[];
      pairs: { left: string; right: number }[];
    }
  | { type: 'ordering'; items: string[] }
  | { type: 'open'; accepted: string[]; hints: string[] }
  /** One accepted list per numbered gap written in the part's text. */
  | { type: 'gaps'; accepted: string[][] };

/** An open part's marking item; harder steps can carry more whole marks. */
export type MarkItem = { text: string; marks: number };

export type QuestionPart = {
  id: string;
  blocks: QuestionBlock[];
  answer: QuestionAnswer;
  marks: number;
  /** Open parts only, adding up to `marks`; closed answers are their own key. */
  markscheme?: MarkItem[];
  solution: QuestionBlock[];
  /** Attempt snapshots only; authored content rejects these fields. */
  awarded?: number;
  /** Open parts: none, half or all of each item's marks, summing to `awarded`. */
  itemAwards?: number[];
  /** Matching and gaps parts: whether each pair or gap was right. */
  itemResults?: boolean[];
};
export type Question = {
  id: string;
  stem: QuestionBlock[];
  parts: QuestionPart[];
  layout: 'paper' | 'split';
  labels: 'letters' | 'numbers';
  level?: CognitiveLevel;
};

export type LearnerAnswer =
  | { type: 'mcq'; options: string[] }
  | { type: 'boolean' | 'open' }
  | { type: 'short'; unit?: string }
  | { type: 'matching'; options: string[]; left: string[] }
  | { type: 'ordering'; items: string[] }
  | { type: 'gaps'; gaps: number };
export type LearnerPart = {
  id: string;
  blocks: QuestionBlock[];
  answer: LearnerAnswer;
  marks: number;
};
export type LearnerQuestion = Omit<Question, 'parts'> & {
  parts: LearnerPart[];
};

/** A numbered blank in a gaps part's text, written "(1) ______". */
export const GAP_MARKER = /\((\d+)\) ?_{3,}/g;

/** The blank numbers a gaps part's text blocks contain, in order. */
export function gapNumbers(blocks: QuestionBlock[]): number[] {
  return blocks.flatMap((block) =>
    block.type === 'text'
      ? [...block.text.matchAll(GAP_MARKER)].map((match) => Number(match[1]))
      : []
  );
}

/** Authored parts carry a worked solution; learner parts never do. */
export function isAuthoredPart(
  part: QuestionPart | LearnerPart
): part is QuestionPart {
  return 'solution' in part;
}

export function questionMarks(question: Question | LearnerQuestion): number {
  return question.parts.reduce((total, part) => total + part.marks, 0);
}

export function blankQuestion(): Question {
  return {
    id: crypto.randomUUID(),
    labels: 'letters',
    layout: 'paper',
    parts: [
      {
        answer: { accepted: [''], type: 'short' },
        blocks: [{ text: '', type: 'text' }],
        id: crypto.randomUUID(),
        marks: 1,
        solution: [],
      },
    ],
    stem: [],
  };
}

/** An open part's marks from its marking items, capped at QUESTION_MARKS_MAX:
 * the items stay as entered, so a total past the cap shows as a mismatch
 * instead of a value the live room refuses (Epo 2026-10-14). */
export function schemeMarks(items: MarkItem[]): number {
  const total = items.reduce((sum, item) => sum + item.marks, 0);
  return Math.min(QUESTION_MARKS_MAX, total);
}

/** A figure without a blank description: descriptions are optional. */
function withoutBlankDescription<B extends { description?: string }>(
  block: B
): B {
  if (block.description === undefined || block.description.trim()) return block;
  const { description: _, ...rest } = block;
  return rest as B;
}

/** A block without blanks: a blank description goes, a table's shorter rows
 * take empty cells up to the longest (a longer row adds a column), and a
 * chart series short of its labels takes nulls, an empty value (NaN) being
 * null (Epo 2026-10-14). A series longer than its labels stays invalid. */
export function blockWithoutBlanks(block: QuestionBlock): QuestionBlock {
  switch (block.type) {
    case 'text':
      return block;
    case 'table': {
      const width = Math.max(0, ...block.rows.map((row) => row.length));
      return {
        ...block,
        rows: block.rows.map((row) =>
          Array.from({ length: width }, (_, i) => row[i] ?? '')
        ),
      };
    }
    case 'chart':
      return withoutBlankDescription({
        ...block,
        series: block.series.map((series) => ({
          ...series,
          values: Array.from(
            { length: Math.max(block.labels.length, series.values.length) },
            (_, i) => {
              const value = series.values[i];
              return Number.isFinite(value) ? value : null;
            }
          ),
        })),
      });
    default:
      return withoutBlankDescription(block);
  }
}

/** The question without blanks: empty text blocks, a blank short-answer unit,
 * blank accepted answers (a blank's too) and blank open-answer hints never
 * leave it incomplete (no accepted answer left does), and saves and the quiz
 * projection drop them, with every block as `blockWithoutBlanks` keeps it
 * (Epo 2026-10-14). Blank marking items go too, and then the part's marks are
 * the rest's (`schemeMarks`, Epo 2026-10-15). */
export function withoutBlanks(question: Question): Question {
  const keep = (blocks: QuestionBlock[]) =>
    blocks
      .filter((block) => block.type !== 'text' || block.text.trim())
      .map(blockWithoutBlanks);
  const filled = (values: string[]) => values.filter((value) => value.trim());
  const answer = (answer: QuestionAnswer): QuestionAnswer => {
    if (answer.type === 'short')
      return answer.unit?.trim()
        ? { ...answer, accepted: filled(answer.accepted) }
        : { accepted: filled(answer.accepted), type: 'short' };
    if (answer.type === 'open')
      return {
        ...answer,
        accepted: filled(answer.accepted),
        hints: filled(answer.hints),
      };
    if (answer.type === 'gaps')
      return { ...answer, accepted: answer.accepted.map(filled) };
    return answer;
  };
  const scheme = (part: QuestionPart) => {
    const items = part.markscheme?.filter((item) => item.text.trim());
    return items && items.length !== part.markscheme?.length
      ? { marks: schemeMarks(items), markscheme: items }
      : {};
  };
  return {
    ...question,
    parts: question.parts.map((part) => ({
      ...part,
      answer: answer(part.answer),
      blocks: keep(part.blocks),
      solution: keep(part.solution),
      ...scheme(part),
    })),
    stem: keep(question.stem),
  };
}

/** The question with image asset ids swapped through `ids` (others kept). */
export function replaceAssetIds(
  question: Question,
  ids: Map<string, string>
): Question {
  const swap = (block: QuestionBlock): QuestionBlock => {
    if (block.type !== 'image' || !('assetId' in block.image)) return block;
    const assetId = ids.get(block.image.assetId);
    return assetId ? { ...block, image: { assetId } } : block;
  };
  return {
    ...question,
    parts: question.parts.map((part) => ({
      ...part,
      blocks: part.blocks.map(swap),
      solution: part.solution.map(swap),
    })),
    stem: question.stem.map(swap),
  };
}

/** Editor assets referenced by a quiz question's images. */
export function questionAssetIds(question: Question): string[] {
  return [
    ...question.stem,
    ...question.parts.flatMap((part) => [...part.blocks, ...part.solution]),
  ].flatMap((block) =>
    block.type === 'image' && 'assetId' in block.image
      ? [block.image.assetId]
      : []
  );
}
