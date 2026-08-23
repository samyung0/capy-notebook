export const PERSONAL_PICKER_ORIGIN = 'https://onedrive.live.com';
export const PERSONAL_PICKER_URL = 'https://onedrive.live.com/picker';

const TRAILING_SLASHES = /\/+$/;
const CONSENT_BLOCKED =
  /AADSTS65001|AADSTS90094|consent_required|access_denied/i;
const USER_CANCELLED = /user_cancelled|user_canceled/i;

export type PickerKind = 'personal' | 'work';

export type DriveHost = {
  driveType: string;
  id?: string;
  webUrl: string;
};

export type PickerHost = {
  kind: PickerKind;
  origin: string;
  pickerUrl: string;
  tokenResource: string;
};

export type ImportSourceRef = {
  driveId?: string;
  id: string;
};

export function pickerHostFromDrive(drive: DriveHost): PickerHost {
  if (drive.driveType.trim().toLowerCase() === 'personal') {
    return {
      kind: 'personal',
      origin: PERSONAL_PICKER_ORIGIN,
      pickerUrl: PERSONAL_PICKER_URL,
      tokenResource: PERSONAL_PICKER_ORIGIN,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(drive.webUrl);
  } catch (cause) {
    throw new Error('invalid drive webUrl', { cause });
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('invalid drive webUrl');
  }
  return {
    kind: 'work',
    origin: parsed.origin,
    pickerUrl: `${parsed.origin}/_layouts/15/FilePicker.aspx`,
    tokenResource: parsed.origin,
  };
}

export function pickerTokenScopes(
  kind: PickerKind,
  resource: string
): string[] {
  if (kind === 'personal') return ['OneDrive.ReadOnly'];
  const base = resource.replace(TRAILING_SLASHES, '');
  if (!base) throw new Error('missing picker resource');
  return [`${base}/.default`];
}

export function isAllowedPickerOrigin(
  origin: string,
  host: PickerHost
): boolean {
  return origin === host.origin;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function parsePickedItems(command: unknown): ImportSourceRef[] {
  if (!command || typeof command !== 'object') return [];
  const items = (command as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: ImportSourceRef[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as {
      id?: unknown;
      parentReference?: { driveId?: unknown };
    };
    const id = readString(rec.id);
    if (!id) continue;
    const driveId = readString(rec.parentReference?.driveId);
    out.push(driveId ? { driveId, id } : { id });
  }
  return out;
}

export function pickerErrorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const rec = err as {
      errorCode?: unknown;
      errorMessage?: unknown;
      message?: unknown;
    };
    return [rec.errorCode, rec.message, rec.errorMessage]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
  }
  return String(err ?? '');
}

export function isPickerUserCancelled(err: unknown): boolean {
  if (err instanceof Error && err.message === 'PICKER_CANCELLED') return true;
  return USER_CANCELLED.test(pickerErrorText(err));
}

export function isPickerConsentBlocked(err: unknown): boolean {
  if (err instanceof Error && err.message === 'PICKER_CONSENT') return true;
  return CONSENT_BLOCKED.test(pickerErrorText(err));
}

export function toImportRequest(
  provider: 'google' | 'microsoft',
  refs: ImportSourceRef[],
  chapterId?: string | null
) {
  const fileIds = refs.map((ref) => ref.id);
  const driveIds = refs.map((ref) => ref.driveId ?? '');
  return {
    chapterId,
    fileIds,
    provider,
    ...(provider === 'microsoft' && driveIds.some(Boolean) ? { driveIds } : {}),
  };
}

export function pickerLocale(locale: string): string {
  if (locale.startsWith('zh')) return 'zh-cn';
  return 'en-us';
}

type PickerCommand = {
  command?: string;
  resource?: string;
};

type ChannelPayload = {
  data?: PickerCommand;
  id?: string;
  type?: string;
};

export async function openOneDrivePicker(opts: {
  acquireToken: (input: {
    kind: PickerKind;
    loginHint?: string;
    resource: string;
  }) => Promise<string>;
  clearAuth: () => Promise<void>;
  drive: DriveHost;
  locale?: string;
  loginHint?: string;
  openWindow?: () => Window | null;
}): Promise<ImportSourceRef[]> {
  const host = pickerHostFromDrive(opts.drive);
  const win = (
    opts.openWindow ??
    (() => window.open('', 'OneDrivePicker', 'width=1080,height=680'))
  )();
  if (!win) throw new Error('POPUP_BLOCKED');

  const channelId = crypto.randomUUID();
  let port: MessagePort | undefined;
  let closedPoll = 0;
  let settled = false;
  let onInit: ((event: MessageEvent) => void) | undefined;

  const cleanup = async () => {
    if (onInit) window.removeEventListener('message', onInit);
    window.clearInterval(closedPoll);
    port?.close();
    if (!win.closed) win.close();
    await opts.clearAuth();
  };

  try {
    await opts.acquireToken({
      kind: host.kind,
      loginHint: opts.loginHint,
      resource: host.tokenResource,
    });
  } catch (err) {
    await cleanup();
    throw err;
  }

  if (win.closed) {
    await opts.clearAuth();
    return [];
  }

  const options = {
    authentication: {},
    entry: { oneDrive: { files: {} } },
    messaging: {
      channelId,
      origin: window.location.origin,
    },
    sdk: '8.0',
    selection: { mode: 'multiple' },
    typesAndSources: {
      mode: 'files',
      pivots: { oneDrive: true, recent: true },
    },
  };
  const url = `${host.pickerUrl}?${new URLSearchParams({
    filePicker: JSON.stringify(options),
    locale: opts.locale ?? 'en-us',
  })}`;

  // No hidden access_token field. Personal is a GET page. Work FilePicker.aspx
  // accepts POST of the config query string; tokens arrive on authenticate.
  if (host.kind === 'personal') {
    win.location.assign(url);
  } else {
    const form = win.document.createElement('form');
    form.setAttribute('action', url);
    form.setAttribute('method', 'POST');
    win.document.body.append(form);
    form.submit();
  }

  return new Promise<ImportSourceRef[]>((resolve, reject) => {
    const settle = (items: ImportSourceRef[], err?: unknown) => {
      if (settled) return;
      settled = true;
      void cleanup()
        .then(() => {
          if (err) reject(err);
          else resolve(items);
        })
        .catch(reject);
    };

    async function onChannel(message: MessageEvent) {
      const payload = message.data as ChannelPayload;
      if (payload?.type === 'notification') return;
      if (payload?.type !== 'command') return;
      port?.postMessage({ id: payload.id, type: 'acknowledge' });
      const command = payload.data;
      const name = command?.command;
      if (name === 'authenticate') {
        try {
          const resource = command?.resource || host.tokenResource;
          const token = await opts.acquireToken({
            kind: host.kind,
            loginHint: opts.loginHint,
            resource,
          });
          port?.postMessage({
            data: { result: 'token', token },
            id: payload.id,
            type: 'result',
          });
        } catch (err) {
          port?.postMessage({
            data: {
              error: {
                code: 'unableToObtainToken',
                message: pickerErrorText(err),
              },
              result: 'error',
            },
            id: payload.id,
            type: 'result',
          });
          settle([], err);
        }
        return;
      }
      if (name === 'close') {
        settle([]);
        return;
      }
      if (name === 'pick') {
        port?.postMessage({
          data: { result: 'success' },
          id: payload.id,
          type: 'result',
        });
        settle(parsePickedItems(command));
        return;
      }
      port?.postMessage({
        data: {
          error: { code: 'unsupportedCommand', message: name },
          result: 'error',
        },
        id: payload.id,
        type: 'result',
      });
    }

    onInit = (event: MessageEvent) => {
      if (event.source !== win) return;
      if (!isAllowedPickerOrigin(event.origin, host)) return;
      const message = event.data as { channelId?: string; type?: string };
      if (message?.type !== 'initialize' || message.channelId !== channelId) {
        return;
      }
      const next = event.ports[0];
      if (!next) {
        settle([], new Error('picker_channel'));
        return;
      }
      port = next;
      next.addEventListener('message', (msg) => {
        void onChannel(msg);
      });
      next.start();
      next.postMessage({ type: 'activate' });
    };

    window.addEventListener('message', onInit);
    closedPoll = window.setInterval(() => {
      if (win.closed) settle([]);
    }, 400);
  });
}
