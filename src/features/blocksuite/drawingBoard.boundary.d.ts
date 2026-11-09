// What the app's tsconfig sees of ./drawingBoard.ts (see tsconfig.json paths).
export type DrawingBoardOptions = {
  answerArea?: { label: string };
  board: 'question' | 'workspace';
  workspace?: {
    materials: () => {
      id: string;
      kind: 'quiz' | 'flashcards';
      title: string;
    }[];
    open: (materialId: string) => void;
  };
  fitPadding?: [number, number, number, number];
  onChange?: () => void;
  plane?: boolean;
  readOnly?: boolean;
  saved?: string;
};

export class BoardLoadError extends Error {
  readonly reason: string;
}

export function mountDrawingBoard(
  container: HTMLElement,
  options: DrawingBoardOptions
): {
  fit: (padding: [number, number, number, number]) => void;
  save: () => { bytes: number; doc: string };
  snapshot: () => string;
  putAway: () => void;
  stats: () => {
    blocks: string[];
    bytes: number;
    canvas: string[];
    marks: number;
    span: number;
  };
  toImage: () => Promise<File>;
  unmount: () => void;
};
