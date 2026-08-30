/// <reference lib="webworker" />

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  GlobalWorkerOptions,
  getDocument,
  OPS,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

import type {
  SourceAnalysisInput,
  SourceAnalysisProgress,
  SourceAnalysisRequest,
  SourceAnalysisResult,
  SourceAnalysisWorkerResponse,
  SourcePageAnalysis,
} from './sourceAnalysis';
import {
  analyzeOoxmlBuffer,
  classifySourcePage,
  estimatePdfArgumentBytes,
  MAX_PDF_ANALYSIS_MILLISECONDS,
  MAX_PDF_IMAGE_PIXELS,
  MAX_PDF_OPERATION_MILLISECONDS,
  PdfAnalysisBudget,
} from './sourceAnalysisCore';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const IMAGE_OPERATORS = new Set<number>([
  OPS.paintImageMaskXObject,
  OPS.paintImageMaskXObjectGroup,
  OPS.paintImageMaskXObjectRepeat,
  OPS.paintImageXObject,
  OPS.paintImageXObjectRepeat,
  OPS.paintInlineImageXObject,
  OPS.paintInlineImageXObjectGroup,
]);

function post(response: SourceAnalysisWorkerResponse): void {
  workerScope.postMessage(response);
}

async function readInput(input: SourceAnalysisInput): Promise<Uint8Array> {
  if ('file' in input.source) {
    return new Uint8Array(await input.source.file.arrayBuffer());
  }
  const url = new URL(input.source.url, workerScope.location.origin);
  if (url.origin !== workerScope.location.origin) {
    throw new Error('Source analysis only accepts same-origin import URLs');
  }
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: input.source.headers,
  });
  if (!response.ok) {
    throw new Error(`Could not read imported file (${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function progress(
  jobId: string,
  phase: SourceAnalysisProgress['phase'],
  completed: number,
  total: number,
  percent: number
): void {
  post({
    jobId,
    progress: {
      completed,
      percent: Math.min(100, Math.max(0, Math.round(percent))),
      phase,
      total,
    },
    type: 'progress',
  });
}

type Matrix = readonly [number, number, number, number, number, number];

function multiplied(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function numericMatrix(value: unknown): Matrix | null {
  if (!Array.isArray(value) || value.length < 6) return null;
  const numbers = value.slice(0, 6);
  if (
    !numbers.every(
      (entry) => typeof entry === 'number' && Number.isFinite(entry)
    )
  ) {
    return null;
  }
  return numbers as unknown as Matrix;
}

function imageCoverage(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  pageArea: number
): number {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let imageArea = 0;
  for (let index = 0; index < fnArray.length; index += 1) {
    const operation = fnArray[index];
    if (operation === OPS.save) {
      stack.push(matrix);
      continue;
    }
    if (operation === OPS.restore) {
      matrix = stack.pop() ?? matrix;
      continue;
    }
    if (operation === OPS.transform) {
      const next = numericMatrix(argsArray[index]);
      if (next) matrix = multiplied(matrix, next);
      continue;
    }
    if (IMAGE_OPERATORS.has(operation)) {
      imageArea += Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
    }
  }
  return Math.min(1, imageArea / Math.max(pageArea, 1));
}

function textFromContent(content: unknown, budget: PdfAnalysisBudget): string {
  if (
    typeof content !== 'object' ||
    content === null ||
    !('items' in content)
  ) {
    return '';
  }
  const items = Reflect.get(content, 'items');
  if (!Array.isArray(items)) return '';
  const fragments: string[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('str' in item)) continue;
    const value = Reflect.get(item, 'str');
    if (typeof value !== 'string') continue;
    const fragment = `${value}${Reflect.get(item, 'hasEOL') === true ? '\n' : ' '}`;
    budget.recordText(fragment.length);
    fragments.push(fragment);
  }
  return fragments.join('');
}

function decodedPixels(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const width = Reflect.get(value, 'width');
  const height = Reflect.get(value, 'height');
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 0 ||
    height < 0 ||
    width > Number.MAX_SAFE_INTEGER / Math.max(height, 1)
  ) {
    throw new Error('PDF image data has an invalid size');
  }
  return width * height;
}

function imageDecodePixels(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  seenImageIds: Set<string>,
  seenInlineImages: WeakSet<object>
): number {
  let pixels = 0;
  for (let index = 0; index < fnArray.length; index += 1) {
    const operation = fnArray[index];
    if (!IMAGE_OPERATORS.has(operation)) continue;
    const args = argsArray[index];
    if (!Array.isArray(args)) continue;

    if (
      operation === OPS.paintImageXObject ||
      operation === OPS.paintImageXObjectRepeat
    ) {
      const imageId = args[0];
      if (typeof imageId === 'string') {
        if (seenImageIds.has(imageId)) continue;
        seenImageIds.add(imageId);
      }
      pixels +=
        operation === OPS.paintImageXObject
          ? decodedPixels({ height: args[2], width: args[1] })
          : MAX_PDF_IMAGE_PIXELS;
      continue;
    }

    const candidates =
      operation === OPS.paintImageMaskXObjectGroup && Array.isArray(args[0])
        ? args[0]
        : [args[0]];
    for (const candidate of candidates) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      if (seenInlineImages.has(candidate)) continue;
      seenInlineImages.add(candidate);
      pixels += decodedPixels(candidate);
    }
  }
  return pixels;
}

function repeatedOperationCount(
  fnArray: readonly number[],
  argsArray: readonly unknown[]
): number {
  const coordinatePairCount = (value: unknown): number => {
    if (Array.isArray(value)) return Math.floor(value.length / 2);
    if (!ArrayBuffer.isView(value)) return 1;
    const length = Reflect.get(value, 'length');
    return typeof length === 'number' && Number.isSafeInteger(length)
      ? Math.floor(length / 2)
      : 1;
  };
  let count = fnArray.length;
  for (let index = 0; index < fnArray.length; index += 1) {
    const operation = fnArray[index];
    const args = argsArray[index];
    if (!Array.isArray(args)) continue;

    let groupedCount = 1;
    if (operation === OPS.paintImageXObjectRepeat) {
      groupedCount = coordinatePairCount(args[3]);
    } else if (operation === OPS.paintImageMaskXObjectRepeat) {
      groupedCount = coordinatePairCount(args[5]);
    } else if (
      operation === OPS.paintImageMaskXObjectGroup &&
      Array.isArray(args[0])
    ) {
      groupedCount = args[0].length;
    } else if (
      operation === OPS.paintInlineImageXObjectGroup &&
      Array.isArray(args[1])
    ) {
      groupedCount = args[1].length;
    }
    count += Math.max(0, groupedCount - 1);
  }
  return count;
}

async function withPdfDeadline<T>(
  operation: Promise<T>,
  budget: PdfAnalysisBudget,
  label: string
): Promise<T> {
  const timeoutMs = budget.remainingMilliseconds(performance.now());
  const timeoutMessage =
    timeoutMs < MAX_PDF_OPERATION_MILLISECONDS
      ? `PDF analysis timed out (maximum ${MAX_PDF_ANALYSIS_MILLISECONDS / 1000} seconds)`
      : `PDF ${label} timed out (maximum ${MAX_PDF_OPERATION_MILLISECONDS / 1000} seconds per operation)`;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(timeoutMessage)),
          timeoutMs
        );
      }),
    ]);
    budget.assertElapsed(performance.now());
    return result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function analyzePdf(
  data: Uint8Array,
  jobId: string
): Promise<SourceAnalysisResult> {
  const budget = new PdfAnalysisBudget(data.byteLength, performance.now());
  const loading = getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
    stopAtErrors: true,
  });
  let document: Awaited<typeof loading.promise> | undefined;
  try {
    document = await withPdfDeadline(loading.promise, budget, 'opening');
    budget.assertPageCount(document.numPages);
    const pages: SourcePageAnalysis[] = [];
    const seenImageIds = new Set<string>();
    const seenInlineImages = new WeakSet<object>();
    for (let index = 0; index < document.numPages; index += 1) {
      budget.assertElapsed(performance.now());
      let page: Awaited<ReturnType<typeof document.getPage>> | undefined;
      try {
        page = await withPdfDeadline(
          document.getPage(index + 1),
          budget,
          'page load'
        );
        const text = await withPdfDeadline(
          page
            .getTextContent({ disableNormalization: false })
            .then((content) => textFromContent(content, budget)),
          budget,
          'text extraction'
        );
        const operators = await withPdfDeadline(
          page.getOperatorList(),
          budget,
          'operator extraction'
        );
        budget.recordOperators(
          repeatedOperationCount(
            operators.fnArray,
            operators.argsArray as unknown[]
          ),
          imageDecodePixels(
            operators.fnArray,
            operators.argsArray as unknown[],
            seenImageIds,
            seenInlineImages
          ),
          estimatePdfArgumentBytes(operators.argsArray as unknown[])
        );
        const viewport = page.getViewport({ scale: 1 });
        pages.push(
          classifySourcePage(
            text,
            imageCoverage(
              operators.fnArray,
              operators.argsArray as unknown[],
              viewport.width * viewport.height
            ),
            index + 1
          )
        );
      } finally {
        page?.cleanup();
      }
      progress(
        jobId,
        'analyzing',
        index + 1,
        document.numPages,
        10 + ((index + 1) / document.numPages) * 90
      );
    }
    const ocrPageCount = pages.filter((page) => page.needsOcr).length;
    return {
      extension: 'pdf',
      ocrPageCount,
      pageCount: pages.length,
      pageCountEstimated: false,
      pages,
      scanEstimate: true,
      textPageCount: pages.length - ocrPageCount,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Image exceeded maximum allowed size')
    ) {
      throw new Error(
        `PDF image exceeds the browser analysis limit (maximum ${MAX_PDF_IMAGE_PIXELS} decoded pixels)`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    if (document) await document.destroy();
    else await loading.destroy();
  }
}

async function analyze(request: SourceAnalysisRequest): Promise<void> {
  progress(request.jobId, 'reading', 0, 1, 0);
  const data = await readInput(request.input);
  progress(request.jobId, 'opening', 0, 1, 5);

  const result =
    request.input.kind === 'pdf'
      ? await analyzePdf(data, request.jobId)
      : analyzeOoxmlBuffer(data, request.input.kind, (completed, total) => {
          progress(
            request.jobId,
            'analyzing',
            completed,
            total,
            10 + (completed / Math.max(total, 1)) * 90
          );
        });
  progress(request.jobId, 'complete', result.pageCount, result.pageCount, 100);
  post({ jobId: request.jobId, result, type: 'result' });
}

workerScope.onmessage = (event: MessageEvent<SourceAnalysisRequest>) => {
  if (event.data.type !== 'analyze') return;
  analyze(event.data).catch((error: unknown) => {
    post({
      jobId: event.data.jobId,
      message:
        error instanceof Error ? error.message : 'Source analysis failed',
      type: 'error',
    });
  });
};
