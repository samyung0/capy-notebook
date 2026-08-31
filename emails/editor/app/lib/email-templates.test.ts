import { describe, expect, it } from 'vitest';
import { emailLocales, emailTemplateDefinitions } from '../../../schema';
import { listTemplates, renderTemplatePreview } from './email-templates.server';

describe('email template repository', () => {
  it('loads every English and Chinese source', async () => {
    const templates = await listTemplates();

    expect(templates).toHaveLength(emailTemplateDefinitions.length);
    for (const template of templates) {
      for (const locale of emailLocales) {
        const source = template.sources[locale];
        expect(source.content.type).toBe('doc');
        expect(
          await renderTemplatePreview({
            locale,
            source,
            templateId: template.id,
          })
        ).toMatchObject({ subject: expect.any(String) });
      }
    }
  });

  it('renders body and header variables with preview values', async () => {
    const [template] = await listTemplates();
    if (!template) throw new Error('Expected an email template');

    const result = await renderTemplatePreview({
      locale: 'en',
      source: template.sources.en,
      templateId: template.id,
    });

    expect(result.subject).toContain('Biology');
    expect(result.html).toContain('Biology');
    expect(result.html).not.toContain('{{.WorkspaceName}}');
  });
});
