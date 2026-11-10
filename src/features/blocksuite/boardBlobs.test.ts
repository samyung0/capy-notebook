import { describe, expect, it, vi } from 'vitest';
import { BoardBlobSource } from './boardBlobs';

const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' });

describe('BoardBlobSource', () => {
  it('stores a new image when its block lands and moves the block to the stored id', async () => {
    const store = vi.fn(async () => ({ bytes: 7, id: 'asset_1' }));
    const source = new BoardBlobSource({ store });
    const settled = vi.fn();
    source.onSettled = settled;
    await source.set('hash', png());
    await source.landed('hash');
    expect(store).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith('hash', { bytes: 7, id: 'asset_1' });
    // Shown from the file in hand under the stored id.
    expect(await source.get('asset_1')).toBeInstanceOf(Blob);
    // A second block with the same file (a paste again, a redo) moves at once.
    await source.landed('hash');
    expect(store).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it('takes a refused image off the board and says why', async () => {
    const refusal = new Error('storage full');
    const onRefused = vi.fn();
    const source = new BoardBlobSource({
      onRefused,
      store: () => Promise.reject(refusal),
    });
    const settled = vi.fn();
    source.onSettled = settled;
    await source.set('hash', png());
    await source.landed('hash');
    expect(onRefused).toHaveBeenCalledWith(refusal);
    expect(settled).toHaveBeenCalledWith('hash');
  });

  it("stores another board's image as its own, and leaves its own alone", async () => {
    const store = vi.fn(async () => ({ bytes: 3, id: 'asset_mine' }));
    const source = new BoardBlobSource({
      load: async (id) => ({
        file: new Blob(['x'], { type: 'image/webp' }),
        foreign: id === 'asset_theirs',
      }),
      store,
    });
    await source.landed('asset_own');
    expect(store).not.toHaveBeenCalled();
    await source.landed('asset_theirs');
    expect(store).toHaveBeenCalledOnce();
    // Read back from storage it has no name: it goes up with one its type fits.
    expect(store.mock.calls[0]).toEqual([
      expect.objectContaining({ name: 'image.webp' }),
    ]);
  });

  it('keeps an answer board image on the board, fitted, with nothing stored', async () => {
    const fitted = new Blob(['small'], { type: 'image/webp' });
    const source = new BoardBlobSource({
      held: new Map([['kept', new Blob(['draft'])]]),
      shrink: async () => fitted,
    });
    await source.set('hash', png());
    await source.landed('hash');
    expect(source.held('hash')).toBe(fitted);
    expect(source.held('kept')).toBeInstanceOf(Blob);
    await source.settled();
  });
});
