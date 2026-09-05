import { handleSiteRequest } from './handler';

export default {
  fetch(request, env) {
    return handleSiteRequest(request, env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
