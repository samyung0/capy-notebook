// What the app's tsconfig sees of ./drawingBoard.ts (see tsconfig.json paths).
export type DrawingBoardOptions = {
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
  options?: DrawingBoardOptions
): {
  save: () => { bytes: number; doc: string };
  snapshot: () => string;
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
