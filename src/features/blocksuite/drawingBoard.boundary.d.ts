// What the app's tsconfig sees of ./drawingBoard.ts (see tsconfig.json paths).
export type BoardBackground =
  | { kind: 'blank' }
  | { kind: 'grid' }
  | { kind: 'axes'; x: [number, number]; y: [number, number] }
  | { kind: 'figure'; src: string };

export type DrawingBoardOptions = {
  background?: BoardBackground;
  onChange?: () => void;
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
  ready: Promise<void>;
  save: () => { bytes: number; doc: string };
  snapshot: () => string;
  stats: () => {
    blocks: string[];
    bytes: number;
    canvas: string[];
    marks: number;
  };
  toImage: () => Promise<File>;
  unmount: () => void;
};
