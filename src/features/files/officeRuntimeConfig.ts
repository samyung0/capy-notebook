export interface OfficeRuntimeConfig {
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
