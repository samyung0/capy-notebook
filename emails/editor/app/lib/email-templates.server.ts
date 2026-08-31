import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Maily } from '@maily-to/render';
import type { JSONContent } from '@tiptap/core';
import { ZodError } from 'zod';
import {
  emailLocaleSchema,
  emailLocales,
  emailRendererTheme,
  emailTemplateDefinitions,
  emailTemplateSourceSchema,
  fillTemplateVariables,
  getEmailTemplateDefinition,
  validateTemplateVariables,
} from '../../../schema';
import type { EditorTemplate, RenderedPreview } from './email-template-types';

const MAX_BODY_BYTES = 1024 * 1024;
const TEMPLATE_DIRECTORY = resolve(import.meta.dirname, '../../../templates');

export class EmailEditorRequestError extends Error {
  readonly status: number;

  constructor(
    message: string,
    { status, ...options }: ErrorOptions & { status: number }
  ) {
    super(message, options);
    this.status = status;
  }
}

function sourcePath(templateId: string, locale: string) {
  return resolve(TEMPLATE_DIRECTORY, `${templateId}.${locale}.json`);
}

async function readSource(templateId: string, locale: string) {
  const raw = await readFile(sourcePath(templateId, locale), 'utf8');
  return emailTemplateSourceSchema.parse(JSON.parse(raw));
}

function assertTemplateVariables(
  definition: Parameters<typeof validateTemplateVariables>[0],
  source: Parameters<typeof validateTemplateVariables>[1]
) {
  try {
    validateTemplateVariables(definition, source);
  } catch (error) {
    throw new EmailEditorRequestError(
      error instanceof Error ? error.message : 'Invalid template variables',
      { cause: error, status: 400 }
    );
  }
}

export async function listTemplates(): Promise<EditorTemplate[]> {
  return Promise.all(
    emailTemplateDefinitions.map(async (definition) => ({
      ...definition,
      sources: Object.fromEntries(
        await Promise.all(
          emailLocales.map(async (locale) => [
            locale,
            await readSource(definition.id, locale),
          ])
        )
      ) as EditorTemplate['sources'],
    }))
  );
}

export async function readRequestJson(request: Request) {
  const requestOrigin = request.headers.get('Origin');
  if (requestOrigin !== new URL(request.url).origin) {
    throw new EmailEditorRequestError('Cross-origin requests are not allowed', {
      status: 403,
    });
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    throw new EmailEditorRequestError('Request body is too large', {
      status: 413,
    });
  }
  return JSON.parse(raw) as unknown;
}

export async function renderTemplatePreview(
  body: unknown
): Promise<RenderedPreview> {
  if (!body || typeof body !== 'object') {
    throw new EmailEditorRequestError('Invalid request', { status: 400 });
  }
  const value = body as Record<string, unknown>;
  const definition = getEmailTemplateDefinition(String(value.templateId ?? ''));
  if (!definition) {
    throw new EmailEditorRequestError('Unknown email template', {
      status: 404,
    });
  }

  const locale = emailLocaleSchema.parse(value.locale);
  const source = emailTemplateSourceSchema.parse(value.source);
  assertTemplateVariables(definition, source);

  const preview = fillTemplateVariables(definition, source.preview);
  const subject = fillTemplateVariables(definition, source.subject);
  const renderer = new Maily(source.content as JSONContent);
  renderer.setHtmlProps({ dir: 'ltr', lang: locale });
  renderer.setPreviewText(preview);
  renderer.setTheme(emailRendererTheme);
  renderer.setVariableValues(
    Object.fromEntries(
      definition.variables.map(({ name, sample }) => [name, sample])
    )
  );

  return {
    html: await renderer.render({ pretty: true }),
    preview,
    subject,
  };
}

export async function saveTemplateSource(
  templateId: string,
  rawLocale: string,
  body: unknown
) {
  const definition = getEmailTemplateDefinition(templateId);
  if (!definition) {
    throw new EmailEditorRequestError('Unknown email template', {
      status: 404,
    });
  }
  const locale = emailLocaleSchema.parse(rawLocale);
  const source = emailTemplateSourceSchema.parse(body);
  assertTemplateVariables(definition, source);

  const destination = sourcePath(definition.id, locale);
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, `${JSON.stringify(source, null, 2)}\n`);
  await rename(temporary, destination);
}

export function errorResponse(error: unknown) {
  const isBadInput = error instanceof SyntaxError || error instanceof ZodError;
  const status =
    error instanceof EmailEditorRequestError
      ? error.status
      : isBadInput
        ? 400
        : 500;
  const message =
    status === 500
      ? 'Request failed'
      : error instanceof Error
        ? error.message
        : 'Invalid request';
  return Response.json({ error: message }, { status });
}
