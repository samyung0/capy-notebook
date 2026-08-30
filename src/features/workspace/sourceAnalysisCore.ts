import { unzipSync } from 'fflate';

import type {
  SourceAnalysisExtension,
  SourceAnalysisOoxmlExtension,
  SourceAnalysisResult,
  SourcePageAnalysis,
  SourcePageReason,
} from './sourceAnalysis';

const GOOD_TEXT_CHARS = 800;
const SCAN_IMAGE_COVERAGE = 0.7;
// OOXML exposes image presence cheaply, but calculating rendered area would
// require a layout engine. Keep unknown images below the full-page scan cutoff;
// text-light pages are still classified for OCR by the thin-text rule.
const UNKNOWN_IMAGE_COVERAGE = 0.5;
// The upload limit bounds the compressed input, not what a ZIP can expand to.
// Keep the browser probe bounded before fflate allocates any entry buffers.
export const MAX_OOXML_EXPANDED_BYTES = 128 * 1024 * 1024;
export const MAX_OOXML_ARCHIVE_ENTRIES = 4096;
// Browser analysis is a preflight estimate, not the authoritative parser. Keep
// hostile PDF streams and stale DOCX metadata from controlling worker memory.
export const MAX_DOCX_ANALYSIS_PAGES = 2000;
export const MAX_XLSX_ANALYSIS_PAGES = 2000;
export const MAX_PDF_ANALYSIS_PAGES = 2000;
export const MAX_PDF_ANALYSIS_OPERATORS = 250_000;
export const MAX_PDF_ANALYSIS_TEXT_CHARS = 8_000_000;
export const MAX_PDF_ANALYSIS_IMAGE_PIXELS = 24_000_000;
export const MAX_PDF_IMAGE_PIXELS = 16_000_000;
export const MAX_PDF_ANALYSIS_ESTIMATED_BYTES = 128 * 1024 * 1024;
export const MAX_PDF_ANALYSIS_MILLISECONDS = 30_000;
export const MAX_PDF_OPERATION_MILLISECONDS = 5000;
const PDF_OPERATOR_ESTIMATED_BYTES = 64;
const PDF_TEXT_CHAR_ESTIMATED_BYTES = 2;
const PDF_IMAGE_PIXEL_ESTIMATED_BYTES = 4;
const THIN_TEXT_CHARS = 400;
const ALNUM_PATTERN = /[\p{Letter}\p{Number}]/u;
const DECIMAL_ENTITY_PATTERN = /^&#(\d+);$/u;
const DRAWING_PATTERN = /<(?:legacyDrawing|drawing)\b/iu;
const ENTITY_PATTERN = /&(?:amp|apos|gt|lt|quot|#\d+|#x[\da-f]+);/giu;
const EXPLICIT_PAGE_BREAK_PATTERN =
  /<w:br\b[^>]*w:type=["']page["'][^>]*\/?\s*>/giu;
const HEX_ENTITY_PATTERN = /^&#x([\da-f]+);$/iu;
const NUMBERED_XML_PATTERN = /(\d+)\.xml$/u;
const PICTURE_PATTERN = /<(?:p:pic|a:blip)\b/iu;
const RENDERED_PAGE_BREAK_PATTERN = /<w:lastRenderedPageBreak\b[^>]*\/?\s*>/giu;
const SHARED_STRING_CELL_PATTERN = /\bt=["']s["']/iu;
const CELL_REFERENCE_PATTERN = /\br=["']([a-z]{1,3})([1-9]\d*)["']/giu;
const SHARED_STRING_ITEM_PATTERN = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/giu;
const SHEET_CELL_PATTERN = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/giu;
const SHEET_PATH_PATTERN = /^xl\/worksheets\/sheet\d+\.xml$/u;
const SLIDE_PATH_PATTERN = /^ppt\/slides\/slide\d+\.xml$/u;
const TAG_PATTERN = /<[^>]+>/gu;
const VALUE_PATTERN = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/iu;
const WORD_PATTERN = /\S+/gu;

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1;
  return (
    (codePoint >= 0 && codePoint <= 8) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    (codePoint >= 127 && codePoint <= 159)
  );
}

export function damagedTextReason(text: string): SourcePageReason | null {
  if (!text) return null;
  const visible = Array.from(text).filter((character) => character.trim());
  if (visible.length === 0) return null;
  if (text.includes('\ufffd')) return 'replacement_chars';

  const controls = Array.from(text).filter(isControlCharacter).length;
  if (controls / Math.max(text.length, 1) >= 0.01) return 'control_chars';

  if (visible.length >= 100) {
    const alnum = visible.filter((character) =>
      ALNUM_PATTERN.test(character)
    ).length;
    if (alnum / visible.length < 0.3) return 'low_alnum';
  }

  const words = text.match(WORD_PATTERN) ?? [];
  if (words.length >= 24) {
    const single = words.filter(
      (word) => word.replace(/[.,;:!?()[\]{}]/gu, '').length === 1
    ).length;
    if (single / words.length >= 0.4) return 'broken_spacing';
  }
  return null;
}

export function classifySourcePage(
  text: string,
  imageCoverage: number,
  pageNumber: number
): SourcePageAnalysis {
  const chars = text.trim().length;
  const coverage = Math.min(1, Math.max(0, imageCoverage));
  const qualityReason = damagedTextReason(text);
  if (qualityReason) {
    return {
      chars,
      imageCoverage: coverage,
      needsOcr: true,
      pageNumber,
      reason: qualityReason,
    };
  }
  if (chars >= GOOD_TEXT_CHARS) {
    return {
      chars,
      imageCoverage: coverage,
      needsOcr: false,
      pageNumber,
      reason: 'text_layer',
    };
  }
  if (coverage >= SCAN_IMAGE_COVERAGE) {
    return {
      chars,
      imageCoverage: coverage,
      needsOcr: true,
      pageNumber,
      reason: 'scan',
    };
  }
  if (chars < THIN_TEXT_CHARS) {
    return {
      chars,
      imageCoverage: coverage,
      needsOcr: true,
      pageNumber,
      reason: 'thin_text',
    };
  }
  return {
    chars,
    imageCoverage: coverage,
    needsOcr: false,
    pageNumber,
    reason: 'enough_text',
  };
}

type Archive = Record<string, Uint8Array>;

const decoder = new TextDecoder();

function boundedUnzip(data: Uint8Array): Archive {
  let entryCount = 0;
  let expandedBytes = 0;
  let hasWordMedia = false;

  const archive = unzipSync(data, {
    filter: ({ name, originalSize }) => {
      entryCount += 1;
      if (entryCount > MAX_OOXML_ARCHIVE_ENTRIES) {
        throw new Error(
          `OOXML archive contains too many entries (maximum ${MAX_OOXML_ARCHIVE_ENTRIES})`
        );
      }

      if (name.startsWith('word/media/')) hasWordMedia = true;
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
        throw new Error(
          `OOXML archive expands beyond the browser analysis limit (maximum ${MAX_OOXML_EXPANDED_BYTES / 1024 / 1024} MiB)`
        );
      }
      expandedBytes += originalSize;
      return true;
    },
  });
  // DOCX classification only needs to know whether media exists. Avoid
  // inflating already-compressed images solely to count them.
  if (hasWordMedia) archive['word/media/__present__'] = new Uint8Array();
  return archive;
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

function estimatedPdfValueBytes(
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): number {
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (typeof value !== 'object' || value === null || depth > 4) return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;

  if (Array.isArray(value)) {
    let bytes = value.length * 8;
    if (bytes > MAX_PDF_ANALYSIS_ESTIMATED_BYTES) return bytes;
    for (const entry of value) {
      bytes += estimatedPdfValueBytes(entry, seen, depth + 1);
      if (bytes > MAX_PDF_ANALYSIS_ESTIMATED_BYTES) break;
    }
    return bytes;
  }

  let bytes = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    bytes += key.length * 2 + 8;
    bytes += estimatedPdfValueBytes(Reflect.get(value, key), seen, depth + 1);
    if (bytes > MAX_PDF_ANALYSIS_ESTIMATED_BYTES) break;
  }
  return bytes;
}

export function estimatePdfArgumentBytes(values: readonly unknown[]): number {
  const seen = new WeakSet<object>();
  let bytes = 0;
  for (const value of values) {
    bytes += estimatedPdfValueBytes(value, seen, 0);
    if (bytes > MAX_PDF_ANALYSIS_ESTIMATED_BYTES) break;
  }
  return bytes;
}

export class PdfAnalysisBudget {
  #estimatedBytes: number;
  #imagePixels = 0;
  #operatorCount = 0;
  readonly #startedAt: number;
  #textChars = 0;

  constructor(inputBytes: number, startedAt: number) {
    this.#estimatedBytes = Math.max(0, inputBytes);
    this.#startedAt = startedAt;
    this.#assertEstimatedBytes();
  }

  assertElapsed(now: number): void {
    if (now - this.#startedAt > MAX_PDF_ANALYSIS_MILLISECONDS) {
      throw new Error(
        `PDF analysis timed out (maximum ${MAX_PDF_ANALYSIS_MILLISECONDS / 1000} seconds)`
      );
    }
  }

  assertPageCount(pageCount: number): void {
    if (
      !Number.isSafeInteger(pageCount) ||
      pageCount < 1 ||
      pageCount > MAX_PDF_ANALYSIS_PAGES
    ) {
      throw new Error(
        `PDF has too many pages for browser analysis (maximum ${MAX_PDF_ANALYSIS_PAGES})`
      );
    }
  }

  recordText(textChars: number): void {
    if (!Number.isSafeInteger(textChars) || textChars < 0) {
      throw new Error('PDF text has an invalid size');
    }
    this.#textChars += textChars;
    if (this.#textChars > MAX_PDF_ANALYSIS_TEXT_CHARS) {
      throw new Error(
        `PDF text exceeds the browser analysis limit (maximum ${MAX_PDF_ANALYSIS_TEXT_CHARS} characters)`
      );
    }
    this.#estimatedBytes += textChars * PDF_TEXT_CHAR_ESTIMATED_BYTES;
    this.#assertEstimatedBytes();
  }

  recordOperators(
    operatorCount: number,
    imagePixels: number,
    argumentBytes = 0
  ): void {
    if (!Number.isSafeInteger(operatorCount) || operatorCount < 0) {
      throw new Error('PDF operator list has an invalid size');
    }
    if (!Number.isSafeInteger(imagePixels) || imagePixels < 0) {
      throw new Error('PDF image data has an invalid size');
    }
    if (!Number.isSafeInteger(argumentBytes) || argumentBytes < 0) {
      throw new Error('PDF operator arguments have an invalid size');
    }
    this.#operatorCount += operatorCount;
    if (this.#operatorCount > MAX_PDF_ANALYSIS_OPERATORS) {
      throw new Error(
        `PDF operator list exceeds the browser analysis limit (maximum ${MAX_PDF_ANALYSIS_OPERATORS} operations)`
      );
    }
    this.#imagePixels += imagePixels;
    if (this.#imagePixels > MAX_PDF_ANALYSIS_IMAGE_PIXELS) {
      throw new Error(
        `PDF images exceed the browser analysis limit (maximum ${MAX_PDF_ANALYSIS_IMAGE_PIXELS} decoded pixels)`
      );
    }
    this.#estimatedBytes +=
      operatorCount * PDF_OPERATOR_ESTIMATED_BYTES +
      imagePixels * PDF_IMAGE_PIXEL_ESTIMATED_BYTES +
      argumentBytes;
    this.#assertEstimatedBytes();
  }

  remainingMilliseconds(now: number): number {
    this.assertElapsed(now);
    return Math.min(
      MAX_PDF_OPERATION_MILLISECONDS,
      MAX_PDF_ANALYSIS_MILLISECONDS - (now - this.#startedAt)
    );
  }

  #assertEstimatedBytes(): void {
    if (this.#estimatedBytes > MAX_PDF_ANALYSIS_ESTIMATED_BYTES) {
      throw new Error(
        `PDF analysis exceeds the browser memory estimate (maximum ${MAX_PDF_ANALYSIS_ESTIMATED_BYTES / 1024 / 1024} MiB)`
      );
    }
  }
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

function analyzeDocx(archive: Archive): SourceAnalysisResult {
  const document = xml(archive, 'word/document.xml');
  if (!document) throw new Error('The DOCX document body is missing');

  const app = xml(archive, 'docProps/app.xml');
  const declaredPages = positiveElementNumber(app, 'Pages');
  const renderedBreaks = countMatches(
    document,
    RENDERED_PAGE_BREAK_PATTERN,
    MAX_DOCX_ANALYSIS_PAGES
  );
  const explicitBreaks = countMatches(
    document,
    EXPLICIT_PAGE_BREAK_PATTERN,
    MAX_DOCX_ANALYSIS_PAGES - Math.min(renderedBreaks, MAX_DOCX_ANALYSIS_PAGES)
  );
  const breakEstimate = Math.max(1, renderedBreaks + explicitBreaks + 1);
  if (breakEstimate > MAX_DOCX_ANALYSIS_PAGES) {
    throw new Error(
      `DOCX has too many pages for browser analysis (maximum ${MAX_DOCX_ANALYSIS_PAGES})`
    );
  }
  // Word's saved page count can be stale or attacker-controlled. Use it only
  // when it is plausible, and never below explicit page evidence in the body.
  const pageCount =
    declaredPages !== null && declaredPages <= MAX_DOCX_ANALYSIS_PAGES
      ? Math.max(declaredPages, breakEstimate)
      : breakEstimate;
  const text = textNodes(document, 'w:t');
  const mediaCount = Object.keys(archive).filter((path) =>
    path.startsWith('word/media/')
  ).length;
  const textPerPage = pageCount > 0 ? text.length / pageCount : 0;
  const estimatedCoverage =
    mediaCount > 0 && textPerPage < GOOD_TEXT_CHARS
      ? UNKNOWN_IMAGE_COVERAGE
      : 0;
  const pages: SourcePageAnalysis[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    pages.push(
      classifySourcePage(
        text.slice(
          Math.floor((text.length * index) / pageCount),
          Math.floor((text.length * (index + 1)) / pageCount)
        ),
        estimatedCoverage,
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
  onPart?: (completed: number, total: number) => void
): SourceAnalysisResult {
  const slidePaths = numberedParts(archive, SLIDE_PATH_PATTERN);
  if (slidePaths.length === 0) throw new Error('The PPTX contains no slides');
  const pages = slidePaths.map((path, index) => {
    const slide = xml(archive, path);
    const text = textNodes(slide, 'a:t');
    const hasPicture = PICTURE_PATTERN.test(slide);
    const page = classifySourcePage(
      text,
      hasPicture ? UNKNOWN_IMAGE_COVERAGE : 0,
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
    const hasDrawing = DRAWING_PATTERN.test(sheet);
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
    if (pages.length + sheetPageCount > MAX_XLSX_ANALYSIS_PAGES) {
      throw new Error(
        `XLSX has too many estimated pages for browser analysis (maximum ${MAX_XLSX_ANALYSIS_PAGES})`
      );
    }
    for (let pageIndex = 0; pageIndex < sheetPageCount; pageIndex += 1) {
      const start = Math.floor((text.length * pageIndex) / sheetPageCount);
      const end = Math.floor((text.length * (pageIndex + 1)) / sheetPageCount);
      pages.push(
        classifySourcePage(
          text.slice(start, end),
          hasDrawing ? UNKNOWN_IMAGE_COVERAGE : 0,
          pages.length + 1
        )
      );
    }
    onPart?.(index + 1, sheetPaths.length);
  }
  return finishResult('xlsx', pages, true, { sheetCount: sheetPaths.length });
}

export function analyzeOoxmlBuffer(
  data: Uint8Array,
  extension: SourceAnalysisOoxmlExtension,
  onPart?: (completed: number, total: number) => void
): SourceAnalysisResult {
  const archive = boundedUnzip(data);
  if (extension === 'docx') {
    onPart?.(0, 1);
    const result = analyzeDocx(archive);
    onPart?.(1, 1);
    return result;
  }
  if (extension === 'pptx') return analyzePptx(archive, onPart);
  return analyzeXlsx(archive, onPart);
}
