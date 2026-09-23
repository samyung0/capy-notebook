import { describe, expect, it } from 'vitest';
import type { MaterialListItem, SourceFile, Workspace } from '@/api/types';
import { mergeRecentItems } from './recentItems';

const workspace = {
  capabilities: { canEdit: true },
  id: 'ws_1',
  name: 'Biology',
} as Workspace;

function file(id: string, addedAt: string, workspaceId = 'ws_1'): SourceFile {
  return {
    addedAt,
    chapterId: null,
    hasBytes: true,
    id,
    indexed: true,
    kind: 'pdf',
    name: `${id}.pdf`,
    position: 0,
    revision: 1,
    sizeBytes: 1,
    workspaceId,
  };
}

function material(
  id: string,
  createdAt: string,
  workspaceId = 'ws_1'
): MaterialListItem {
  return {
    chapterId: null,
    chapterName: '',
    createdAt,
    id,
    kind: 'note',
    parentMaterialId: '',
    parentTitle: '',
    privacy: 'private',
    sizeBytes: 1,
    title: id,
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
      [workspace]
    );
    expect(items.map((item) => item.id)).toEqual(['f_new', 'm_mid', 'f_old']);
  });

  it('caps the list and fills workspace names from the workspace list', () => {
    const items = mergeRecentItems(
      [file('f_1', '2026-04-01T00:00:00.000Z')],
      [],
      [workspace],
      1
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'file',
      title: 'f_1.pdf',
      workspaceName: 'Biology',
    });
  });

  it('allows edits in editable workspaces and on standalone materials only', () => {
    const viewer = {
      capabilities: { canEdit: false },
      id: 'ws_2',
      name: 'Shared',
    } as Workspace;
    const items = mergeRecentItems(
      [file('f_shared', '2026-04-01T00:00:00.000Z', 'ws_2')],
      [
        material('m_own', '2026-03-01T00:00:00.000Z'),
        material('m_solo', '2026-02-01T00:00:00.000Z', ''),
      ],
      [workspace, viewer]
    );
    expect(items.map((item) => [item.id, item.canEdit])).toEqual([
      ['f_shared', false],
      ['m_own', true],
      ['m_solo', true],
    ]);
  });
});
