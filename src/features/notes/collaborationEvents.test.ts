import { describe, expect, it } from 'vitest';

import { parseCollaborationEvent } from './collaborationEvents';

describe('parseCollaborationEvent', () => {
  it('reads which embedded item changed', () => {
    expect(
      parseCollaborationEvent(
        JSON.stringify({
          id: 'm_quiz',
          kind: 'quiz',
          materialId: 'm_note',
          room: 'material:m_note:schema:1',
          type: 'embed-changed',
        })
      )
    ).toEqual({ id: 'm_quiz', kind: 'quiz', type: 'embed-changed' });
    expect(
      parseCollaborationEvent(
        JSON.stringify({ id: 'm_note', kind: 'note', type: 'embed-changed' })
      )
    ).toBeNull();
  });
});
