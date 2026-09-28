// Browser-side OCR estimate for the add-file dialog, run in Node.
//
//   pnpm exec tsx bench/parsers/scripts/ocr_estimate_browser.ts OUT.json FILE...
//
// PDF: same pdfjs-dist build (legacy, from the app's node_modules), same
// getDocument options, CMaps and text join as analyzePdf/textFromContent in
// src/features/workspace/sourceAnalysis.worker.ts, replicated here because the
// worker module needs a browser (self, `?url` and import.meta.glob). The worker
// fetches the packed CMaps as Vite assets; Node reads the same .bcmap files
// from node_modules. The page decision is the real classifySourcePage.
// DOCX/PPTX/XLSX: the real analyzeOoxmlBuffer.
// The policy's page cap (maxPages) is not applied, so every page is measured.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  analyzeOoxmlBuffer,
  classifySourcePage,
} from '../../../src/features/workspace/sourceAnalysisCore';

const PDFJS_CMAPS = new URL(
  '../../../node_modules/pdfjs-dist/cmaps/',
  import.meta.url
).pathname;
// Kept for diagnosis only: pages whose joined text is short enough to matter.
const SNIPPET_CHARS = 160;

type Item = { hasEOL?: boolean; str?: unknown };

// Mirrors the worker's textFromContent: every item's str, then '\n' when
// hasEOL is true, otherwise ' '. The worker trims later in classifySourcePage.
function joinItems(items: readonly Item[]): string {
  return items
    .filter((item) => typeof item.str === 'string')
    .map((item) => `${item.str}${item.hasEOL === true ? '\n' : ' '}`)
    .join('');
}

async function analyzePdf(data: Uint8Array) {
  const document = await getDocument({
    cMapPacked: true,
    cMapUrl: PDFJS_CMAPS,
    data,
    disableFontFace: true,
    isEvalSupported: false,
    stopAtErrors: true,
    verbosity: 0,
  }).promise;
  const pages = [];
  try {
    for (let index = 0; index < document.numPages; index += 1) {
      const page = await document.getPage(index + 1);
      const content = await page.getTextContent({
        disableNormalization: false,
      });
      const text = joinItems(content.items as Item[]);
      const { chars, needsOcr } = classifySourcePage(text, index + 1);
      const trimmed = text.trim();
      pages.push({
        chars,
        needsOcr,
        nonSpace: trimmed.replace(/\s/gu, '').length,
        ...(chars < SNIPPET_CHARS ? { text: trimmed } : {}),
      });
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return { pages };
}

const [output, ...files] = process.argv.slice(2);
if (!output || files.length === 0) {
  console.error('usage: ocr_estimate_browser.ts OUT.json FILE...');
  process.exit(2);
}
const results: Record<string, unknown> = {};
for (const file of files) {
  const extension = extname(file).slice(1).toLowerCase();
  const data = new Uint8Array(readFileSync(file));
  try {
    if (extension === 'pdf') {
      results[basename(file)] = await analyzePdf(data);
    } else if (
      extension === 'docx' ||
      extension === 'pptx' ||
      extension === 'xlsx'
    ) {
      const result = analyzeOoxmlBuffer(
        data,
        extension,
        Number.MAX_SAFE_INTEGER
      );
      results[basename(file)] = {
        pageCountEstimated: result.pageCountEstimated,
        pages: result.pages.map(({ chars, needsOcr }) => ({ chars, needsOcr })),
      };
    } else continue;
  } catch (error) {
    results[basename(file)] = { error: (error as Error).message };
  }
  console.error(basename(file));
}
writeFileSync(output, JSON.stringify(results));
