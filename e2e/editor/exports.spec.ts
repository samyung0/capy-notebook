import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { m } from '../i18n';
import { openEditorNote } from './helpers';

test('feature-matrix downloads retain study content and Word video objects', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  // Freeze this page's app snapshot while other local work triggers Vite HMR.
  await page.routeWebSocket('ws://127.0.0.1:4518/**', () => {});
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('https://i.ytimg.com/**', (route) =>
    route.fulfill({
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAGklEQVR4nGO8e/cuAymAiSTVDKMaiAMkBysAgmcCqYF2f+QAAAAASUVORK5CYII=',
        'base64'
      ),
      contentType: 'image/png',
      headers: { 'access-control-allow-origin': '*' },
    })
  );
  await openEditorNote(
    page,
    'mat_note_bio_feature_matrix',
    'Editor feature matrix'
  );
  // The seeded image turns the Markdown export into a zip with its assets.
  for (const [label, extension] of [
    [m.editor_export_md(), 'zip'],
    [m.editor_export_docx(), 'docx'],
  ]) {
    await page
      .getByRole('button', { exact: true, name: m.editor_export() })
      .click();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { exact: true, name: label }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(`document.${extension}`);
    const bytes = await readFile((await download.path())!);
    if (extension === 'zip') {
      const zip = unzipSync(bytes);
      expect(Object.keys(zip).some((path) => path.startsWith('assets/'))).toBe(
        true
      );
      const source = strFromU8(zip['document.md']);
      expect(source).toContain(m.editor_export_answer_key());
      expect(source).toContain(`${m.editor_export_card()} 2`);
      expect(source).toContain('https://www.youtube.com/watch?v=URUJD5NEXC8');
      expect(source).not.toContain('```quiz');
    } else {
      const zip = unzipSync(bytes);
      const xml = strFromU8(zip['word/document.xml']);
      expect(xml).toContain('wp15:webVideoPr');
      expect(xml).toContain('youtube.com/embed/URUJD5NEXC8');
      expect(xml).toContain('a:hlinkClick');
      expect(xml).toContain('w:bookmarkStart');
      expect(xml).toContain(' TOC \\o "1-6" \\h \\z \\u ');
      expect(xml).toContain('w:fldCharType="begin" w:dirty="true"');
      expect(xml).toContain('PAGEREF _CapyHeading');
      expect(xml).toContain('w:pStyle w:val="TOC6"');
      expect(xml).not.toContain('w:name="_CapyToc');
      const label = xml
        .match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)
        ?.find((paragraph) => paragraph.includes(m.editor_export_solution()));
      expect(label).toContain('<w:keepNext/>');
      expect(label).not.toContain('w:pStyle w:val="Heading');
      expect(strFromU8(zip['word/styles.xml'])).toContain('w:leader="dot"');
      expect(strFromU8(zip['word/settings.xml'])).toContain(
        '<w:updateFields w:val="true"/>'
      );
      expect(strFromU8(zip['word/settings.xml'])).toContain('w:val="15"');
      expect(xml).toContain(m.editor_export_answer_key());
      expect(xml).toContain(`${m.editor_export_card()} 2`);
      expect(xml.toLowerCase()).toContain('w:fill="eff6ff"');
      expect(xml.toLowerCase()).toContain('w:color="3b82f6"');
      expect(xml).toContain('w:color="BBBBBB"');
      expect(xml).not.toContain('Playback requires');
      expect(
        Object.keys(zip).filter((path) => path.startsWith('word/media/')).length
      ).toBeGreaterThanOrEqual(4);
    }
  }
  expect(errors).toEqual([]);
});
