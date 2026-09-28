import { unzipSync } from 'fflate';

import {
  SourceAnalysisError,
  type SourceAnalysisExtension,
  type SourceAnalysisOoxmlExtension,
  type SourceAnalysisResult,
  type SourcePageAnalysis,
} from './sourceAnalysis';

// The parser routes a page to OCR when its text layer has fewer than this many
// characters (blank pages included); the browser estimate mirrors that rule.
export const TEXTLESS_CHARS = 40;
// The upload limit bounds the compressed input, not what a ZIP can expand to.
// Keep the browser probe bounded before fflate allocates any entry buffers.
export const MAX_OOXML_EXPANDED_BYTES = 128 * 1024 * 1024;
export const MAX_OOXML_ARCHIVE_ENTRIES = 4096;
// A pdf.js promise can hang on a malformed stream; each open, page load and
// text read gets this long. Long documents only take more operations.
export const MAX_PDF_OPERATION_MILLISECONDS = 5000;
const DECIMAL_ENTITY_PATTERN = /^&#(\d+);$/u;
const ENTITY_PATTERN = /&(?:amp|apos|gt|lt|quot|#\d+|#x[\da-f]+);/giu;
const EXPLICIT_PAGE_BREAK_PATTERN =
  /<w:br\b[^>]*w:type=["']page["'][^>]*\/?\s*>/giu;
const HEX_ENTITY_PATTERN = /^&#x([\da-f]+);$/iu;
const NUMBERED_XML_PATTERN = /(\d+)\.xml$/u;
const RENDERED_PAGE_BREAK_PATTERN = /<w:lastRenderedPageBreak\b[^>]*\/?\s*>/giu;
const SHARED_STRING_CELL_PATTERN = /\bt=["']s["']/iu;
const CELL_REFERENCE_PATTERN = /\br=["']([a-z]{1,3})([1-9]\d*)["']/giu;
const SHARED_STRING_ITEM_PATTERN = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/giu;
const SHEET_CELL_PATTERN = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/giu;
const SHEET_PATH_PATTERN = /^xl\/worksheets\/sheet\d+\.xml$/u;
const SLIDE_PATH_PATTERN = /^ppt\/slides\/slide\d+\.xml$/u;
const TAG_PATTERN = /<[^>]+>/gu;
const VALUE_PATTERN = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/iu;

export function classifySourcePage(
  text: string,
  pageNumber: number
): SourcePageAnalysis {
  const chars = text.trim().length;
  const textless = chars < TEXTLESS_CHARS;
  return {
    chars,
    needsOcr: textless,
    pageNumber,
    reason: textless ? 'textless' : 'text_layer',
  };
}

/** What a reader's error means for the user. A user password is its own case
 * (an owner-password-only PDF opens normally); anything else pdf.js or the
 * OOXML probe rejects means the file is damaged or not what it claims. */
export function analysisErrorFor(error: unknown): SourceAnalysisError {
  if (error instanceof SourceAnalysisError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SourceAnalysisError(
    error instanceof Error && error.name === 'PasswordException'
      ? 'password_protected'
      : 'unreadable',
    message
  );
}

function tooManyPages(
  extension: SourceAnalysisExtension,
  maxPages: number
): SourceAnalysisError {
  return new SourceAnalysisError(
    'too_many_pages',
    `${extension.toUpperCase()} has more than ${maxPages} pages`
  );
}

type Archive = Record<string, Uint8Array>;

const decoder = new TextDecoder();

function boundedUnzip(data: Uint8Array): Archive {
  let entryCount = 0;
  let expandedBytes = 0;

  return unzipSync(data, {
    filter: ({ name, originalSize }) => {
      entryCount += 1;
      if (entryCount > MAX_OOXML_ARCHIVE_ENTRIES) {
        throw new SourceAnalysisError(
          'failed',
          `OOXML archive contains too many entries (maximum ${MAX_OOXML_ARCHIVE_ENTRIES})`
        );
      }

      const needed =
        name === 'docProps/app.xml' ||
        name === 'word/document.xml' ||
        name === 'xl/sharedStrings.xml' ||
        SHEET_PATH_PATTERN.test(name) ||
        SLIDE_PATH_PATTERN.test(name);
      if (!needed) return false;

      if (!Number.isSafeInteger(originalSize) || originalSize < 0) {
        throw new Error('OOXML archive contains an invalid expanded size');
      }
      if (originalSize > MAX_OOXML_EXPANDED_BYTES - expandedBytes) {
        throw new SourceAnalysisError(
          'failed',
          `OOXML archive expands beyond the browser analysis limit (maximum ${MAX_OOXML_EXPANDED_BYTES / 1024 / 1024} MiB)`
        );
      }
      expandedBytes += originalSize;
      return true;
    },
  });
}

function xml(archive: Archive, path: string): string {
  const bytes = archive[path];
  return bytes ? decoder.decode(bytes) : '';
}

function countMatches(value: string, pattern: RegExp, maximum: number): number {
  let count = 0;
  for (const _match of value.matchAll(pattern)) {
    count += 1;
    if (count > maximum) break;
  }
  return count;
}

function decodeXmlEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&apos;') return "'";
    if (entity === '&gt;') return '>';
    if (entity === '&lt;') return '<';
    if (entity === '&quot;') return '"';
    const hex = entity.match(HEX_ENTITY_PATTERN)?.[1];
    const decimal = entity.match(DECIMAL_ENTITY_PATTERN)?.[1];
    const codePoint = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10);
    return Number.isFinite(codePoint)
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function textNodes(value: string, tag: string): string {
  const pattern = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    'giu'
  );
  return Array.from(value.matchAll(pattern), (match) =>
    decodeXmlEntities(match[1].replace(TAG_PATTERN, ''))
  ).join(' ');
}

function positiveElementNumber(value: string, element: string): number | null {
  const match = value.match(
    new RegExp(`<${element}(?:\\s[^>]*)?>(\\d{1,10})<\\/${element}>`, 'iu')
  );
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return parsed > 0 ? parsed : null;
}

function finishResult(
  extension: SourceAnalysisExtension,
  pages: SourcePageAnalysis[],
  pageCountEstimated: boolean,
  counts: { sheetCount?: number; slideCount?: number } = {}
): SourceAnalysisResult {
  const ocrPageCount = pages.filter((page) => page.needsOcr).length;
  return {
    ...counts,
    extension,
    ocrPageCount,
    pageCount: pages.length,
    pageCountEstimated,
    pages,
    scanEstimate: true,
    textPageCount: pages.length - ocrPageCount,
  };
}

function analyzeDocx(archive: Archive, maxPages: number): SourceAnalysisResult {
  const document = xml(archive, 'word/document.xml');
  if (!document) throw new Error('The DOCX document body is missing');

  const app = xml(archive, 'docProps/app.xml');
  const renderedBreaks = countMatches(
    document,
    RENDERED_PAGE_BREAK_PATTERN,
    maxPages
  );
  const explicitBreaks = countMatches(
    document,
    EXPLICIT_PAGE_BREAK_PATTERN,
    maxPages - Math.min(renderedBreaks, maxPages)
  );
  // Word's saved page count can be stale; never go below the page breaks in
  // the body. Both are estimates of LibreOffice's pagination.
  const pageCount = Math.max(
    positiveElementNumber(app, 'Pages') ?? 0,
    renderedBreaks + explicitBreaks + 1
  );
  if (pageCount > maxPages) throw tooManyPages('docx', maxPages);
  const text = textNodes(document, 'w:t');
  const pages: SourcePageAnalysis[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    pages.push(
      classifySourcePage(
        text.slice(
          Math.floor((text.length * index) / pageCount),
          Math.floor((text.length * (index + 1)) / pageCount)
        ),
        index + 1
      )
    );
  }
  return finishResult('docx', pages, true);
}

function numberedParts(archive: Archive, pattern: RegExp): string[] {
  return Object.keys(archive)
    .filter((path) => pattern.test(path))
    .sort((left, right) => {
      const leftNumber = Number.parseInt(
        left.match(NUMBERED_XML_PATTERN)?.[1] ?? '0',
        10
      );
      const rightNumber = Number.parseInt(
        right.match(NUMBERED_XML_PATTERN)?.[1] ?? '0',
        10
      );
      return leftNumber - rightNumber;
    });
}

function analyzePptx(
  archive: Archive,
  maxPages: number,
  onPart?: (completed: number, total: number) => void
): SourceAnalysisResult {
  const slidePaths = numberedParts(archive, SLIDE_PATH_PATTERN);
  if (slidePaths.length === 0) throw new Error('The PPTX contains no slides');
  if (slidePaths.length > maxPages) throw tooManyPages('pptx', maxPages);
  const pages = slidePaths.map((path, index) => {
    const page = classifySourcePage(
      textNodes(xml(archive, path), 'a:t'),
      index + 1
    );
    onPart?.(index + 1, slidePaths.length);
    return page;
  });
  return finishResult('pptx', pages, false, { slideCount: pages.length });
}

function sharedStrings(archive: Archive): string[] {
  const content = xml(archive, 'xl/sharedStrings.xml');
  return Array.from(content.matchAll(SHARED_STRING_ITEM_PATTERN), (match) =>
    textNodes(match[1], 't')
  );
}

function sheetText(sheet: string, strings: readonly string[]): string {
  const output: string[] = [];
  for (const match of sheet.matchAll(SHEET_CELL_PATTERN)) {
    const attributes = match[1] ?? match[3] ?? '';
    const body = match[2] ?? '';
    const inline = textNodes(body, 't');
    if (inline) {
      output.push(inline);
      continue;
    }
    const value = body.match(VALUE_PATTERN)?.[1];
    if (value === undefined) continue;
    if (SHARED_STRING_CELL_PATTERN.test(attributes)) {
      const index = Number.parseInt(value, 10);
      output.push(strings[index] ?? '');
    } else {
      output.push(decodeXmlEntities(value));
    }
  }
  return output.join(' ');
}

function analyzeXlsx(
  archive: Archive,
  maxPages: number,
  onPart?: (completed: number, total: number) => void
): SourceAnalysisResult {
  const sheetPaths = numberedParts(archive, SHEET_PATH_PATTERN);
  if (sheetPaths.length === 0)
    throw new Error('The XLSX contains no worksheets');
  const strings = sharedStrings(archive);
  const pages: SourcePageAnalysis[] = [];
  for (const [index, path] of sheetPaths.entries()) {
    const sheet = xml(archive, path);
    const text = sheetText(sheet, strings);
    let lastRow = 1;
    let lastColumn = 1;
    for (const match of sheet.matchAll(CELL_REFERENCE_PATTERN)) {
      const row = Number.parseInt(match[2] ?? '', 10);
      let column = 0;
      for (const letter of (match[1] ?? '').toUpperCase()) {
        column = column * 26 + letter.charCodeAt(0) - 64;
      }
      if (Number.isSafeInteger(row)) lastRow = Math.max(lastRow, row);
      if (Number.isSafeInteger(column))
        lastColumn = Math.max(lastColumn, column);
    }
    // This deliberately estimates printed pages rather than equating one
    // worksheet with one billed LibreOffice page. Exact pagination requires
    // the server renderer, but a 50x10 cell window is a useful conservative
    // preflight for ordinary portrait sheets.
    const sheetPageCount = Math.ceil(lastRow / 50) * Math.ceil(lastColumn / 10);
    if (pages.length + sheetPageCount > maxPages) {
      throw tooManyPages('xlsx', maxPages);
    }
    for (let pageIndex = 0; pageIndex < sheetPageCount; pageIndex += 1) {
      const start = Math.floor((text.length * pageIndex) / sheetPageCount);
      const end = Math.floor((text.length * (pageIndex + 1)) / sheetPageCount);
      pages.push(classifySourcePage(text.slice(start, end), pages.length + 1));
    }
    onPart?.(index + 1, sheetPaths.length);
  }
  return finishResult('xlsx', pages, true, { sheetCount: sheetPaths.length });
}

export function analyzeOoxmlBuffer(
  data: Uint8Array,
  extension: SourceAnalysisOoxmlExtension,
  maxPages: number,
  onPart?: (completed: number, total: number) => void
): SourceAnalysisResult {
  const archive = boundedUnzip(data);
  if (extension === 'docx') {
    onPart?.(0, 1);
    const result = analyzeDocx(archive, maxPages);
    onPart?.(1, 1);
    return result;
  }
  if (extension === 'pptx') return analyzePptx(archive, maxPages, onPart);
  return analyzeXlsx(archive, maxPages, onPart);
}
