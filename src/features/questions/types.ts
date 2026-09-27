export const QUESTION_TYPES = [
  'mcq',
  'multi',
  'boolean',
  'short',
  'matching',
  'ordering',
  'open',
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
  showValues?: boolean;
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
      type: 'line' | 'segment';
      id: string;
      points: [string, string];
      dash?: boolean;
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
  url: string;
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
  | { type: 'open'; accepted: string[]; hints: string[] };

export type QuestionPart = {
  id: string;
  blocks: QuestionBlock[];
  answer: QuestionAnswer;
  markscheme: string[];
  solution: QuestionBlock[];
  /** Attempt snapshots only; authored content rejects these fields. */
  awarded?: number;
  awardReason?: string;
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
  | { type: 'ordering'; items: string[] };
export type LearnerPart = {
  id: string;
  blocks: QuestionBlock[];
  answer: LearnerAnswer;
  marks: number;
};
export type LearnerQuestion = Omit<Question, 'parts'> & {
  parts: LearnerPart[];
};

export function partMarks(part: QuestionPart | LearnerPart): number {
  return 'markscheme' in part ? part.markscheme.length : part.marks;
}

export function questionMarks(question: Question | LearnerQuestion): number {
  return question.parts.reduce((total, part) => total + partMarks(part), 0);
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
        markscheme: [''],
        solution: [],
      },
    ],
    stem: [],
  };
}
