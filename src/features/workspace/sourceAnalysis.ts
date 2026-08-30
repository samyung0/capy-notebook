export type SourceAnalysisOoxmlExtension = 'docx' | 'pptx' | 'xlsx';
export type SourceAnalysisExtension = SourceAnalysisOoxmlExtension | 'pdf';

export type SourceAnalysisPhase =
  | 'reading'
  | 'opening'
  | 'analyzing'
  | 'complete';

export type SourcePageReason =
  | 'text_layer'
  | 'scan'
  | 'thin_text'
  | 'enough_text'
  | 'replacement_chars'
  | 'control_chars'
  | 'low_alnum'
  | 'broken_spacing';

export interface SourcePageAnalysis {
  chars: number;
  imageCoverage: number;
  needsOcr: boolean;
  pageNumber: number;
  reason: SourcePageReason;
}

export interface SourceAnalysisResult {
  extension: SourceAnalysisExtension;
  ocrPageCount: number;
  /** PDF/PPTX page counts are exact. DOCX/XLSX page counts are estimates. */
  pageCount: number;
  pageCountEstimated: boolean;
  pages: SourcePageAnalysis[];
  /** OCR classification is a client-side estimate for every supported format. */
  scanEstimate: true;
  sheetCount?: number;
  slideCount?: number;
  textPageCount: number;
}

export interface SourceAnalysisProgress {
  completed: number;
  percent: number;
  phase: SourceAnalysisPhase;
  total: number;
}

export interface SourceAnalysisInput {
  /** Stable caller-owned key used to reuse a completed analysis. */
  key: string;
  kind: SourceAnalysisExtension;
  name: string;
  source:
    | { file: File }
    | {
        /** Prefer a same-origin URL so provider credentials stay on the server. */
        headers?: Readonly<Record<string, string>>;
        url: string;
      };
}

export interface ParsePageRates {
  digitalPageRateMicros: number;
  ocrPageRateMicros: number;
}

export function calculateParseCreditMicros(
  result: Pick<SourceAnalysisResult, 'ocrPageCount' | 'pageCount'>,
  rates: ParsePageRates
): number {
  const pages = Math.max(0, Math.trunc(result.pageCount));
  const ocrPages = Math.min(
    pages,
    Math.max(0, Math.trunc(result.ocrPageCount))
  );
  return (
    (pages - ocrPages) * Math.max(0, rates.digitalPageRateMicros) +
    ocrPages * Math.max(0, rates.ocrPageRateMicros)
  );
}

export function sourceAnalysisCacheKey(
  file: Pick<File, 'lastModified' | 'name' | 'size' | 'type'>
): string {
  return [file.name, file.size, file.lastModified, file.type].join('\0');
}

export function sourceAnalysisExtension(
  name: string
): SourceAnalysisExtension | null {
  const value = name.split('.').pop()?.toLowerCase();
  if (
    value === 'pdf' ||
    value === 'docx' ||
    value === 'pptx' ||
    value === 'xlsx'
  ) {
    return value;
  }
  return null;
}

export function localSourceAnalysisInput(
  file: File
): SourceAnalysisInput | null {
  const kind = sourceAnalysisExtension(file.name);
  if (!kind) return null;
  return {
    key: sourceAnalysisCacheKey(file),
    kind,
    name: file.name,
    source: { file },
  };
}

export interface SourceAnalysisRequest {
  input: SourceAnalysisInput;
  jobId: string;
  type: 'analyze';
}

export type SourceAnalysisWorkerResponse =
  | {
      jobId: string;
      progress: SourceAnalysisProgress;
      type: 'progress';
    }
  | {
      jobId: string;
      result: SourceAnalysisResult;
      type: 'result';
    }
  | {
      jobId: string;
      message: string;
      type: 'error';
    };

interface AnalysisWorker {
  onerror: ((event: ErrorEvent) => void) | null;
  onmessage:
    | ((event: MessageEvent<SourceAnalysisWorkerResponse>) => void)
    | null;
  postMessage(message: SourceAnalysisRequest): void;
  terminate(): void;
}

type AnalysisWorkerFactory = () => AnalysisWorker;

export interface SourceAnalysisJobOptions {
  id: string;
  input: SourceAnalysisInput;
  onProgress?: (progress: SourceAnalysisProgress) => void;
}

export interface SourceAnalysisJob {
  cancel: () => void;
  promise: Promise<SourceAnalysisResult>;
}

