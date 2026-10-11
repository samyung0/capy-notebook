import { handleSiteRequest } from './handler';

// Whether a response came from a fresh isolate, and how long the isolate has
// been serving: `Server-Timing: isolate;desc="new"|"reused";dur=<ms>`, so a
// slow uncached page can be told apart from a slow render.
let served = 0;
let firstAt: number | undefined;

export default {
  async fetch(request, env) {
    served += 1;
    firstAt ??= Date.now();
    const response = await handleSiteRequest(request, env);
    const timed = new Response(response.body, response);
    timed.headers.append(
      'Server-Timing',
      `isolate;desc="${served === 1 ? 'new' : 'reused'}";dur=${Date.now() - firstAt}`
    );
    return timed;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
