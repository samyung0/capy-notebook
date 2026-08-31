import { EmailEditorSandbox } from '~/components/email-editor-sandbox';
import { listTemplates } from '~/lib/email-templates.server';
import type { Route } from './+types/_index';

export async function loader() {
  return { templates: await listTemplates() };
}

export default function EmailTemplatesPage({
  loaderData,
}: Route.ComponentProps) {
  return <EmailEditorSandbox templates={loaderData.templates} />;
}
