import { describe, expect, it } from 'vitest';
import type { MaterialRef, SourceFile, Workspace } from '@/api/types';
import { mergeRecentItems } from './recentItems';

const workspace = {
  id: 'ws_1',
  name: 'Biology',
} as Workspace;

function file(id: string, addedAt: string, workspaceId = 'ws_1'): SourceFile {
  return {
    addedAt,
    chapterId: null,
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
  createdAt: string
): { ref: MaterialRef; workspaceId: string; workspaceName: string } {
  return {
    ref: {
      chapterId: null,
      createdAt,
      id,
      maxDepth: 1,
      nodeCount: 1,
      position: 0,
      revision: 1,
      sizeBytes: 1,
      title: id,
      type: 'note',
    },
    workspaceId: 'ws_1',
    workspaceName: 'Biology',
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
});
