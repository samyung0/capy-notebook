import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openItemFromSearch,
  parseDocumentModeSearch,
  parseMaterialPageSearch,
  parseWorkspaceOpenSearch,
  readDocumentMode,
  saveDocumentMode,
  searchFromOpenItem,
} from './openItem';

describe('parseWorkspaceOpenSearch', () => {
  it.each(['view', 'edit'])(
    "ignores an old material link's %s mode",
    (mode) => {
      expect(parseWorkspaceOpenSearch({ material: 'mat_1', mode })).toEqual({
        material: 'mat_1',
      });
      expect(parseMaterialPageSearch({ mode })).toEqual({});
    }
  );

  it('keeps the question or card a review summary opens', () => {
    const search = parseWorkspaceOpenSearch({ item: 'q4', material: 'qz_1' });
    expect(search).toEqual({ item: 'q4', material: 'qz_1' });
    expect(openItemFromSearch(search)).toEqual({
      id: 'qz_1',
      kind: 'material',
      target: 'q4',
    });
  });

  it.each(['view', 'edit'])('keeps file %s mode and citation page', (mode) => {
    expect(parseWorkspaceOpenSearch({ file: 'f_1', mode, page: '2' })).toEqual({
      file: 'f_1',
      mode,
      page: 2,
    });
    expect(parseDocumentModeSearch({ mode })).toEqual({ mode });
  });

  it('keeps full screen with the open item', () => {
    expect(
      parseWorkspaceOpenSearch({ fullscreen: 'true', material: 'mat_1' })
    ).toEqual({ fullscreen: true, material: 'mat_1' });
    expect(parseDocumentModeSearch({ fullscreen: true })).toEqual({
      fullscreen: true,
    });
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

  it('opens settings at a tab and Practice with its session or result from the URL, ignoring other values', () => {
    expect(
      parseWorkspaceOpenSearch({ settings: 'others', study: 'practice' })
    ).toMatchObject({ settings: 'others', study: 'practice' });
    expect(
      parseWorkspaceOpenSearch({
        group: 'topic',
        reviewMode: 'fading',
        study: 'practice',
        topicId: 't1',
      })
    ).toMatchObject({
      group: 'topic',
      reviewMode: 'fading',
      study: 'practice',
      topicId: 't1',
    });
    expect(
      parseWorkspaceOpenSearch({ review: 's1', study: 'practice' })
    ).toMatchObject({ review: 's1', study: 'practice' });
    expect(
      parseWorkspaceOpenSearch({ file: 'f1', settings: 'danger' })
    ).toMatchObject({ file: 'f1', settings: 'danger' });
    expect(
      parseWorkspaceOpenSearch({
        group: 'topic',
        settings: 'bogus',
        study: 'yes',
      })
    ).toEqual({
      group: undefined,
      review: undefined,
      reviewMode: undefined,
      settings: undefined,
      study: undefined,
      topicId: undefined,
    });
  });
});
