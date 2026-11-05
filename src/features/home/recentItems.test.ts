import { describe, expect, it } from 'vitest';
import type { MaterialListItem, SourceFile } from '@/api/types';
import { fromRecent, mergeRecentItems } from './recentItems';

function file(id: string, addedAt: string, workspaceId = 'ws_1'): SourceFile {
  return {
    addedAt,
    hasBytes: true,
    id,
    indexed: true,
    isPayer: true,
    kind: 'pdf',
    name: `${id}.pdf`,
    position: 0,
    revision: 1,
    sizeBytes: 1,
    status: 'ready',
    topicId: null,
    workspaceId,
  };
}

function material(
  id: string,
  createdAt: string,
  workspaceId = 'ws_1'
): MaterialListItem {
  return {
    createdAt,
    id,
    kind: 'note',
    privacy: 'private',
    sizeBytes: 1,
    title: id,
    topicId: null,
    topicName: '',
    updatedAt: createdAt,
    workspaceId,
    workspaceName: workspaceId ? 'Biology' : '',
  };
}

describe('mergeRecentItems', () => {
  it('sorts files and materials by created time, newest first', () => {
    const items = mergeRecentItems(
      [
        file('f_old', '2026-01-01T00:00:00.000Z'),
        file('f_new', '2026-03-01T00:00:00.000Z'),
      ],
      [material('m_mid', '2026-02-01T00:00:00.000Z')],
      10
    );
    expect(items.map((item) => item.id)).toEqual(['f_new', 'm_mid', 'f_old']);
  });

  it('caps the list', () => {
    const items = mergeRecentItems(
      [file('f_1', '2026-04-01T00:00:00.000Z')],
      [],
      1
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'file',
      title: 'f_1.pdf',
    });
  });
});

describe('fromRecent', () => {
  it('keeps the server open order with each open time', () => {
    const items = fromRecent([
      {
        file: file('f_1', '2026-04-01T00:00:00.000Z'),
        openedAt: '2026-06-02T00:00:00.000Z',
      },
      {
        material: material('m_1', '2026-05-01T00:00:00.000Z'),
        openedAt: '2026-06-01T00:00:00.000Z',
      },
    ]);
    expect(items.map((item) => [item.id, item.openedAt])).toEqual([
      ['f_1', '2026-06-02T00:00:00.000Z'],
      ['m_1', '2026-06-01T00:00:00.000Z'],
    ]);
  });
});
