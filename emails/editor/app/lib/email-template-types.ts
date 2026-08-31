import type { EmailLocale, EmailTemplateSource } from '../../../schema';

export interface EditorTemplate {
  id: string;
  label: string;
  sources: Record<EmailLocale, EmailTemplateSource>;
  variables: ReadonlyArray<{ name: string; sample: string }>;
}

export interface RenderedPreview {
  html: string;
  preview: string;
  subject: string;
}
