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
  /** The board's name now, for the file Download as image saves. */
  title?: () => string;
  images?: import('./boardImages').BoardImages;
  onChange?: () => void;
  onEditor?: (cardId: string | null) => void;
  openPlane?: import('@/features/graph/planeEditing').PlaneOpener;
  plane?: boolean;
  readOnly?: boolean;
  locked?: boolean;
  view?: BoardView;
  kept?: BoardView;
  saved?: string;
  room?: { doc: import('yjs').Doc };
};

/** Where a board is looked at: its centre in board units, and its zoom. */
export type BoardView = { centre: [number, number]; zoom: number };

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
  onUploads: (listener: () => void) => () => void;
  onView: (listener: () => void) => () => void;
  selected: () => string[];
  textBoxes: (
    focus: BoardTextPoint,
    anchor: BoardTextPoint | null
  ) => { caret: BoardBox; range: BoardBox[] } | null;
  toBoard: (clientX: number, clientY: number) => [number, number];
  /** Where the images this tab is storing will land; none while locked. */
  uploads: () => BoardBox[];
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
  /** The whole board as a PNG, as Download as image draws it. */
  image: () => Promise<Blob>;
  openEditor: (id: string) => boolean;
  presence: BoardPresenceView | null;
  reveal: (id: string) => void;
  images: () => { file?: Blob; id: string }[];
  imageFiles: () => Promise<{ file: Blob; id: string }[]>;
  save: () => { bytes: number; doc: string };
  setLocked: (locked: boolean) => void;
  /** The room's size against its cap: the menu's last row from 75% of it, in the
   * error colour at it. null (no room) shows none. */
  setRoomSize: (size: { bytes: number; max: number } | null) => void;
  snapshot: () => string;
  /** Resolves once the board first shows (`image` draws it from then). */
  ready: Promise<void>;
  /** Just left of the ☰ in the board's chrome, for the page's save status (a
   * portal); empty, it takes no room. */
  statusSlot: HTMLElement;
  view: () => BoardView | null;
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
