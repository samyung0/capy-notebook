import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { LearnerQuestion } from '@/features/questions/types';
import { getLocale } from '@/i18n';

/* Refused on a rejoin (the quiz assigned to them since), a reader keeps what it
   last showed (Epo 2026-11-05: "show stale ones if necessary"). */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const rooms = vi.hoisted(() => ({
  opened: [] as { onReplace: () => void; synced: boolean }[],
}));
vi.mock('@/features/collaboration/itemRoom', () => ({
  openItemRoom: (_id: string, options: { onReplace: () => void }) => {
    // The first room syncs; the one that replaces it is refused.
    const synced = rooms.opened.length === 0;
    rooms.opened.push({ onReplace: options.onReplace, synced });
    return {
      close() {},
      room: {
        doc: { off() {}, on() {} },
        getSnapshot: () => ({
          status: synced ? 'saved' : 'unavailable',
          synced,
        }),
        lists: new Map(),
        subscribe: () => () => undefined,
      },
    };
  },
}));
vi.mock('./liveQuiz', () => ({
  readLearnerQuestions: () => [{ id: 'live' }],
}));

const { createRoot } = await import('react-dom/client');
const { useLiveQuizQuestions } = await import('./liveQuizReads');

const shown = { current: [] as LearnerQuestion[] };
function Reader() {
  shown.current = useLiveQuizQuestions('qz_1', [
    { id: 'stored' },
  ] as unknown as LearnerQuestion[]);
  return null;
}

it('keeps the live questions when the room that replaces it is refused', async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () => root.render(<Reader />));
  await vi.waitFor(() => expect(shown.current[0]?.id).toBe('live'), {
    timeout: 10_000,
  });
  await act(async () => rooms.opened[0].onReplace());
  await vi.waitFor(() => expect(rooms.opened).toHaveLength(2), {
    timeout: 10_000,
  });
  await act(async () => undefined);
  expect(shown.current[0]?.id).toBe('live');
  act(() => root.unmount());
});
