import { handleSiteRequest } from './handler';

export default {
  fetch(request, env) {
    return handleSiteRequest(request, env, fetch, caches.default);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