interface PendingJob extends SourceAnalysisJobOptions {
  cacheKey: string;
  reject: (reason: unknown) => void;
  resolve: (result: SourceAnalysisResult) => void;
}

interface ActiveJob {
  job: PendingJob;
  worker: AnalysisWorker;
}

export class SourceAnalysisCancelledError extends Error {
  constructor() {
    super('Source analysis cancelled');
    this.name = 'SourceAnalysisCancelledError';
  }
}

function createBrowserWorker(): AnalysisWorker {
  return new Worker(new URL('./sourceAnalysis.worker.ts', import.meta.url), {
    name: 'source-analysis',
    type: 'module',
  });
}

/**
 * Serializes memory-heavy document probes. Each active file gets its own
 * worker. Cancelling that file terminates the worker, which also stops PDF.js.
 */
export class SourceAnalysisQueue {
  readonly #cache = new Map<string, SourceAnalysisResult>();
  readonly #createWorker: AnalysisWorkerFactory;
  #active: ActiveJob | null = null;
  #disposed = false;
  readonly #pending: PendingJob[] = [];

  constructor(createWorker: AnalysisWorkerFactory = createBrowserWorker) {
    this.#createWorker = createWorker;
  }

  enqueue(options: SourceAnalysisJobOptions): SourceAnalysisJob {
    if (this.#disposed) {
      return {
        cancel: () => undefined,
        promise: Promise.reject(new SourceAnalysisCancelledError()),
      };
    }

    const cacheKey = options.input.key;
    const cached = this.#cache.get(cacheKey);
    if (cached) {
      return { cancel: () => undefined, promise: Promise.resolve(cached) };
    }

    let pending: PendingJob | undefined;
    const promise = new Promise<SourceAnalysisResult>((resolve, reject) => {
      pending = { ...options, cacheKey, reject, resolve };
      this.#pending.push(pending);
      this.#drain();
    });

    return {
      cancel: () => {
        if (pending) this.cancel(options.id);
      },
      promise,
    };
  }

  cancel(id: string): boolean {
    const queuedIndex = this.#pending.findIndex((job) => job.id === id);
    if (queuedIndex >= 0) {
      const [job] = this.#pending.splice(queuedIndex, 1);
      job.reject(new SourceAnalysisCancelledError());
      return true;
    }

    if (this.#active?.job.id !== id) return false;
    const { job, worker } = this.#active;
    this.#active = null;
    worker.terminate();
    job.reject(new SourceAnalysisCancelledError());
    this.#drain();
    return true;
  }

  clearCache(cacheKey?: string): void {
    if (cacheKey === undefined) this.#cache.clear();
    else this.#cache.delete(cacheKey);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#active) {
      this.#active.worker.terminate();
      this.#active.job.reject(new SourceAnalysisCancelledError());
      this.#active = null;
    }
    for (const job of this.#pending.splice(0)) {
      job.reject(new SourceAnalysisCancelledError());
    }
  }

  getCached(cacheKey: string): SourceAnalysisResult | undefined {
    return this.#cache.get(cacheKey);
  }

  #drain(): void {
    if (this.#disposed || this.#active || this.#pending.length === 0) return;
    const job = this.#pending.shift();
    if (!job) return;

    let worker: AnalysisWorker;
    try {
      worker = this.#createWorker();
    } catch (error) {
      job.reject(error);
      this.#drain();
      return;
    }
    this.#active = { job, worker };
    worker.onmessage = (event) => {
      if (this.#active?.worker !== worker) return;
      const response = event.data;
      if (response.jobId !== job.id) return;
      if (response.type === 'progress') {
        job.onProgress?.(response.progress);
        return;
      }
      this.#active = null;
      worker.terminate();
      if (response.type === 'result') {
        this.#cache.set(job.cacheKey, response.result);
        job.resolve(response.result);
      } else {
        job.reject(new Error(response.message));
      }
      this.#drain();
    };
    worker.onerror = (event) => {
      if (this.#active?.worker !== worker) return;
      this.#active = null;
      worker.terminate();
      job.reject(new Error(event.message || 'Source analysis worker failed'));
      this.#drain();
    };
    try {
      worker.postMessage({ input: job.input, jobId: job.id, type: 'analyze' });
    } catch (error) {
      this.#active = null;
      worker.terminate();
      job.reject(error);
      this.#drain();
    }
  }
}
