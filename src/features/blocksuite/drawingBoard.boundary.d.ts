// What the app's tsconfig sees of ./drawingBoard.ts (see tsconfig.json paths).
export function mountDrawingBoard(
  container: HTMLElement,
  options?: { onChange?: () => void; saved?: string }
): {
  save: () => string;
  snapshot: () => string;
  stats: () => { blocks: string[]; bytes: number; canvas: string[] };
  toImage: () => Promise<string | null>;
  unmount: () => void;
};
