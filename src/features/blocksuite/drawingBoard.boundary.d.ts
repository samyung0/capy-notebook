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
