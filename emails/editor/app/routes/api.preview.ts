import {
  errorResponse,
  readRequestJson,
  renderTemplatePreview,
} from '~/lib/email-templates.server';
import type { Route } from './+types/api.preview';

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  try {
    return Response.json(
      await renderTemplatePreview(await readRequestJson(request))
    );
  } catch (error) {
    return errorResponse(error);
  }
}
