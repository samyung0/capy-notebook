import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { sourceUploadPolicy } from '@/mocks/sourceUploadPolicy';

import {
  calculateParseCreditMicros,
  localSourceAnalysisInput,
  SourceAnalysisCancelledError,
  SourceAnalysisError,
  SourceAnalysisQueue,
  type SourceAnalysisRequest,
  type SourceAnalysisResult,
  type SourceAnalysisWorkerResponse,
  sourceAnalysisExtension,
} from './sourceAnalysis';
import {
  analysisErrorFor,
  analyzeOoxmlBuffer,
  classifySourcePage,
  MAX_OOXML_ARCHIVE_ENTRIES,
  MAX_OOXML_EXPANDED_BYTES,
} from './sourceAnalysisCore';

const encoder = new TextEncoder();
const MAX_PAGES = 1400;

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof SourceAnalysisError ? error.code : 'uncoded';
  }
}

const result = (extension: 'pdf' | 'pptx' = 'pdf'): SourceAnalysisResult => ({
  extension,
  ocrPageCount: 1,
  pageCount: 2,
  pageCountEstimated: false,
  pages: [
    {
      chars: 900,
      needsOcr: false,
      pageNumber: 1,
      reason: 'text_layer',
    },
    {
      chars: 0,
      needsOcr: true,
      pageNumber: 2,
      reason: 'textless',
    },
  ],
  scanEstimate: true,
  textPageCount: 1,
});

class FakeWorker {
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage:
    | ((event: MessageEvent<SourceAnalysisWorkerResponse>) => void)
    | null = null;
  request?: SourceAnalysisRequest;
  terminated = false;

  postMessage(message: SourceAnalysisRequest): void {
    this.request = message;
  }

