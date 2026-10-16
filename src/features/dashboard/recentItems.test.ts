import { describe, expect, it } from 'vitest';
import type { MaterialListItem, SourceFile, Workspace } from '@/api/types';
import { mergeRecentItems } from './recentItems';

const workspace = {
  canClone: true,
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
    status: 'ready',
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

  it('caps the list', () => {
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
    });
  });

  it('allows edits in editable workspaces and on standalone materials only', () => {
    const viewer = {
      canClone: true,
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

  it('offers Clone where the workspace allows it, on ready and partial files only', () => {
    const linkViewer = {
      canClone: false,
      capabilities: { canEdit: false },
      id: 'ws_3',
      name: 'Public',
    } as Workspace;
    const items = mergeRecentItems(
      [
        file('f_ready', '2026-04-01T00:00:00.000Z'),
        {
          ...file('f_parsing', '2026-03-01T00:00:00.000Z'),
          status: 'processing',
        },
        // Failed but still indexed: a part missing (parts design Q2).
        {
          ...file('f_partial', '2026-02-20T00:00:00.000Z'),
          status: 'failed',
        },
        {
          ...file('f_failed', '2026-02-10T00:00:00.000Z'),
          indexed: false,
          status: 'failed',
        },
        file('f_public', '2026-02-01T00:00:00.000Z', 'ws_3'),
      ],
      [material('m_solo', '2026-01-01T00:00:00.000Z', '')],
      [workspace, linkViewer]
    );
    expect(items.map((item) => [item.id, item.canClone])).toEqual([
      ['f_ready', true],
      ['f_parsing', false],
      ['f_partial', true],
      ['f_failed', false],
      ['f_public', false],
      ['m_solo', true],
    ]);
  });
});
