/// <reference lib="webworker" />

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  GlobalWorkerOptions,
  getDocument,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  SourceAnalysisError,
  type SourceAnalysisInput,
  type SourceAnalysisProgress,
  type SourceAnalysisRequest,
  type SourceAnalysisResult,
  type SourceAnalysisWorkerResponse,
  type SourcePageAnalysis,
} from './sourceAnalysis';
import {
  analysisErrorFor,
  analyzeOoxmlBuffer,
  classifySourcePage,
  MAX_PDF_OPERATION_MILLISECONDS,
} from './sourceAnalysisCore';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

// pdf.js asks for CMaps by name. Vite emits each packed CMap as a same-origin
// asset, like the worker URL above, fetched only when a PDF uses one. Without
// them, text in non-embedded CJK fonts reads as nothing and those pages
// count as scanned.
const CMAP_DIR = '/node_modules/pdfjs-dist/cmaps/';
const cMapUrls = import.meta.glob<string>(
  '/node_modules/pdfjs-dist/cmaps/*.bcmap',
  { import: 'default', query: '?url' }
);

class BundledCMapReader {
  async fetch({ name }: { name: string }) {
    const url = cMapUrls[`${CMAP_DIR}${name}.bcmap`];
    if (!url) throw new Error(`Unknown CMap ${name}`);
    const response = await fetch(await url());
    if (!response.ok) {
      throw new Error(`Could not load CMap ${name} (${response.status})`);
    }
    return {
      cMapData: new Uint8Array(await response.arrayBuffer()),
      isCompressed: true,
    };
  }
}

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

function textFromContent(content: unknown): string {
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
    fragments.push(
      `${value}${Reflect.get(item, 'hasEOL') === true ? '\n' : ' '}`
    );
  }
  return fragments.join('');
}

async function withTimeout<T>(
  operation: Promise<T>,
  label: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new SourceAnalysisError(
                'failed',
                `PDF ${label} timed out (maximum ${MAX_PDF_OPERATION_MILLISECONDS / 1000} seconds per operation)`
              )
            ),
          MAX_PDF_OPERATION_MILLISECONDS
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function analyzePdf(
  data: Uint8Array,
  maxPages: number,
  jobId: string
): Promise<SourceAnalysisResult> {
  const loading = getDocument({
    CMapReaderFactory: BundledCMapReader,
    data,
    disableFontFace: true,
    isEvalSupported: false,
    stopAtErrors: true,
    useWorkerFetch: false,
  });
  let document: Awaited<typeof loading.promise> | undefined;
  try {
    document = await withTimeout(loading.promise, 'opening');
    if (document.numPages > maxPages) {
      throw new SourceAnalysisError(
        'too_many_pages',
        `PDF has more than ${maxPages} pages`
      );
    }
    const pages: SourcePageAnalysis[] = [];
    for (let index = 0; index < document.numPages; index += 1) {
      let page: Awaited<ReturnType<typeof document.getPage>> | undefined;
      try {
        page = await withTimeout(document.getPage(index + 1), 'page load');
        const content = await withTimeout(
          page.getTextContent({ disableNormalization: false }),
          'text extraction'
        );
        pages.push(classifySourcePage(textFromContent(content), index + 1));
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
  } finally {
    if (document) await document.destroy();
    else await loading.destroy();
  }
}

async function analyze(request: SourceAnalysisRequest): Promise<void> {
  const { input, jobId } = request;
  progress(jobId, 'reading', 0, 1, 0);
  const data = await readInput(input);
  progress(jobId, 'opening', 0, 1, 5);

  let result: SourceAnalysisResult;
  try {
    result =
      input.kind === 'pdf'
        ? await analyzePdf(data, input.maxPages, jobId)
        : analyzeOoxmlBuffer(
            data,
            input.kind,
            input.maxPages,
            (completed, total) => {
              progress(
                jobId,
                'analyzing',
                completed,
                total,
                10 + (completed / Math.max(total, 1)) * 90
              );
            }
          );
  } catch (error) {
    throw analysisErrorFor(error);
  }
  progress(jobId, 'complete', result.pageCount, result.pageCount, 100);
  post({ jobId, result, type: 'result' });
}

workerScope.onmessage = (event: MessageEvent<SourceAnalysisRequest>) => {
  if (event.data.type !== 'analyze') return;
  analyze(event.data).catch((error: unknown) => {
    // Reading the source (a local file or a same-origin import URL) failed
    // before any reader saw it: not a property of the file.
    const failure =
      error instanceof SourceAnalysisError
        ? error
        : new SourceAnalysisError(
            'failed',
            error instanceof Error ? error.message : 'Source analysis failed'
          );
    post({
      code: failure.code,
      jobId: event.data.jobId,
      message: failure.message,
      type: 'error',
    });
  });
};
