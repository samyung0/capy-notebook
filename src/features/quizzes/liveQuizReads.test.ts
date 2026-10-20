import { expect, it, vi } from 'vitest';

// The rooms a reader opens, recorded instead of joined.
const opened = vi.hoisted(() => [] as { id: string; options: unknown }[]);
vi.mock('@/features/collaboration/itemRoom', () => ({
  openItemRoom: (id: string, options: unknown) => {
    opened.push({ id, options });
    return {
      close() {},
      room: {
        doc: { off() {}, on() {} },
        getSnapshot: () => ({ synced: false }),
        lists: new Map(),
        subscribe: () => () => undefined,
      },
    };
  },
}));

const { readLive } = await import('./liveQuizReads');

// REVIEW1 S5 (live-items D1): a quiz read live (the attempt page, a quiz's
// View, a note's embed in View) joins its content document only, never the
// keys document, for a viewer and an editor alike.
it('a live quiz reader joins only the content document', async () => {
  const leave = readLive(
    'qz_1',
    () => undefined,
    () => undefined
  );
  // readLive imports the room and the quiz model lazily, which takes over a
  // second when the whole suite loads at once.
  await vi.waitFor(() => expect(opened).toHaveLength(1), { timeout: 10_000 });
  leave();
  expect(opened[0].id).toBe('qz_1');
  expect(opened[0].options).not.toHaveProperty('document');
  expect(opened[0].options).not.toHaveProperty('drafts');
});