  respond(response: SourceAnalysisWorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: response }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

function file(name: string): File {
  return new File(['fixture'], name, {
    lastModified: 10,
    type: 'application/octet-stream',
  });
}

function input(name: string) {
  const value = localSourceAnalysisInput(file(name), sourceUploadPolicy);
  if (!value) throw new Error(`Unsupported test input: ${name}`);
  return value;
}

describe('source analysis classification', () => {
  it('matches the parser rule: under 40 native characters is OCR-routed', () => {
    expect(classifySourcePage('a'.repeat(40), 1)).toMatchObject({
      needsOcr: false,
      reason: 'text_layer',
    });
    expect(classifySourcePage(`  ${'a'.repeat(39)}  `, 1)).toMatchObject({
      chars: 39,
      needsOcr: true,
      reason: 'textless',
    });
    expect(classifySourcePage('', 2)).toMatchObject({
      needsOcr: true,
      reason: 'textless',
    });
  });

  it('prices OCR pages instead of adding both rates', () => {
    expect(
      calculateParseCreditMicros(
        { ocrPageCount: 2, pageCount: 5 },
        { digitalPageRateMicros: 31, ocrPageRateMicros: 52 }
      )
    ).toBe(197);
  });

  it('keeps images out of document page analysis', () => {
    for (const extension of ['png', 'jp2', 'svg', 'avif']) {
      expect(
        sourceAnalysisExtension(`scan.${extension}`, sourceUploadPolicy)
      ).toBeNull();
      expect(
        localSourceAnalysisInput(file(`scan.${extension}`), sourceUploadPolicy)
      ).toBeNull();
    }
  });
});

describe('OOXML analysis', () => {
  it('rejects archives whose total declared expansion exceeds the browser limit', () => {
    const archive = zipSync({
      'xl/sharedStrings.xml': encoder.encode('<sst/>'),
      'xl/worksheets/sheet1.xml': encoder.encode('<worksheet/>'),
    });
    const oversized = archive.slice();
    const view = new DataView(
      oversized.buffer,
      oversized.byteOffset,
      oversized.byteLength
    );
    let patchedEntries = 0;
    const declaredSize = Math.floor(MAX_OOXML_EXPANDED_BYTES / 2) + 1;
    for (let offset = 0; offset + 4 <= oversized.length; offset += 1) {
      if (view.getUint32(offset, true) !== 0x02_01_4b_50) continue;
      view.setUint32(offset + 24, declaredSize, true);
      patchedEntries += 1;
    }
    expect(patchedEntries).toBe(2);

    expect(() => analyzeOoxmlBuffer(oversized, 'xlsx', MAX_PAGES)).toThrow(
      `OOXML archive expands beyond the browser analysis limit (maximum ${MAX_OOXML_EXPANDED_BYTES / 1024 / 1024} MiB)`
    );
  });

  it('rejects archives with too many entries before extraction', () => {
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < MAX_OOXML_ARCHIVE_ENTRIES + 1; index += 1) {
      entries[`entry-${index}.xml`] = encoder.encode('x');
    }

    expect(() =>
      analyzeOoxmlBuffer(zipSync(entries), 'xlsx', MAX_PAGES)
    ).toThrow(
      `OOXML archive contains too many entries (maximum ${MAX_OOXML_ARCHIVE_ENTRIES})`
    );
  });

  it('counts PPTX slides and classifies their estimated OCR needs', () => {
    const archive = zipSync({
      'ppt/slides/slide1.xml': encoder.encode(
        `<p:sld><a:t>${'Digital text '.repeat(100)}</a:t></p:sld>`
      ),
      'ppt/slides/slide2.xml': encoder.encode(
        '<p:sld><p:pic><a:blip r:embed="rId1"/></p:pic></p:sld>'
      ),
      'ppt/slides/slide3.xml': encoder.encode(
        `<p:sld><a:t>${'Readable text '.repeat(45)}</a:t><p:pic><a:blip r:embed="rId2"/></p:pic></p:sld>`
      ),
    });
    const analyzed = analyzeOoxmlBuffer(archive, 'pptx', MAX_PAGES);
    expect(analyzed).toMatchObject({
      ocrPageCount: 1,
      pageCount: 3,
      pageCountEstimated: false,
      slideCount: 3,
      textPageCount: 2,
    });
  });

  it('uses DOCX page metadata but marks the rendered page model estimated', () => {
    const archive = zipSync({
      'docProps/app.xml': encoder.encode(
        '<Properties><Pages>3</Pages></Properties>'
      ),
      'word/document.xml': encoder.encode(
        `<w:document><w:t>${'Paragraph text '.repeat(220)}</w:t></w:document>`
      ),
    });
    const analyzed = analyzeOoxmlBuffer(archive, 'docx', MAX_PAGES);
    expect(analyzed.pageCount).toBe(3);
    expect(analyzed.pageCountEstimated).toBe(true);
  });

  it('ignores absurd DOCX page metadata and uses page-break evidence', () => {
    const archive = zipSync({
      'docProps/app.xml': encoder.encode(
        `<Properties><Pages>${'9'.repeat(100_000)}</Pages></Properties>`
      ),
      'word/document.xml': encoder.encode(
        '<w:document><w:t>First</w:t><w:br w:type="page"/><w:t>Second</w:t><w:lastRenderedPageBreak/><w:t>Third</w:t></w:document>'
      ),
    });

    const analyzed = analyzeOoxmlBuffer(archive, 'docx', MAX_PAGES);
    expect(analyzed.pageCount).toBe(3);
  });

  it('refuses Office files past the policy page cap as too_many_pages', () => {
    const docx = zipSync({
      'word/document.xml': encoder.encode(
        `<w:document><w:t>Text</w:t>${'<w:br w:type="page"/>'.repeat(3)}</w:document>`
      ),
    });
    const declaredDocx = zipSync({
      'docProps/app.xml': encoder.encode(
        '<Properties><Pages>4</Pages></Properties>'
      ),
      'word/document.xml': encoder.encode(
        '<w:document><w:t>Text</w:t></w:document>'
      ),
    });
    const pptx = zipSync({
      'ppt/slides/slide1.xml': encoder.encode('<p:sld/>'),
      'ppt/slides/slide2.xml': encoder.encode('<p:sld/>'),
      'ppt/slides/slide3.xml': encoder.encode('<p:sld/>'),
    });
    const xlsx = zipSync({
      'xl/worksheets/sheet1.xml': encoder.encode(
        '<worksheet><sheetData><c r="A101"><v>1</v></c></sheetData></worksheet>'
      ),
    });

    expect(errorCode(() => analyzeOoxmlBuffer(docx, 'docx', 3))).toBe(
      'too_many_pages'
    );
    expect(errorCode(() => analyzeOoxmlBuffer(declaredDocx, 'docx', 3))).toBe(
      'too_many_pages'
    );
    expect(errorCode(() => analyzeOoxmlBuffer(pptx, 'pptx', 2))).toBe(
      'too_many_pages'
    );
    expect(errorCode(() => analyzeOoxmlBuffer(xlsx, 'xlsx', 2))).toBe(
      'too_many_pages'
    );
    expect(analyzeOoxmlBuffer(pptx, 'pptx', 3).pageCount).toBe(3);
  });

  it('counts worksheets and resolves shared strings', () => {
    const archive = zipSync({
      'xl/sharedStrings.xml': encoder.encode(
        `<sst><si><t>${'Cell text '.repeat(100)}</t></si></sst>`
      ),
      'xl/worksheets/sheet1.xml': encoder.encode(
        '<worksheet><sheetData><c t="s"><v>0</v></c></sheetData></worksheet>'
      ),
      'xl/worksheets/sheet2.xml': encoder.encode(
        '<worksheet><sheetData><c><v>42</v></c></sheetData></worksheet>'
      ),
    });
    const analyzed = analyzeOoxmlBuffer(archive, 'xlsx', MAX_PAGES);
    expect(analyzed).toMatchObject({
      pageCount: 2,
      pageCountEstimated: true,
      sheetCount: 2,
    });
    expect(analyzed.pages[0].reason).toBe('text_layer');
  });

  it('estimates rendered XLSX pages from the used cell extent', () => {
    const archive = zipSync({
      'xl/worksheets/sheet1.xml': encoder.encode(
        '<worksheet><sheetData><c r="K51"><v>42</v></c></sheetData></worksheet>'
      ),
    });

    const analyzed = analyzeOoxmlBuffer(archive, 'xlsx', MAX_PAGES);

    expect(analyzed.pageCount).toBe(4);
    expect(analyzed.sheetCount).toBe(1);
    expect(analyzed.pageCountEstimated).toBe(true);
  });
});

