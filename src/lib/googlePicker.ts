const GOOGLE_PROJECT_NUMBER = /^[1-9]\d*$/;

export function parseGooglePickerConfig(env: {
  apiKey?: string;
  appId?: string;
}): { apiKey: string; appId: string } {
  const apiKey = env.apiKey?.trim() ?? '';
  const appId = env.appId?.trim() ?? '';
  if (!apiKey || !GOOGLE_PROJECT_NUMBER.test(appId)) {
    throw new Error('GOOGLE_PICKER_CONFIG');
  }
  return { apiKey, appId };
}

export function googlePickerEnv(): { apiKey: string; appId: string } {
  return parseGooglePickerConfig({
    apiKey: import.meta.env.VITE_GOOGLE_PICKER_API_KEY,
    appId: import.meta.env.VITE_GOOGLE_PICKER_APP_ID,
  });
}

export interface GooglePicker {
  dispose: () => void;
  setVisible: (visible: boolean) => void;
}

interface GooglePickerBuilder {
  addView: (view: unknown) => GooglePickerBuilder;
  build: () => GooglePicker;
  enableFeature: (feature: string) => GooglePickerBuilder;
  setAppId: (id: string) => GooglePickerBuilder;
  setCallback: (
    callback: (data: { action: string; docs?: { id: string }[] }) => void
  ) => GooglePickerBuilder;
  setDeveloperKey: (key: string) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
  setOrigin: (origin: string) => GooglePickerBuilder;
}

declare global {
  interface Window {
    google?: {
      picker: {
        DocsView: new (
          viewId: string
        ) => {
          setIncludeFolders: (include: boolean) => unknown;
          setSelectFolderEnabled: (enabled: boolean) => unknown;
        };
        PickerBuilder: new () => GooglePickerBuilder;
        Feature: { MULTISELECT_ENABLED: string };
        ViewId: { DOCS: string };
      };
    };
  }
}

export function loadGooglePicker(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.picker) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      try {
        (
          window as unknown as {
            gapi: { load: (name: string, callback: () => void) => void };
          }
        ).gapi.load('picker', resolve);
      } catch (error) {
        reject(error);
      }
    };
    script.onerror = () => reject(new Error('failed to load google picker'));
    document.head.appendChild(script);
  });
}

export function createGooglePicker({
  apiKey,
  appId,
  accessToken,
  onResult,
}: {
  apiKey: string;
  appId: string;
  accessToken: string;
  onResult: (data: { action: string; docs?: { id: string }[] }) => void;
}): GooglePicker {
  const google = window.google?.picker;
  if (!google) throw new Error('Google Picker did not finish loading.');
  const view = new google.DocsView(google.ViewId.DOCS);
  view.setIncludeFolders(true);
  view.setSelectFolderEnabled(true);
  return new google.PickerBuilder()
    .addView(view)
    .enableFeature(google.Feature.MULTISELECT_ENABLED)
    .setOrigin(window.location.origin)
    .setDeveloperKey(apiKey)
    .setAppId(appId)
    .setOAuthToken(accessToken)
    .setCallback((data) => {
      if (['picked', 'cancel', 'error'].includes(data.action)) onResult(data);
    })
    .build();
}
