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

  it('keeps a paste of many uploads inside the server awareness entry', () => {
    const { uploader } = room();
    uploader.setLocalStateField('cursor', {
      anchor: { assoc: 0, item: { client: 2 ** 31, clock: 1e6 }, type: null },
      focus: { assoc: 0, item: { client: 2 ** 31, clock: 1e6 }, type: null },
    });
    uploader.setLocalStateField('data', {
      color: '#7c3aed',
      name: 'A'.repeat(80),
    });
    // Placeholder ids are nanoids, 21 characters.
    for (let n = 0; n < 2500; n++)
      announceUpload(uploader, n.toString(36).padStart(21, '0'));
    // The room keeps entries up to 64 KiB (MAX_AWARENESS_ENTRY).
    expect(JSON.stringify(uploader.getLocalState()).length).toBeLessThan(
      64 * 1024
    );
  });
});
