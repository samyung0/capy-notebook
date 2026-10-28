import { describe, expect, it } from 'vitest';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { announceUpload, uploadingElsewhere } from './uploadPresence';

/** Two clients of one room: what `from` says reaches `to`. */
function room() {
  const uploader = new Awareness(new Y.Doc());
  const other = new Awareness(new Y.Doc());
  const relay = () =>
    applyAwarenessUpdate(
      other,
      encodeAwarenessUpdate(uploader, [uploader.clientID]),
      'remote'
    );
  return { other, relay, uploader };
}

const seenByOther = ({ other }: ReturnType<typeof room>, id: string) =>
  uploadingElsewhere(other.getStates(), other.clientID, id);

describe('uploads in presence', () => {
  it("shows another client's upload until it finishes", () => {
    const clients = room();
    const finish = announceUpload(clients.uploader, 'block-a');
    const second = announceUpload(clients.uploader, 'block-b');
    clients.relay();
    expect(seenByOther(clients, 'block-a')).toBe(true);
    expect(seenByOther(clients, 'block-b')).toBe(true);
    expect(seenByOther(clients, 'block-c')).toBe(false);
    // The uploader's own upload is not someone else's.
    const { uploader } = clients;
    expect(
      uploadingElsewhere(uploader.getStates(), uploader.clientID, 'block-a')
    ).toBe(false);

    finish();
    clients.relay();
    expect(seenByOther(clients, 'block-a')).toBe(false);
    expect(seenByOther(clients, 'block-b')).toBe(true);
    second();
    clients.relay();
    expect(seenByOther(clients, 'block-b')).toBe(false);
    // Nothing left to send (JSON leaves an undefined field out).
    expect(uploader.getLocalState()?.uploads).toBeUndefined();
  });

  it('forgets an upload whose client left', () => {
    const clients = room();
    announceUpload(clients.uploader, 'block-a');
    clients.relay();
    expect(seenByOther(clients, 'block-a')).toBe(true);
    // The server drops a closed channel's presence (a timeout does the same).
    removeAwarenessStates(clients.other, [clients.uploader.clientID], 'server');
    expect(seenByOther(clients, 'block-a')).toBe(false);
  });

  // REVIEW5 E1, E3; Epo 2026-10-28: the room keeps a state of at most 4 KiB
  // whose uploads are at most 100 ids of at most 32 characters, and a
  // receiver reads no other.
  it('names at most 100 uploads, and reads no list past the bounds', () => {
    const clients = room();
    const { uploader } = clients;
    // Placeholder ids are nanoids, 21 characters.
    const id = (n: number) => n.toString(36).padStart(21, '0');
    for (let n = 0; n < 150; n++) announceUpload(uploader, id(n));
    announceUpload(uploader, 'x'.repeat(33));
    expect(uploader.getLocalState()?.uploads).toHaveLength(100);
    expect(JSON.stringify(uploader.getLocalState()).length).toBeLessThan(
      4 * 1024
    );
    clients.relay();
    expect(seenByOther(clients, id(99))).toBe(true);
    expect(seenByOther(clients, id(100))).toBe(false);

    // A hostile list, past the bounds: none of it counts.
    const { other } = clients;
    const hostile = new Awareness(new Y.Doc());
    const seen = (lists: unknown[]) => {
      hostile.setLocalStateField('uploads', lists);
      applyAwarenessUpdate(
        other,
        encodeAwarenessUpdate(hostile, [hostile.clientID]),
        'remote'
      );
      return uploadingElsewhere(other.getStates(), other.clientID, 'h0');
    };
    expect(seen(['h0'])).toBe(true);
    expect(seen(['h0', 'x'.repeat(33)])).toBe(false);
    expect(seen(Array.from({ length: 101 }, (_, n) => `h${n}`))).toBe(false);
  });
});
