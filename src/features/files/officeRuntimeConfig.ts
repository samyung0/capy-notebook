export interface OfficeRuntimeConfig {
  /** Permissions policy: the editors' Cut, Copy and Paste menu items use the clipboard. */
  allow: string;
  error: string | null;
  origin: string;
  sandbox: string;
  url: string;
}

export function resolveOfficeRuntimeConfig({
  appOrigin,
  configuredOrigin,
  production,
}: {
  appOrigin: string;
  configuredOrigin: string;
  production: boolean;
}): OfficeRuntimeConfig {
  const configured = configuredOrigin.trim();
  let origin = appOrigin;
  let error: string | null = null;
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('unsupported protocol');
      }
      origin = parsed.origin;
    } catch {
      error = 'The Office runtime origin is invalid.';
    }
  }
  if (production && origin === appOrigin) {
    error = 'The Office runtime must use a separate origin in production.';
  }
  const url = new URL('/office-runtime.html', origin);
  url.searchParams.set('parentOrigin', appOrigin);
  return {
    allow: 'clipboard-read; clipboard-write; fullscreen',
    error,
    origin,
    sandbox: 'allow-same-origin allow-scripts',
    url: url.href,
  };
}

export function getOfficeRuntimeConfig(): OfficeRuntimeConfig {
  return resolveOfficeRuntimeConfig({
    appOrigin: window.location.origin,
    configuredOrigin: String(import.meta.env.VITE_OFFICE_RUNTIME_ORIGIN ?? ''),
    production: import.meta.env.PROD,
  });
}

export function parentOriginFromRuntimeUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get('parentOrigin');
  if (!value) return import.meta.env.DEV ? window.location.origin : null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * PPTX Presenter view's speaker notes window: the runtime's own page on its
 * origin, which hands itself over to the runtime frame that expects `token`
 * (the frame draws into it, so the deck is loaded once). Capy opens it, as
 * the sandboxed frame gets no user activation from Capy's header.
 */
export function presenterWindowUrl(origin: string, token: string) {
  const url = new URL('/office-runtime.html', origin);
  url.hash = `presenter=${token}`;
  return url.href;
}

const PRESENTER_HASH = /^#presenter=([\w-]+)$/;

/** The token a presenter window was opened with, or null for the runtime itself. */
export function presenterTokenFromUrl(hash = window.location.hash) {
  return PRESENTER_HASH.exec(hash)?.[1] ?? null;
}

/** The size of Google Slides' presenter window, which shows the notes first. */
export const PRESENTER_WINDOW_FEATURES = 'popup,width=860,height=640';
