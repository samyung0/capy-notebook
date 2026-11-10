import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  itemListParams,
  parseFilesSearch,
  parseWorkspacesSearch,
  savedSort,
  sortSearch,
  workspaceListParams,
} from './listSearch';

describe('list search', () => {
  it("keeps the Files list's sort and filters and drops the rest", () => {
    // Files and blocks filter by kind together.
    expect(
      parseFilesSearch({
        dir: 'up',
        kind: 'pdf,quiz,bogus',
        location: 'workspace',
        owner: 'all',
        sort: 'name',
        workspace: 'ws_a,ws_b',
      })
    ).toEqual({
      kind: 'pdf,quiz',
      location: 'workspace',
      owner: 'all',
      sort: 'name',
      workspace: 'ws_a,ws_b',
    });
    // The default tab named in the URL keeps them and drops out.
    expect(parseFilesSearch({ sort: 'name', tab: 'files' })).toEqual({
      sort: 'name',
    });
    // Canvas and Trash keep only their tab.
    expect(parseFilesSearch({ sort: 'name', tab: 'trash' })).toEqual({
      tab: 'trash',
    });
    // The router parses number-like values; a tag can be one.
    expect(parseWorkspacesSearch({ tag: 2024 })).toEqual({ tag: '2024' });
  });

  it('builds the list queries the loaders prefetch', () => {
    expect(itemListParams({})).toEqual({ dir: 'desc', sort: 'added' });
    expect(
      itemListParams({
        dir: 'asc',
        kind: 'note,pdf',
        location: 'workspace',
        owner: 'all',
        workspace: 'ws_a',
      })
    ).toEqual({
      dir: 'asc',
      kinds: ['note', 'pdf'],
      locations: ['workspace'],
      scope: 'all',
      sort: 'added',
      workspaceIds: ['ws_a'],
    });
    expect(workspaceListParams({})).toEqual({ sort: 'accessed' });
    expect(workspaceListParams({ tag: 'bio,chem' })).toEqual({
      sort: 'accessed',
      tag: ['bio', 'chem'],
    });
    expect(sortSearch('files', 'added', false, 'added')).toEqual({});
  });
});

describe('remembered sort', () => {
  afterEach(() => vi.unstubAllGlobals());
  function stubStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    return store;
  }
  const SORTS = ['date', 'score'] as const;

  it('comes back only when the URL names no sort', () => {
    stubStorage();
    sortSearch('results', 'score', true, 'date');
    expect(savedSort('results', SORTS, 'date', {})).toEqual({
      dir: 'asc',
      sort: 'score',
    });
    expect(savedSort('results', SORTS, 'date', { sort: 'date' })).toBe(
      undefined
    );
  });

  // A redirect to a default or unknown sort would land on a URL without one
  // and redirect again.
  it('never returns a default or unknown sort', () => {
    const store = stubStorage();
    store.set('capy.sort.results', JSON.stringify({ sort: 'date' }));
    expect(savedSort('results', SORTS, 'date', {})).toBe(undefined);
    store.set('capy.sort.results', JSON.stringify({ sort: 'bogus' }));
    expect(savedSort('results', SORTS, 'date', {})).toBe(undefined);
  });
});
