import {
  errorResponse,
  readRequestJson,
  saveTemplateSource,
} from '~/lib/email-templates.server';
import type { Route } from './+types/api.templates.$templateId.$locale';

export async function action({ params, request }: Route.ActionArgs) {
  if (request.method !== 'PUT') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }
  try {
    await saveTemplateSource(
      params.templateId,
      params.locale,
      await readRequestJson(request)
    );
    return Response.json({ saved: true });
  } catch (error) {
    return errorResponse(error);
  }
}
