import { describe, expect, it } from 'vitest';
import {
  fileListParams,
  materialListParams,
  parseFilesSearch,
  parseWorkspacesSearch,
  sortSearch,
  workspaceListParams,
} from './listSearch';

describe('list search', () => {
  it("keeps each Files tab's own sort and filters and drops the rest", () => {
    expect(
      parseFilesSearch({
        dir: 'up',
        kind: 'pdf,quiz,doc',
        location: 'standalone',
        sort: 'title',
        workspace: 'ws_a,ws_b',
      })
    ).toEqual({ kind: 'pdf,doc', workspace: 'ws_a,ws_b' });
    expect(
      parseFilesSearch({
        dir: 'asc',
        kind: 'pdf,quiz',
        location: 'standalone',
        sort: 'title',
        tab: 'blocks',
      })
    ).toEqual({
      dir: 'asc',
      kind: 'quiz',
      location: 'standalone',
      sort: 'title',
      tab: 'blocks',
    });
    expect(parseFilesSearch({ sort: 'name', tab: 'trash' })).toEqual({
      tab: 'trash',
    });
    // The router parses number-like values; a tag can be one.
    expect(parseWorkspacesSearch({ tag: 2024 })).toEqual({ tag: '2024' });
  });

  it('builds the list queries the loaders prefetch', () => {
    expect(fileListParams({})).toEqual({ dir: 'desc', sort: 'added' });
    expect(
      materialListParams({
        dir: 'asc',
        kind: 'note',
        location: 'workspace',
        tab: 'blocks',
        workspace: 'ws_a',
      })
    ).toEqual({
      dir: 'asc',
      kinds: ['note'],
      locations: ['workspace'],
      sort: 'updated',
      workspaceIds: ['ws_a'],
    });
    expect(workspaceListParams({ tag: 'bio,chem' })).toEqual({
      sort: 'created',
      tag: ['bio', 'chem'],
    });
    expect(sortSearch('added', false, 'added')).toEqual({});
  });
});
