import { describe, expect, it, vi } from 'vitest';
import { BoardBlobSource } from './boardBlobs';

const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' });

describe('BoardBlobSource', () => {
  it('stores a new image before its block can land, and says where it went', async () => {
    let stored: (to: { bytes: number; id: string }) => void = () => undefined;
    const store = vi.fn(
      () =>
        new Promise<{ bytes: number; id: string }>((resolve) => {
          stored = resolve;
        })
    );
    const source = new BoardBlobSource({ store });
    // BlockSuite adds the block once `set` answers: not while it is stored.
    let answered = false;
    const set = source.set('hash', png()).then(() => {
      answered = true;
    });
    await Promise.resolve();
    expect(answered).toBe(false);
    expect(source.storedAs('hash')).toBeUndefined();
    stored({ bytes: 7, id: 'asset_1' });
    await set;
    expect(source.storedAs('hash')).toEqual({ bytes: 7, id: 'asset_1' });
    // Shown from the file in hand under the stored id.
    expect(await source.get('asset_1')).toBeInstanceOf(Blob);
    // The same file again (a paste again) is stored already.
    await source.set('hash', png());
    expect(store).toHaveBeenCalledOnce();
  });

  it('says how much of the file handed to it has gone up', async () => {
    const source = new BoardBlobSource({
      store: async (_file, onProgress) => {
        onProgress?.(42);
        return { bytes: 7, id: 'asset_1' };
      },
    });
    const onProgress = vi.fn();
    source.onProgress = onProgress;
    const file = png();
    await source.set('hash', file);
    expect(onProgress).toHaveBeenCalledWith(file, 42);
  });

  it('leaves an image already stored under its id alone when a copy is pasted back', async () => {
    const store = vi.fn(async (_file: File) => ({ bytes: 7, id: 'asset_2' }));
    const own = new Set(['asset_own']);
    const source = new BoardBlobSource({
      load: async () => ({ file: png() }),
      store: async (file) => {
        const stored = await store(file);
        own.add(stored.id);
        return stored;
      },
      stored: (id) => own.has(id),
    });
    // The clipboard hands the file back under the id its block keeps: one the
    // server lists, and one stored in this session.
    await source.set('asset_own', png('undefined'));
    expect(await source.pasted('asset_own')).toEqual({ id: 'asset_own' });
    await source.set('hash', png());
    await source.set('asset_2', png('undefined'));
    expect(await source.pasted('asset_2')).toEqual({ id: 'asset_2' });
    expect(store).toHaveBeenCalledOnce();
  });

  it('refuses an image that cannot be stored, says why, and lets nothing land', async () => {
    const refusal = new Error('storage full');
    const onRefused = vi.fn();
    const source = new BoardBlobSource({
      onRefused,
      store: () => Promise.reject(refusal),
    });
    await expect(source.set('hash', png())).rejects.toBe(refusal);
    expect(onRefused).toHaveBeenCalledExactlyOnceWith(refusal);
    expect(source.storedAs('hash')).toBeUndefined();
    expect(source.held('hash')).toBeUndefined();
  });

  it("stores another board's pasted image as its own, and leaves its own alone", async () => {
    const store = vi.fn(async (_file: File) => ({
      bytes: 3,
      id: 'asset_mine',
    }));
    const source = new BoardBlobSource({
      load: async (id) =>
        id === 'asset_gone'
          ? null
          : {
              file: new Blob(['x'], { type: 'image/webp' }),
              foreign: id === 'asset_theirs',
            },
      store,
    });
    expect(await source.pasted('asset_own')).toEqual({ id: 'asset_own' });
    expect(store).not.toHaveBeenCalled();
    // Only a paste stores it: showing another board's image stores nothing.
    expect(await source.get('asset_theirs')).toBeInstanceOf(Blob);
    expect(store).not.toHaveBeenCalled();
    expect(await source.pasted('asset_theirs')).toEqual({
      bytes: 3,
      id: 'asset_mine',
    });
    // Read back from storage it has no name: it goes up with one its type fits.
    expect(store.mock.calls[0][0]).toEqual(
      expect.objectContaining({ name: 'image.webp' })
    );
    // No file to be had: no block.
    expect(await source.pasted('asset_gone')).toBeNull();
  });

  it('lands nothing once its board has gone, though the image was stored', async () => {
    let stored: (to: { bytes: number; id: string }) => void = () => undefined;
    const source = new BoardBlobSource({
      store: () =>
        new Promise((resolve) => {
          stored = resolve;
        }),
    });
    const set = source.set('hash', png());
    await Promise.resolve();
    source.close();
    stored({ bytes: 7, id: 'asset_1' });
    await expect(set).rejects.toThrow('the board closed');
  });

  it('lands nothing on a board that locked while the image was stored', async () => {
    let stored: (to: { bytes: number; id: string }) => void = () => undefined;
    const source = new BoardBlobSource({
      store: () =>
        new Promise((resolve) => {
          stored = resolve;
        }),
    });
    const set = source.set('hash', png());
    await Promise.resolve();
    source.readonly = true;
    stored({ bytes: 7, id: 'asset_1' });
    await expect(set).rejects.toThrow('the board locked');
    // Taking edits again, the same file pasted is stored already and lands.
    source.readonly = false;
    expect(await source.set('hash', png())).toBe('hash');
    expect(source.storedAs('hash')).toEqual({ bytes: 7, id: 'asset_1' });
  });

  it('keeps an answer board image on the board, fitted, with nothing stored', async () => {
    const fitted = new Blob(['small'], { type: 'image/webp' });
    const source = new BoardBlobSource({
      held: new Map([['kept', new Blob(['draft'])]]),
      shrink: async () => fitted,
    });
    await source.set('hash', png());
    expect(source.held('hash')).toBe(fitted);
    expect(source.held('kept')).toBeInstanceOf(Blob);
    expect(await source.pasted('hash')).toEqual({ id: 'hash' });
  });
});
