import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseDocumentModeSearch,
  parseWorkspaceOpenSearch,
  readDocumentMode,
  saveDocumentMode,
  searchFromOpenItem,
} from './openItem';

describe('parseWorkspaceOpenSearch', () => {
  it('keeps an explicit material mode from the URL', () => {
    expect(
      parseWorkspaceOpenSearch({ material: 'mat_1', mode: 'view' })
    ).toEqual({ material: 'mat_1', mode: 'view' });
  });

  it('drops an invalid material mode', () => {
    expect(
      parseWorkspaceOpenSearch({ material: 'mat_1', mode: 'preview' })
    ).toEqual({ material: 'mat_1' });
  });

  it.each(['view', 'edit'])('keeps file %s mode and citation page', (mode) => {
    expect(parseWorkspaceOpenSearch({ file: 'f_1', mode, page: '2' })).toEqual({
      file: 'f_1',
      mode,
      page: 2,
    });
    expect(parseDocumentModeSearch({ mode })).toEqual({ mode });
  });

  it('drops an invalid standalone document mode', () => {
    expect(parseDocumentModeSearch({ mode: 'invalid' })).toEqual({});
  });
});

describe('searchFromOpenItem', () => {
  it('omits mode so navigation uses the saved item preference', () => {
    expect(searchFromOpenItem({ id: 'mat_1', kind: 'material' })).toEqual({
      material: 'mat_1',
    });
  });

  it('keeps citation regions transient', () => {
    expect(
      searchFromOpenItem({
        id: 'file_1',
        kind: 'file',
        page: 2,
        regions: [
          {
            bbox: [100, 200, 300, 400],
            page: 2,
            space: 'page-1000-topleft',
          },
        ],
      })
    ).toEqual({ file: 'file_1', page: 2 });
  });
});

describe('document mode cache', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('remembers each file and material independently, defaulting to view', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const file = { id: '1', kind: 'file' as const };
    const material = { id: '1', kind: 'material' as const };
    expect(readDocumentMode(file)).toBe('view');
    saveDocumentMode(file, 'edit');
    expect(readDocumentMode(file)).toBe('edit');
    expect(readDocumentMode(material)).toBe('view');
    expect(readDocumentMode({ id: '2', kind: 'file' })).toBe('view');
    saveDocumentMode(material, 'edit');
    saveDocumentMode(file, 'view');
    expect(readDocumentMode(file)).toBe('view');
    expect(readDocumentMode(material)).toBe('edit');
  });

  it('keeps documents usable when browser storage is unavailable', () => {
    const denied = () => {
      throw new Error('Storage disabled');
    };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied });
    const item = { id: '1', kind: 'file' as const };
    expect(readDocumentMode(item)).toBe('view');
    expect(() => saveDocumentMode(item, 'edit')).not.toThrow();
  });
});
