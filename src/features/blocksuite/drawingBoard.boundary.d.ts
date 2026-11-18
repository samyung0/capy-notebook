// What the app's tsconfig sees of ./drawingBoard.ts (see tsconfig.json paths).
export type DrawingBoardOptions = {
  answerArea?: { label: string };
  board: 'question' | 'workspace';
  workspace?: {
    /** The account's Canvas page: each tile says its workspace, and New makes one
     * in no workspace. */
    account?: boolean;
    /** `undefined` until the whole list has loaded. */
    materials: () =>
      | {
          id: string;
          kind: 'quiz' | 'flashcards';
          title: string;
          preview?: import('@/api/types').MaterialPreview;
          /** On the account's page, the workspace it sits in; none when in none. */
          workspace?: { iconId?: string; name: string };
        }[]
      | undefined;
    open: (materialId: string) => void;
    create: (
      kind: 'quiz' | 'flashcards'
    ) => Promise<{ id: string; title: string }>;
  };
  fitPadding?: [number, number, number, number];
  images?: import('./boardImages').BoardImages;
  onChange?: () => void;
  onEditor?: (cardId: string | null) => void;
  plane?: boolean;
  readOnly?: boolean;
  saved?: string;
  room?: { doc: import('yjs').Doc };
};

/** A box in board units. */
export type BoardBox = { h: number; w: number; x: number; y: number };
/** A place in a block's text. */
export type BoardTextPoint = { index: number; text: import('yjs').Text };

/** What a canvas's presence reads of its board (./boardPresenceView.ts). */
export type BoardPresenceView = {
  boxOf: (ids: readonly string[]) => BoardBox | null;
  caret: () => { anchor: BoardTextPoint; focus: BoardTextPoint } | null;
  host: HTMLElement;
  onSelection: (listener: () => void) => () => void;
  onView: (listener: () => void) => () => void;
  selected: () => string[];
  textBoxes: (
    focus: BoardTextPoint,
    anchor: BoardTextPoint | null
  ) => { caret: BoardBox; range: BoardBox[] } | null;
  toBoard: (clientX: number, clientY: number) => [number, number];
  view: () => { left: number; top: number; width: number; zoom: number };
};

export class BoardLoadError extends Error {
  readonly reason: string;
}

export function mountDrawingBoard(
  container: HTMLElement,
  options: DrawingBoardOptions
): {
  closeEditor: () => void;
  fit: (padding: [number, number, number, number]) => void;
  has: (id: string) => boolean;
  openEditor: (id: string) => boolean;
  presence: BoardPresenceView | null;
  reveal: (id: string) => void;
  images: () => { file?: Blob; id: string }[];
  imageFiles: () => Promise<{ file: Blob; id: string }[]>;
  imagesSettled: () => Promise<void>;
  reloadImages: () => void;
  save: (options?: { finish?: boolean }) => { bytes: number; doc: string };
  snapshot: () => string;
  putAway: () => void;
  refreshCards: () => void;
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
