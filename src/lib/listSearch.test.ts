import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fileListParams,
  materialListParams,
  parseFilesSearch,
  parseWorkspacesSearch,
  savedSort,
  sortSearch,
  workspaceListParams,
} from './listSearch';

describe('list search', () => {
  it("keeps each Files tab's own sort and filters and drops the rest", () => {
    expect(
      parseFilesSearch({
        dir: 'up',
        kind: 'pdf,quiz,doc',
        location: 'workspace',
        owner: 'all',
        sort: 'title',
        workspace: 'ws_a,ws_b',
      })
    ).toEqual({
      kind: 'pdf,doc',
      location: 'workspace',
      owner: 'all',
      workspace: 'ws_a,ws_b',
    });
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
    // Embeds keeps only its access filter, and only a known one.
    expect(
      parseFilesSearch({ access: 'lost', kind: 'pdf', tab: 'embeds' })
    ).toEqual({ access: 'lost', tab: 'embeds' });
    expect(parseFilesSearch({ access: 'all', tab: 'embeds' })).toEqual({
      access: undefined,
      tab: 'embeds',
    });
    // The router parses number-like values; a tag can be one.
    expect(parseWorkspacesSearch({ tag: 2024 })).toEqual({ tag: '2024' });
  });

  it('builds the list queries the loaders prefetch', () => {
    expect(fileListParams({})).toEqual({ dir: 'desc', sort: 'added' });
    expect(fileListParams({ location: 'workspace', owner: 'all' })).toEqual({
      dir: 'desc',
      locations: ['workspace'],
      scope: 'all',
      sort: 'added',
    });
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
