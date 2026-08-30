import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  calculateParseCreditMicros,
  localSourceAnalysisInput,
  SourceAnalysisCancelledError,
  SourceAnalysisQueue,
  type SourceAnalysisRequest,
  type SourceAnalysisResult,
  type SourceAnalysisWorkerResponse,
  sourceAnalysisExtension,
} from './sourceAnalysis';
import {
  analyzeOoxmlBuffer,
  classifySourcePage,
  damagedTextReason,
  estimatePdfArgumentBytes,
  MAX_DOCX_ANALYSIS_PAGES,
  MAX_OOXML_ARCHIVE_ENTRIES,
  MAX_OOXML_EXPANDED_BYTES,
  MAX_PDF_ANALYSIS_IMAGE_PIXELS,
  MAX_PDF_ANALYSIS_MILLISECONDS,
  MAX_PDF_ANALYSIS_OPERATORS,
  MAX_PDF_ANALYSIS_PAGES,
  MAX_PDF_ANALYSIS_TEXT_CHARS,
  MAX_PDF_OPERATION_MILLISECONDS,
  MAX_XLSX_ANALYSIS_PAGES,
  PdfAnalysisBudget,
} from './sourceAnalysisCore';

const encoder = new TextEncoder();

const result = (extension: 'pdf' | 'pptx' = 'pdf'): SourceAnalysisResult => ({
  extension,
  ocrPageCount: 1,
  pageCount: 2,
  pageCountEstimated: false,
  pages: [
    {
      chars: 900,
      imageCoverage: 0,
      needsOcr: false,
      pageNumber: 1,
      reason: 'text_layer',
    },
    {
      chars: 0,
      imageCoverage: 1,
      needsOcr: true,
      pageNumber: 2,
      reason: 'scan',
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
  const value = localSourceAnalysisInput(file(name));
  if (!value) throw new Error(`Unsupported test input: ${name}`);
  return value;
}

describe('source analysis classification', () => {
  it('matches the parser VM page thresholds', () => {
    expect(classifySourcePage('a'.repeat(800), 0.95, 1).reason).toBe(
      'text_layer'
    );
    expect(classifySourcePage('short', 0.7, 1).reason).toBe('scan');
    expect(classifySourcePage('a'.repeat(399), 0.1, 1).reason).toBe(
      'thin_text'
    );
    expect(classifySourcePage('a'.repeat(500), 0.1, 1).reason).toBe(
      'enough_text'
    );
  });

  it('detects damaged native text layers', () => {
    expect(damagedTextReason('usable\ufffdtext')).toBe('replacement_chars');
    expect(damagedTextReason('a\u0000b')).toBe('control_chars');
    expect(damagedTextReason(`${'! '.repeat(100)}`)).toBe('low_alnum');
    expect(
      damagedTextReason(Array.from({ length: 24 }, () => 'a').join(' '))
    ).toBe('broken_spacing');
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
      expect(sourceAnalysisExtension(`scan.${extension}`)).toBeNull();
      expect(localSourceAnalysisInput(file(`scan.${extension}`))).toBeNull();
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

    expect(() => analyzeOoxmlBuffer(oversized, 'xlsx')).toThrow(
      `OOXML archive expands beyond the browser analysis limit (maximum ${MAX_OOXML_EXPANDED_BYTES / 1024 / 1024} MiB)`
    );
  });

  it('rejects archives with too many entries before extraction', () => {
    const entries: Record<string, Uint8Array> = {};
    for (let index = 0; index < MAX_OOXML_ARCHIVE_ENTRIES + 1; index += 1) {
      entries[`entry-${index}.xml`] = encoder.encode('x');
    }

    expect(() => analyzeOoxmlBuffer(zipSync(entries), 'xlsx')).toThrow(
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
    const analyzed = analyzeOoxmlBuffer(archive, 'pptx');
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
    const analyzed = analyzeOoxmlBuffer(archive, 'docx');
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

    const analyzed = analyzeOoxmlBuffer(archive, 'docx');
    expect(analyzed.pageCount).toBe(3);
  });

  it('rejects DOCX bodies whose page-break estimate exceeds the cap', () => {
    const breaks = '<w:br w:type="page"/>'.repeat(MAX_DOCX_ANALYSIS_PAGES);
    const archive = zipSync({
      'word/document.xml': encoder.encode(
        `<w:document><w:t>Text</w:t>${breaks}</w:document>`
      ),
    });

    expect(() => analyzeOoxmlBuffer(archive, 'docx')).toThrow(
      `DOCX has too many pages for browser analysis (maximum ${MAX_DOCX_ANALYSIS_PAGES})`
    );
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
    const analyzed = analyzeOoxmlBuffer(archive, 'xlsx');
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

    const analyzed = analyzeOoxmlBuffer(archive, 'xlsx');

    expect(analyzed.pageCount).toBe(4);
    expect(analyzed.sheetCount).toBe(1);
    expect(analyzed.pageCountEstimated).toBe(true);
  });

  it('rejects an XLSX print estimate beyond the analysis cap', () => {
    const archive = zipSync({
      'xl/worksheets/sheet1.xml': encoder.encode(
        '<worksheet><sheetData><c r="XFD1048576"><v>42</v></c></sheetData></worksheet>'
      ),
    });

    expect(() => analyzeOoxmlBuffer(archive, 'xlsx')).toThrow(
      `XLSX has too many estimated pages for browser analysis (maximum ${MAX_XLSX_ANALYSIS_PAGES})`
    );
  });
});

describe('PDF analysis budget', () => {
  it('accepts ordinary usage through each exact limit', () => {
    const budget = new PdfAnalysisBudget(0, 100);
    budget.assertPageCount(MAX_PDF_ANALYSIS_PAGES);
    budget.recordText(MAX_PDF_ANALYSIS_TEXT_CHARS);
    budget.recordOperators(MAX_PDF_ANALYSIS_OPERATORS, 0);
    expect(budget.remainingMilliseconds(100)).toBe(
      MAX_PDF_OPERATION_MILLISECONDS
    );
    budget.assertElapsed(100 + MAX_PDF_ANALYSIS_MILLISECONDS);
  });

  it('rejects excessive pages, text, operators, and decoded image pixels', () => {
    expect(() => {
      const budget = new PdfAnalysisBudget(0, 0);
      budget.assertPageCount(MAX_PDF_ANALYSIS_PAGES + 1);
    }).toThrow(
      `PDF has too many pages for browser analysis (maximum ${MAX_PDF_ANALYSIS_PAGES})`
    );

    expect(() => {
      const budget = new PdfAnalysisBudget(0, 0);
      budget.recordText(MAX_PDF_ANALYSIS_TEXT_CHARS + 1);
    }).toThrow(
      `PDF text exceeds the browser analysis limit (maximum ${MAX_PDF_ANALYSIS_TEXT_CHARS} characters)`
    );

    expect(() => {
      const budget = new PdfAnalysisBudget(0, 0);
      budget.recordOperators(MAX_PDF_ANALYSIS_OPERATORS + 1, 0);
    }).toThrow(
      `PDF operator list exceeds the browser analysis limit (maximum ${MAX_PDF_ANALYSIS_OPERATORS} operations)`
    );

    expect(() => {
      const budget = new PdfAnalysisBudget(0, 0);
      budget.recordOperators(0, MAX_PDF_ANALYSIS_IMAGE_PIXELS + 1);
    }).toThrow(
      `PDF images exceed the browser analysis limit (maximum ${MAX_PDF_ANALYSIS_IMAGE_PIXELS} decoded pixels)`
    );
  });

  it('rejects the cumulative memory estimate and elapsed-time budget', () => {
    expect(() => {
      const budget = new PdfAnalysisBudget(16 * 1024 * 1024, 0);
      budget.recordText(MAX_PDF_ANALYSIS_TEXT_CHARS);
      budget.recordOperators(
        MAX_PDF_ANALYSIS_OPERATORS,
        MAX_PDF_ANALYSIS_IMAGE_PIXELS
      );
    }).toThrow(
      'PDF analysis exceeds the browser memory estimate (maximum 128 MiB)'
    );

    expect(() => {
      const budget = new PdfAnalysisBudget(0, 100);
      budget.assertElapsed(100 + MAX_PDF_ANALYSIS_MILLISECONDS + 1);
    }).toThrow('PDF analysis timed out (maximum 30 seconds)');
  });

  it('includes decompressed operator argument buffers in the memory estimate', () => {
    const bytes = estimatePdfArgumentBytes([
      ['image', new Uint8Array(2 * 1024 * 1024)],
      new Float32Array(128),
    ]);

    expect(bytes).toBeGreaterThanOrEqual(2 * 1024 * 1024 + 128 * 4);
    expect(() => {
      const budget = new PdfAnalysisBudget(127 * 1024 * 1024, 0);
      budget.recordOperators(1, 0, bytes);
    }).toThrow(
      'PDF analysis exceeds the browser memory estimate (maximum 128 MiB)'
    );
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
    const selectedInput = localSourceAnalysisInput(selected);
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
