import type { BlobSource } from '@blocksuite/affine/sync';
import type { BoardImages } from './boardImages';

/** Where a stored image is kept: the id its block holds, and its size. */
export type StoredImage = { bytes: number; id: string };

const EXTENSION = /\.\w+$/;

/** A file with a name its type fits, as an upload asks: a pasted image has one,
 * one read back from storage doesn't. */
function asFile(blob: Blob) {
  // A copy read back from the clipboard is a File named "undefined".
  if (blob instanceof File && EXTENSION.test(blob.name)) return blob;
  const [, subtype] = blob.type.split('/');
  if (!subtype) throw new Error('board image without a type');
  return new File([blob], `image.${subtype.replace('jpeg', 'jpg')}`, {
    type: blob.type,
  });
}

/** The board's file store, in place of BlockSuite's in-memory one: files by the
 * id a block keeps, asked from the page when missing.
 *
 * A board that stores its images at once (`BoardImages.store`, a canvas) stores
 * a new one here, before BlockSuite adds its block: BlockSuite waits for `set`
 * (a file pasted, picked or dropped, or carried by a pasted copy) and for
 * `pasted` (a copied block, drawingBoard.ts `BoardImageClipboard`) before it
 * adds anything. The one way in where BlockSuite adds the block first, a file
 * pasted into a note's text, waits for `set` on a canvas too (drawingBoard.ts
 * `storedImagePaste`). So a block is never in the document under an id no one
 * can load, whatever becomes of the board meanwhile, and a refused image
 * never lands. A board that has gone (`close`) or stopped taking edits
 * (`readonly`) while an image was stored adds nothing for it: BlockSuite's
 * add would be refused by a store that takes no edits. */
export class BoardBlobSource implements BlobSource {
  readonly name = 'board';
  /** Set while the board takes no edits: BlockSuite then stores nothing. */
  readonly = false;

  private readonly files = new Map<string, Blob>();
  private readonly asked = new Map<string, Promise<Blob | null>>();
  /** Held under an id this board's images are not stored under: another
   * board's. */
  private readonly foreign = new Set<string>();
  private readonly storing = new Map<string, Promise<StoredImage>>();
  /** Where an image went: the id it came under (BlockSuite's hash of a new
   * file, another board's id) to the stored one. */
  private readonly moved = new Map<string, StoredImage>();
  private closed = false;

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
        // None for now is asked again: a save may bring a trashed image back.
        if (!found) this.asked.delete(key);
        if (!found) return null;
        this.files.set(key, found.file);
        if (found.foreign) this.foreign.add(key);
        return found.file;
      });
      // A failure is asked again by the next view, not retried here.
      asked.catch(() => this.asked.delete(key));
      this.asked.set(key, asked);
    }
    return asked;
  }

  async set(key: string, value: Blob) {
    const { shrink, onRefused, stored, store } = this.images;
    // A paste of a copy hands back the file of an image already stored under
    // this id, and a file pasted again is stored already: nothing new to keep.
    if (
      stored?.(key) ||
      this.moved.has(key) ||
      (this.files.has(key) && !this.foreign.has(key))
    )
      return key;
    let file = value;
    if (shrink)
      try {
        file = await shrink(asFile(value));
      } catch (error) {
        onRefused?.(error);
        throw error;
      }
    // Without a store the file stays on the board until the page sends it.
    if (store) await this.keep(key, file);
    else this.files.set(key, file);
    return key;
  }

  /** Stores `file`, which came under `key`, once; a refusal is said and
   * thrown, so nothing lands. */
  private async keep(key: string, file: Blob) {
    const { store, onRefused } = this.images;
    if (!store) throw new Error('board images are not stored at once');
    let storing = this.storing.get(key);
    if (!storing) {
      storing = Promise.resolve()
        .then(() => store(asFile(file)))
        .then((to) => {
          this.moved.set(key, to);
          this.foreign.delete(key);
          // Shown from the file in hand, under either id.
          this.files.set(key, file);
          this.files.set(to.id, file);
          return to;
        })
        .catch((error: unknown) => {
          onRefused?.(error);
          throw error;
        })
        .finally(() => this.storing.delete(key));
      this.storing.set(key, storing);
    }
    const to = await storing;
    if (this.closed) throw new Error('the board closed while its image stored');
    if (this.readonly)
      throw new Error('the board locked while its image stored');
    return to;
  }

  /** Where the image a block is about to keep under `key` is stored, on a
   * board that stores at once: a new file's stored id, as its block lands
   * under BlockSuite's hash. */
  storedAs(key: string) {
    return this.moved.get(key);
  }

  /** The id a pasted copy of an image block keeps: its own when this board's
   * images are stored under it (or the board stores none), the stored id of
   * another board's image, stored here now; null when no file can be had. */
  async pasted(key: string): Promise<{ bytes?: number; id: string } | null> {
    const moved = this.moved.get(key);
    if (moved) return moved;
    const file = await this.get(key);
    if (!file) return null;
    if (!(this.images.store && this.foreign.has(key))) return { id: key };
    return this.keep(key, file);
  }

  delete(key: string) {
    this.files.delete(key);
    return Promise.resolve();
  }

  list() {
    return Promise.resolve([...this.files.keys()]);
  }

  /** The board is gone: an image still being stored lands nowhere. */
  close() {
    this.closed = true;
  }
}
