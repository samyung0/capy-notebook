import {
  buildClerkJSScriptAttributes,
  clerkJSScriptUrl,
} from '@clerk/react/internal';
import type { HtmlTagDescriptor, Plugin } from 'vite';

/**
 * index.html's tags that start clerk-js beside the entry instead of after
 * React mounts (Epo 2026-10-18): the script ClerkProvider would inject, with
 * the same URL (Clerk's frontend API, the major tag the installed
 * @clerk/react pairs with) and attributes, which its loader finds by
 * `data-clerk-js-script` and waits for. Two preconnects: the script loads
 * without credentials, the frontend API calls with them, and the browser
 * keeps those connections apart. The SPA's script policy already allows the
 * host's `/npm/@clerk/` (vite-image-policy.ts).
 */
export function clerkScriptTags(publishableKey: string): HtmlTagDescriptor[] {
  const src = clerkJSScriptUrl({ publishableKey });
  const { origin } = new URL(src);
  return [
    {
      attrs: { crossorigin: '', href: origin, rel: 'preconnect' },
      injectTo: 'head',
      tag: 'link',
    },
    { attrs: { href: origin, rel: 'preconnect' }, injectTo: 'head', tag: 'link' },
    {
      attrs: {
        async: true,
        crossorigin: 'anonymous',
        'data-clerk-js-script': '',
        ...buildClerkJSScriptAttributes({ publishableKey }),
        src,
      },
      injectTo: 'head',
      tag: 'script',
    },
  ];
}

/** Adds `clerkScriptTags` to the app page when the build signs in with Clerk. */
export function clerkScript(publishableKey: string | undefined): Plugin {
  return {
    name: 'clerk-script',
    transformIndexHtml: (_html, { path: page }) =>
      publishableKey && page === '/index.html'
        ? clerkScriptTags(publishableKey)
        : [],
  };
}
