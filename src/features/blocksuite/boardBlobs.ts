import type { BlobSource, BlobState } from '@blocksuite/affine/sync';
import type { BoardImages } from './boardImages';

const IDLE: BlobState = {
  downloading: false,
  needDownload: false,
  needUpload: false,
  overSize: false,
  uploading: false,
};

type Watch = (state: BlobState) => void;

/** A file with a name its type fits, as an upload asks: a pasted image has one,
 * one read back from storage doesn't. */
const asFile = (blob: Blob) =>
  blob instanceof File
    ? blob
    : new File(
        [blob],
        `image.${(blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')}`,
        { type: blob.type }
      );

/** The board's file store, in place of BlockSuite's in-memory one: files by the
 * id a block keeps, asked from the page when missing, and stored through the
 * page when it stores images at once. */
export class BoardBlobSource implements BlobSource {
  readonly name = 'board';
  readonly readonly = false;

  private readonly files = new Map<string, Blob>();
  private readonly asked = new Map<string, Promise<Blob | null>>();
  /** Held under an id nothing has stored yet: a new image's hash, or another
   * board's id. */
  private readonly fresh = new Set<string>();
  private readonly storing = new Map<string, Promise<void>>();
  /** Where a stored image's block moved: its first id to the stored one. */
  private readonly moved = new Map<string, { bytes: number; id: string }>();
  private readonly watchers = new Map<string, Set<Watch>>();

  /** A stored image's blocks take its id (`to`), or go when it was refused. */
  onSettled: (from: string, to?: { bytes: number; id: string }) => void = () =>
    undefined;

  private readonly images: BoardImages;

  constructor(images: BoardImages = {}) {
    this.images = images;
    for (const [id, file] of images.held ?? []) this.files.set(id, file);
  }

  /** The file the board holds for an id, if any. */
  held(id: string) {
    return this.files.get(id);
  }

  get(key: string) {
    const held = this.files.get(key);
    if (held) return Promise.resolve(held);
    const { load } = this.images;
    if (!load) return Promise.resolve(null);
    let asked = this.asked.get(key);
    if (!asked) {
      asked = load(key).then((found) => {
        if (!found) return null;
        this.files.set(key, found.file);
        if (found.foreign) this.fresh.add(key);
        return found.file;
      });
      // A failure is asked again by the next view, not retried here.
      asked.catch(() => this.asked.delete(key));
      this.asked.set(key, asked);
    }
    return asked;
  }

  async set(key: string, value: Blob) {
    const { shrink, onRefused } = this.images;
    let file = value;
    if (shrink)
      try {
        file = await shrink(asFile(value));
      } catch (error) {
        onRefused?.(error);
        throw error;
      }
    this.files.set(key, file);
    this.fresh.add(key);
    return key;
  }

  delete(key: string) {
    this.files.delete(key);
    return Promise.resolve();
  }

  list() {
    return Promise.resolve([...this.files.keys()]);
  }

  /** The upload's mark on the image while it is stored. */
  blobState$(key: string) {
    const watchers = this.watchers;
    return {
      subscribe: (next: Watch) => {
        const set = watchers.get(key) ?? new Set<Watch>();
        watchers.set(key, set);
        set.add(next);
        next({ ...IDLE, uploading: this.storing.has(key) });
        return {
          unsubscribe: () => {
            set.delete(next);
            if (!set.size) watchers.delete(key);
          },
        };
      },
    } as unknown as ReturnType<NonNullable<BlobSource['blobState$']>>;
  }

  /** A block landed with this id: one whose image is already stored moves to
   * the stored id, and one nothing has stored yet is stored now. */
  async landed(key: string) {
    const stored = this.moved.get(key);
    if (stored) return this.onSettled(key, stored);
    const { store, onRefused } = this.images;
    if (!store) return;
    const file = await this.get(key).catch(() => null);
    if (!(file && this.fresh.has(key)) || this.storing.has(key)) return;
    const tell = (uploading: boolean) => {
      for (const next of this.watchers.get(key) ?? [])
        next({ ...IDLE, uploading });
    };
    const storing = store(asFile(file))
      .then((to) => {
        this.fresh.delete(key);
        this.moved.set(key, to);
        // Shown from the file in hand under its new id too.
        this.files.set(to.id, file);
        this.onSettled(key, to);
      })
      .catch((error: unknown) => {
        onRefused?.(error);
        this.onSettled(key);
      })
      .finally(() => {
        this.storing.delete(key);
        tell(false);
      });
    this.storing.set(key, storing);
    tell(true);
    await storing;
  }

  /** Once no image is being stored. */
  async settled() {
    while (this.storing.size) await Promise.all(this.storing.values());
  }
}
