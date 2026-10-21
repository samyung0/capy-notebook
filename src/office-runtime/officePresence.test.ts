import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CURSOR_SEND_MS, createCursorChannel } from './officePresence';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (slideId: string) => ({ slideId });

/** A co-editor's name flag shows for a while after its cursor moves: the
 * channel keeps when each cursor last moved, not when it was last heard. */
it('keeps when each co-editor’s cursor last moved', () => {
  const channel = createCursorChannel(() => {});
  channel.receive([{ clientId: 1, cursor: at('s1'), name: 'Bea' }]);
  const [first] = channel.peers;
  vi.advanceTimersByTime(5000);
  channel.receive([
    { clientId: 1, cursor: at('s1'), name: 'Bea' },
    { clientId: 2, cursor: at('s2'), name: 'Cal' },
  ]);
  expect(channel.peers[0].movedAt).toBe(first.movedAt);
  expect(channel.peers[0].seenAt).toBe(first.seenAt + 5000);
  expect(channel.peers[1].movedAt).toBe(first.movedAt + 5000);
  channel.receive([{ clientId: 1, cursor: at('s3'), name: 'Bea' }]);
  expect(channel.peers.map((peer) => peer.movedAt)).toEqual([
    first.movedAt + 5000,
  ]);
});

/** This editor's cursor goes out at most once per interval, the last one
 * always; a DOCX edit's move waits for the next send. */
it('sends its own cursor at most once per interval, the last one always', () => {
  const post = vi.fn();
  const channel = createCursorChannel(post);
  channel.send(at('s1'));
  channel.send(at('s2'));
  channel.send(at('s3'));
  expect(post.mock.calls).toEqual([[at('s1')]]);
  vi.advanceTimersByTime(CURSOR_SEND_MS);
  expect(post.mock.calls).toEqual([[at('s1')], [at('s3')]]);
  vi.advanceTimersByTime(CURSOR_SEND_MS);
  channel.send(at('s4'), false);
  expect(post).toHaveBeenCalledTimes(2);
  channel.send(null);
  expect(post.mock.calls.at(-1)).toEqual([null]);
});
