/**
 * The app hosts' `/assets/*` route (wrangler.assets.jsonc). The build's
 * content-hashed files are static asset hits, cached for a year
 * (`public/_headers`); this script runs only when no file matches, so a chunk
 * name an older or newer release asks for gets a 404 no cache keeps, never the
 * SPA's index.html under the chunk's URL.
 */
export default {
  fetch: () =>
    new Response(null, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      status: 404,
    }),
} satisfies ExportedHandler;
