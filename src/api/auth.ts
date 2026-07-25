/** Whether MSW mocks are active (no Clerk / no Bearer token). */
export const USE_MSW =
  import.meta.env.VITE_USE_MSW !== 'false' &&
  import.meta.env.MODE === 'development';

type TokenGetter = () => Promise<string | null>;

let getTokenFn: TokenGetter | null = null;

export function setAuthTokenGetter(fn: TokenGetter | null) {
  getTokenFn = fn;
}

export async function authHeaders(): Promise<Record<string, string>> {
  if (USE_MSW || !getTokenFn) return {};
  const token = await getTokenFn();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
