import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { ItemRoomSnapshot } from '@/features/collaboration/itemRoom';

/* A quiz's two rooms as one: keys refused as read-only, while the content
   room still writes, read the quiz on the content room alone. */

const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const ROOM: ItemRoomSnapshot = {
  access: 'write',
  deleted: false,
  offline: null,
  presence: [],
  readOnlyCode: null,
  recovery: null,
  sending: false,
  slowed: false,
  status: 'saved',
  synced: true,
} as unknown as ItemRoomSnapshot;
const rooms = vi.hoisted(() => ({
  content: { doc: 'content' },
  keys: { doc: 'keys' },
}));
vi.mock('@/api/hooks', () => ({ useMe: () => ({ data: { id: 'u' } }) }));
vi.mock('@/features/collaboration/deviceCopy', () => ({
  useRoomSeed: () => null,
}));
vi.mock('@/features/collaboration/itemRoom', () => ({
  useItemRoom: (
    _id: string,
    _kind: string,
    enabled: boolean,
    { document: which }: { document?: 'keys' }
  ) =>
    which === 'keys'
      ? {
          room: enabled ? rooms.keys : null,
          // Refused as read-only, never synced.
          snapshot: {
            ...ROOM,
            access: 'read',
            status: 'opening',
            synced: false,
          },
        }
      : { room: rooms.content, snapshot: ROOM },
}));

const { createRoot } = await import('react-dom/client');
const { useQuizRooms } = await import('./liveQuizRooms');

it('reads the quiz on its content room when the keys refuse this person as read-only', async () => {
  let read: ReturnType<typeof useQuizRooms> | undefined;
  function Probe() {
    read = useQuizRooms('qz1', { edit: true });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(<Probe />));
  expect(read).toMatchObject({
    access: 'read',
    content: rooms.content,
    keys: null,
    ready: true,
    status: 'saved',
  });
  act(() => root.unmount());
});
