import type { EmailLocale, EmailTemplateSource } from '../../../schema';
import type { RenderedPreview } from './email-template-types';

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}

export function requestPreview(
  templateId: string,
  locale: EmailLocale,
  source: EmailTemplateSource
) {
  return fetch('/api/preview', {
    body: JSON.stringify({ locale, source, templateId }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }).then(responseJson<RenderedPreview>);
}

export function saveSource(
  templateId: string,
  locale: EmailLocale,
  source: EmailTemplateSource
) {
  return fetch(
    `/api/templates/${encodeURIComponent(templateId)}/${encodeURIComponent(locale)}`,
    {
      body: JSON.stringify(source),
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
    }
  ).then(responseJson<{ saved: true }>);
}
