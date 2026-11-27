import { USE_MSW } from '@/api/auth';

/** Pages under the router's root rather than the signed-in shell (router.ts
 * `publicRoutes`); clerkSession.test keeps the two equal. */
const PUBLIC_PAGES = [
  '/sign-in',
  '/sign-up',
  '/forgot-password',
  '/sso-callback',
  '/workspace-invites',
  '/dev',
];

export const isPublicPath = (pathname: string) =>
  PUBLIC_PAGES.some(
    (page) => pathname === page || pathname.startsWith(`${page}/`)
  );

/** The auth forms, which draw before Clerk loads for a visitor it has no
 * session for (AuthTokenBridge, AuthLanding). */
export const isAuthForm = (pathname: string) =>
  pathname === '/sign-in' ||
  pathname === '/sign-up' ||
  pathname === '/forgot-password';

const CLIENT_UAT = /(?:^|;\s*)__client_uat(?:_[\w-]+)?=([^;]*)/g;

/** Clerk keeps `__client_uat` cookies on the root domain: the session's time,
 * or 0 once signed out; a first visit has none. Every Clerk instance on the
 * domain (UAT's and production's) writes the plain one, and each its own
 * suffixed one, so only all of them missing or 0 says signed out: a visitor
 * signed in on one instance waits for Clerk rather than meeting the sign-in
 * form first. Clerk's own answer still decides; this only says what it will
 * most likely be. */
export function likelySignedOut() {
  for (const [, value] of document.cookie.matchAll(CLIENT_UAT))
    if (value !== '0') return false;
  return true;
}

/** With Clerk on (not MSW, not a run without a key). */
export const clerkActive =
  !USE_MSW && Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
