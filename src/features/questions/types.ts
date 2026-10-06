export const QUESTION_TYPES = [
  'mcq',
  'multi',
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
export type ChartBlock = {
  type: 'chart';
  kind: 'bar' | 'hbar' | 'line' | 'area' | 'pie' | 'stacked';
  title: string;
  unit?: string;
  labels: string[];
  series: { name: string; values: number[] }[];
  xTitle?: string;
  yTitle?: string;
  gridlines?: 'normal' | 'fine';
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
  description: string;
  attribution?: string;
};
export type TableBlock = { type: 'table'; header: boolean; rows: string[][] };
export type ImageBlock = {
  type: 'image';
  /** Bank images are public URLs; quiz images are private workspace editor assets. */
  image: { url: string } | { assetId: string };
  width: number;
  height: number;
  description: string;
  attribution?: string;
};
export type QuestionBlock =
  | TextBlock
  | ChartBlock
  | GraphBlock
  | TableBlock
  | ImageBlock;

export type QuestionAnswer =
  | { type: 'mcq' | 'multi'; options: string[]; correct: number[] }
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
  | { type: 'mcq' | 'multi'; options: string[] }
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
