import { expect, it } from 'vitest';
import { parseCollaborationEvent } from './collaborationEvents';

const parse = (event: object) => parseCollaborationEvent(JSON.stringify(event));

// Edits under a client id the room did not assign are refused with their
// own code (Epo 2026-10-24).
it('reads a refusal of edits under an unassigned client id', () => {
  const room = 'material:m:schema:1';
  expect(
    parse({
      code: 'client_id',
      materialId: 'm',
      room,
      type: 'document-rejected',
    })
  ).toEqual({
    code: 'client_id',
    materialId: 'm',
    metrics: null,
    room,
    type: 'document-rejected',
  });
});

// A room holding a block this version cannot edit says so, and the editor
// shows why it opened read-only (decision 5, Epo 2026-10-13).
it('reads why a room is read-only, when it says', () => {
  const room = 'material:m:schema:1';
  expect(
    parse({ code: 'unsupported_block', room, type: 'room-read-only' })
  ).toEqual({ code: 'unsupported_block', room, type: 'room-read-only' });
  expect(parse({ room, type: 'room-read-only' })).toEqual({
    room,
    type: 'room-read-only',
  });
  expect(parse({ code: 'other', room, type: 'room-read-only' })).toEqual({
    room,
    type: 'room-read-only',
  });
});
