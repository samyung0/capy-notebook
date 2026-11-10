/** Where a board's image files come from and go (todo-board-images.md, Epo
 * 2026-11-09). An image block keeps only an id: BlockSuite's hash of the file
 * until the file is stored somewhere, then whatever id that place gave it. */
export type BoardImages = {
  /** The board takes no images (a drawn sample answer, Epo 2026-11-10): its
   * Misc panel has no Image tile. The page's own `shrink` refuses one pasted
   * or dropped, with its words. */
  none?: boolean;
  /** Fits a new image before the board takes it (an answer board's cap). A
   * refusal is thrown as its copy and the image never lands. */
  shrink?: (file: File) => Promise<Blob>;
  /** The file for an id the board doesn't hold: a stored image. `foreign` marks
   * one stored for another board, which this board then stores as its own. */
  load?: (id: string) => Promise<{ file: Blob; foreign?: boolean } | null>;
  /** A new image, or a stored one, the page refused: said to the person. */
  onRefused?: (error: unknown) => void;
  /** Whether an id is one this board's images are stored under: such an image is
   * never stored again (a copy pasted back keeps its id). */
  stored?: (id: string) => boolean;
  /** Stores a new image at once and answers the id its block keeps from then
   * (the workspace canvas: an editor asset, as notes do). Without it the block
   * keeps the hash and the file stays on the board until the page sends it (an
   * answer board, at Done). */
  store?: (file: File) => Promise<{ bytes: number; id: string }>;
  /** Files the page already holds, by id: a draft's. */
  held?: ReadonlyMap<string, Blob>;
};
