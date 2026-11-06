// What the app's tsconfig sees of ./drawingBoard.ts (see tsconfig.json paths).
export function mountDrawingBoard(
  container: HTMLElement,
  options?: { saved?: string }
): {
  save: () => string;
  stats: () => { blocks: string[]; bytes: number; canvas: string[] };
  toImage: () => Promise<string | null>;
  unmount: () => void;
};
