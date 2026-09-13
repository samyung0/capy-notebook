import { afterEach, expect, it, vi } from 'vitest';
import { createGooglePicker } from './googlePicker';

afterEach(() => vi.unstubAllGlobals());

it('enables multi-select and forwards selection, cancellation and errors, ignoring load events', () => {
  type Result = Parameters<
    Parameters<typeof createGooglePicker>[0]['onResult']
  >[0];
  let callback: ((data: Result) => void) | undefined;
  const picker = { dispose: vi.fn(), setVisible: vi.fn() };
  const builder = {
    addView: vi.fn().mockReturnThis(),
    build: () => picker,
    enableFeature: vi.fn().mockReturnThis(),
    setAppId: vi.fn().mockReturnThis(),
    setCallback: vi.fn((fn: (data: Result) => void) => {
      callback = fn;
      return builder;
    }),
    setDeveloperKey: vi.fn().mockReturnThis(),
    setOAuthToken: vi.fn().mockReturnThis(),
    setOrigin: vi.fn().mockReturnThis(),
  };
  const includeFolders = vi.fn();
  const selectFolders = vi.fn();
  vi.stubGlobal('window', {
    google: {
      picker: {
        DocsView: class {
          setIncludeFolders = includeFolders;
          setSelectFolderEnabled = selectFolders;
        },
        Feature: { MULTISELECT_ENABLED: 'multiselect' },
        PickerBuilder: class {
          constructor() {
            Object.assign(this, builder);
          }
        },
        ViewId: { DOCS: 'docs' },
      },
    },
    location: { origin: 'https://uat.capynotebook.com' },
  });
  const onResult = vi.fn();
  expect(
    createGooglePicker({
      accessToken: 'token',
      apiKey: 'key',
      appId: '648035563420',
      onResult,
    })
  ).toBe(picker);
  expect(builder.enableFeature).toHaveBeenCalledWith('multiselect');
  expect(builder.setAppId).toHaveBeenCalledWith('648035563420');
  expect(builder.setOrigin).toHaveBeenCalledWith(
    'https://uat.capynotebook.com'
  );
  expect(includeFolders).toHaveBeenCalledWith(true);
  expect(selectFolders).toHaveBeenCalledWith(true);
  callback?.({ action: 'loaded' });
  expect(onResult).not.toHaveBeenCalled();
  const selected = { action: 'picked', docs: [{ id: 'one' }, { id: 'two' }] };
  callback?.(selected);
  callback?.({ action: 'cancel' });
  callback?.({ action: 'error' });
  expect(onResult.mock.calls).toEqual([
    [selected],
    [{ action: 'cancel' }],
    [{ action: 'error' }],
  ]);
});
