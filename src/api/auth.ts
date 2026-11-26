import { traceHeaders } from '@/lib/trace';

/** Whether MSW mocks are active (no Clerk / no Bearer token): in development
 * unless VITE_USE_MSW=false, and in a production build only with the MSW
 * benches' switch (VITE_BENCH_MSW), which deploys pin off (vite.config.ts). */
export const USE_MSW =
  import.meta.env.VITE_BENCH_MSW === 'true' ||
  (import.meta.env.VITE_USE_MSW !== 'false' &&
    import.meta.env.MODE === 'development');

type TokenGetter = () => Promise<string | null>;

let getTokenFn: TokenGetter | null = null;

export function setAuthTokenGetter(fn: TokenGetter | null) {
  getTokenFn = fn;
}

/**
 * Headers every outbound request carries. This is the only place all API calls
 * pass through, so the trace id is attached here rather than at each call site
 * — a request that skips it becomes untraceable across four services.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = traceHeaders();
  if (USE_MSW || !getTokenFn) return headers;
  const token = await getTokenFn();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
