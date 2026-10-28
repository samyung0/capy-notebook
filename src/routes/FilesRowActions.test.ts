import { describe, expect, it } from 'vitest';
import type { SourceFile } from '@/api/types';
import { fileRowActions } from './Files';

const file = (fields: Partial<SourceFile>) =>
  ({ id: 'f_1', indexed: true, status: 'ready', ...fields }) as SourceFile;

describe('Files tab rows', () => {
  it('follow the rights the server read with the page', () => {
    // Someone else's file in a workspace where the caller is a viewer.
    expect(
      fileRowActions(
        file({
          rights: { clone: true, move: false, rename: false, trash: false },
        })
      )
    ).toEqual({
      canClone: true,
      canMoveTo: false,
      canRename: false,
      readOnly: true,
    });
    // Its own upload there: trash and move as the payer, no rename.
    expect(
      fileRowActions(
        file({
          rights: { clone: true, move: true, rename: false, trash: true },
        })
      )
    ).toEqual({
      canClone: true,
      canMoveTo: true,
      canRename: false,
      readOnly: false,
    });
    // A partial file clones as the server allows.
    expect(
      fileRowActions(
        file({
          rights: { clone: true, move: true, rename: true, trash: true },
          status: 'failed',
        })
      ).canClone
    ).toBe(true);
  });
});
