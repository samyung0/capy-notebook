import {
  type Configuration,
  InteractionRequiredAuthError,
  PublicClientApplication,
} from '@azure/msal-browser';
import {
  isPickerConsentBlocked,
  isPickerUserCancelled,
  type PickerKind,
  pickerTokenScopes,
} from '@/lib/onedrivePicker';

const KIND_AUTHORITY = {
  personal: 'https://login.microsoftonline.com/consumers',
  work: 'https://login.microsoftonline.com/organizations',
} as const;

let appPromise: Promise<PublicClientApplication> | undefined;

function configuredAuthority(): string | undefined {
  const value = import.meta.env.VITE_MSAL_AUTHORITY?.trim();
  return value || undefined;
}

function msalClientId(): string {
  const id = import.meta.env.VITE_MSAL_CLIENT_ID?.trim() ?? '';
  if (!id) throw new Error('MSAL_CONFIG');
  return id;
}

export function assertMsalConfigured(): void {
  msalClientId();
}

export async function msalPickerApp(): Promise<PublicClientApplication> {
  if (!appPromise) {
    const config: Configuration = {
      auth: {
        authority:
          configuredAuthority() ?? 'https://login.microsoftonline.com/common',
        clientId: msalClientId(),
        redirectUri: `${window.location.origin}/msal-redirect.html`,
      },
      cache: {
        cacheLocation: 'sessionStorage',
      },
    };
    const app = new PublicClientApplication(config);
    appPromise = app.initialize().then(() => app);
  }
  return appPromise;
}

function requestAuthority(kind: PickerKind) {
  if (configuredAuthority()) return;
  return KIND_AUTHORITY[kind];
}

export async function acquirePickerToken(input: {
  kind: PickerKind;
  loginHint?: string;
  resource: string;
}): Promise<string> {
  const app = await msalPickerApp();
  const scopes = pickerTokenScopes(input.kind, input.resource);
  const authority = requestAuthority(input.kind);
  const request = {
    ...(authority ? { authority } : {}),
    loginHint: input.loginHint,
    scopes,
  };
  const account = app.getActiveAccount() ?? app.getAllAccounts()[0];
  if (account) {
    try {
      const silent = await app.acquireTokenSilent({
        ...request,
        account,
      });
      return silent.accessToken;
    } catch (err) {
      if (isPickerConsentBlocked(err)) throw err;
    }
  }
  try {
    const popup = await app.acquireTokenPopup(request);
    app.setActiveAccount(popup.account);
    return popup.accessToken;
  } catch (err) {
    if (isPickerUserCancelled(err)) {
      throw new Error('PICKER_CANCELLED', { cause: err });
    }
    if (
      isPickerConsentBlocked(err) ||
      err instanceof InteractionRequiredAuthError
    ) {
      throw new Error('PICKER_CONSENT', { cause: err });
    }
    throw err;
  }
}

export async function clearPickerAuth(): Promise<void> {
  if (!appPromise) return;
  const app = await appPromise;
  await app.clearCache();
  app.setActiveAccount(null);
}