describe('analysis failures', () => {
  it('tells a user password apart from a damaged file', () => {
    const password = Object.assign(new Error('No password given'), {
      name: 'PasswordException',
    });
    const invalid = Object.assign(new Error('Invalid PDF structure.'), {
      name: 'InvalidPDFException',
    });
    const cap = new SourceAnalysisError('too_many_pages', 'PDF has more');

    expect(analysisErrorFor(password).code).toBe('password_protected');
    expect(analysisErrorFor(invalid).code).toBe('unreadable');
    expect(
      analysisErrorFor(new Error('The PPTX contains no slides')).code
    ).toBe('unreadable');
    expect(analysisErrorFor(cap)).toBe(cap);
  });
});

describe('SourceAnalysisQueue', () => {
  it('runs one worker at a time and forwards progress', async () => {
    const workers: FakeWorker[] = [];
    const queue = new SourceAnalysisQueue(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const progress: number[] = [];
    const first = queue.enqueue({
      id: 'first',
      input: input('first.pdf'),
      onProgress: (value) => progress.push(value.percent),
    });
    const second = queue.enqueue({ id: 'second', input: input('second.pdf') });

    expect(workers).toHaveLength(1);
    workers[0].respond({
      jobId: 'first',
      progress: {
        completed: 1,
        percent: 50,
        phase: 'analyzing',
        total: 2,
      },
      type: 'progress',
    });
    workers[0].respond({ jobId: 'first', result: result(), type: 'result' });
    await expect(first.promise).resolves.toEqual(result());
    expect(progress).toEqual([50]);
    expect(workers).toHaveLength(2);

    workers[1].respond({ jobId: 'second', result: result(), type: 'result' });
    await expect(second.promise).resolves.toEqual(result());
  });

  it('rejects with the failure code the worker sent', async () => {
    const workers: FakeWorker[] = [];
    const queue = new SourceAnalysisQueue(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const job = queue.enqueue({ id: 'locked', input: input('locked.pdf') });
    expect(workers[0].request?.input.maxPages).toBe(MAX_PAGES);
    workers[0].respond({
      code: 'password_protected',
      jobId: 'locked',
      message: 'No password given',
      type: 'error',
    });

    await expect(job.promise).rejects.toMatchObject({
      code: 'password_protected',
    });
  });

  it('removes queued work and terminates active work when cancelled', async () => {
    const workers: FakeWorker[] = [];
    const queue = new SourceAnalysisQueue(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const first = queue.enqueue({ id: 'first', input: input('first.pdf') });
    const second = queue.enqueue({ id: 'second', input: input('second.pdf') });
    second.cancel();
    first.cancel();

    await expect(second.promise).rejects.toBeInstanceOf(
      SourceAnalysisCancelledError
    );
    await expect(first.promise).rejects.toBeInstanceOf(
      SourceAnalysisCancelledError
    );
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);
  });

  it('reuses a completed result without starting another worker', async () => {
    const workers: FakeWorker[] = [];
    const queue = new SourceAnalysisQueue(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const selected = file('cached.pdf');
    const selectedInput = localSourceAnalysisInput(
      selected,
      sourceUploadPolicy
    );
    if (!selectedInput) throw new Error('Expected supported test input');
    const first = queue.enqueue({ id: 'first', input: selectedInput });
    workers[0].respond({ jobId: 'first', result: result(), type: 'result' });
    await first.promise;

    await expect(
      queue.enqueue({ id: 'second', input: selectedInput }).promise
    ).resolves.toEqual(result());
    expect(workers).toHaveLength(1);
  });
});

describe('fast-parse extensions come from the upload policy', () => {
  it('estimates only what the policy fast-parses and the browser can open', () => {
    expect(sourceAnalysisExtension('notes.pdf', sourceUploadPolicy)).toBe(
      'pdf'
    );
    const narrowed = {
      parseModes: [
        { ...sourceUploadPolicy.parseModes[0]!, extensions: ['.docx'] },
      ],
    };
    expect(sourceAnalysisExtension('notes.pdf', narrowed)).toBeNull();
    const widened = {
      parseModes: [
        { ...sourceUploadPolicy.parseModes[0]!, extensions: ['.pdf', '.epub'] },
      ],
    };
    expect(sourceAnalysisExtension('book.epub', widened)).toBeNull();
  });
});
