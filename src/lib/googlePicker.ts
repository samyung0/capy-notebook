export function parseGooglePickerConfig(env: {
  apiKey?: string;
  appId?: string;
}): { apiKey: string; appId: string } {
  const apiKey = env.apiKey?.trim() ?? '';
  const appId = env.appId?.trim() ?? '';
  if (!apiKey || !appId) {
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
