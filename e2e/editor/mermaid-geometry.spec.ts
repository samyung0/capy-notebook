import { expect, test } from '@playwright/test';
import type { GeometryReport } from '../fixtures/mermaid-geometry';
import { MERMAID_SOURCES } from '../fixtures/mermaid-sources';

// Mermaid draws only in a Web Worker on a DOM shim (Epo 2026-10-22). For every
// type the worker draws (MERMAID_TYPES in mermaidTypes.ts, one source each in
// mermaid-sources.ts), its drawing must match the page's own mermaid.js,
// element by element: positions, sizes, path points, transforms and the
// viewBox. A mermaid upgrade or a shim change that moves anything fails here;
// a type that cannot pass is unsupported and shows an error (Epo 2026-10-23).

/** px. The timeline title's 4ex size is about 1 px off: canvas exposes no
 * x-height, so the shim measures the glyph. */
const TOLERANCE = 1.5;

/** Every type in every theme: Hand Drawn and Kawaii load their fonts into
 * the worker and style labels their own way, the others change colours and
 * borders, which some types size by. */
const THEMES = [
  'linearLight',
  'linearDark',
  'brutalist',
  'handDrawn',
  'kawaii',
] as const;

for (const theme of THEMES)
  test(`the worker draws each type as the page does (${theme})`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto('/e2e/fixtures/mermaid-geometry.html');
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.ready), {
        timeout: 60_000,
      })
      .toBe('true');
    for (const [kind, source] of Object.entries(MERMAID_SOURCES)) {
      const report = await page.evaluate(
        ([code, name]) =>
          (
            window as unknown as {
              mermaidGeometry: (
                source: string,
                theme: string,
                width: number
              ) => Promise<GeometryReport>;
            }
          ).mermaidGeometry(code, name, 760),
        [source, theme] as const
      );
      expect.soft(report.type, `${kind}: the type mermaid detects`).toBe(kind);
      expect.soft(report.structure, `${kind}: same elements`).toBeNull();
      expect
        .soft(
          report.maxDiff,
          `${kind}: ${report.worst}; first: ${report.first}`
        )
        .toBeLessThanOrEqual(TOLERANCE);
    }
  });
