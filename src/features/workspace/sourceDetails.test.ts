import { describe, expect, it } from 'vitest';

import { sourceUploadPolicy } from '@/mocks/sourceUploadPolicy';
import {
  aggregateSourceAnalysis,
  remoteSourceAnalysisInput,
  sourceAnalysisBlocksSubmit,
  validateLocalSourceSelection,
} from './sourceDetails';

describe('unified source details', () => {
  it('accepts unknown files for storage and rejects oversized files', () => {
    const accepted = new File(['ok'], 'notes.pdf');
    const unsupported = new File(['bad'], 'archive.exe');
    const oversized = new File(
      [new Uint8Array(sourceUploadPolicy.maxBytes + 1)],
      'large.pdf'
    );

    const result = validateLocalSourceSelection(
      [accepted, unsupported, oversized],
      sourceUploadPolicy
    );

    expect(result.accepted.map((item) => item.file.name)).toEqual([
      'notes.pdf',
      'archive.exe',
    ]);
    expect(
      result.rejected.map((item) => [item.file.name, item.reason])
    ).toEqual([['large.pdf', 'file_too_large']]);
  });

  it('totals analyzed text and OCR pages for the dialog summary', () => {
    expect(
      aggregateSourceAnalysis([
        {
          extension: 'pdf',
          ocrPageCount: 2,
          pageCount: 5,
          pageCountEstimated: false,
          pages: [],
          scanEstimate: true,
          textPageCount: 3,
        },
        {
          extension: 'pptx',
          ocrPageCount: 1,
          pageCount: 4,
          pageCountEstimated: false,
          pages: [],
          scanEstimate: true,
          slideCount: 4,
          textPageCount: 3,
        },
      ])
    ).toEqual({ ocrPages: 3, pages: 9, textPages: 6 });
  });

  it('builds a same-origin remote analysis input with request headers', () => {
    const input = remoteSourceAnalysisInput(
      {
        analysisUrl:
          '/api/workspaces/ws_1/sources/import-content?provider=google&fileId=file_1',
        fileId: 'file_1',
        name: 'notes.docx',
        sizeBytes: 2048,
      },
      'google',
      { Authorization: 'Bearer test', 'X-Trace-ID': 'trace_1' },
      'inspection_1'
    );

    expect(input).toMatchObject({
      kind: 'docx',
      name: 'notes.docx',
      source: {
        headers: {
          Authorization: 'Bearer test',
          'X-Trace-ID': 'trace_1',
        },
        url: '/api/workspaces/ws_1/sources/import-content?provider=google&fileId=file_1',
      },
    });
  });

  it('does not send images through document page analysis', () => {
    const input = remoteSourceAnalysisInput(
      {
        analysisUrl:
          '/api/workspaces/ws_1/sources/import-content?provider=microsoft&fileId=image_1',
        fileId: 'image_1',
        name: 'scan.jp2',
        sizeBytes: 4096,
      },
      'microsoft',
      {},
      'inspection_1'
    );

    expect(input).toBeUndefined();
  });

  it('blocks billed rows until an analysis input and result are ready', () => {
    const analysisInput = remoteSourceAnalysisInput(
      {
        analysisUrl: '/api/workspaces/ws_1/sources/import-content',
        fileId: 'document_1',
        name: 'scan.pdf',
        sizeBytes: 4096,
      },
      'google',
      {},
      'inspection_1'
    );
    if (!analysisInput) throw new Error('Expected PDF analysis input');
    const base = {
      analysisInput,
      analysisResult: {
        extension: 'pdf' as const,
        ocrPageCount: 1,
        pageCount: 1,
        pageCountEstimated: false as const,
        pages: [],
        scanEstimate: true as const,
        textPageCount: 0,
      },
      analysisStatus: 'ready' as const,
      kind: 'pdf' as const,
      parseMode: 'fast' as const,
    };

    expect(sourceAnalysisBlocksSubmit(base, sourceUploadPolicy)).toBe(false);
    expect(
      sourceAnalysisBlocksSubmit(
        { ...base, analysisInput: undefined },
        sourceUploadPolicy
      )
    ).toBe(true);
    expect(
      sourceAnalysisBlocksSubmit(
        { ...base, analysisResult: undefined },
        sourceUploadPolicy
      )
    ).toBe(true);
    expect(
      sourceAnalysisBlocksSubmit(
        { ...base, analysisStatus: 'analyzing' },
        sourceUploadPolicy
      )
    ).toBe(true);
    expect(
      sourceAnalysisBlocksSubmit({ ...base, kind: 'txt' }, sourceUploadPolicy)
    ).toBe(false);
  });

  it('isolates remote analysis cache entries by picker inspection', () => {
    const item = {
      analysisUrl: '/api/workspaces/ws_1/sources/import-content',
      fileId: 'file_1',
      name: 'notes.pdf',
      sizeBytes: 2048,
    };
    const firstSelection = remoteSourceAnalysisInput(
      item,
      'google',
      {},
      'inspection_1'
    );
    const sameRow = remoteSourceAnalysisInput(
      item,
      'google',
      {},
      'inspection_1'
    );
    const newSelection = remoteSourceAnalysisInput(
      item,
      'google',
      {},
      'inspection_2'
    );

    expect(sameRow?.key).toBe(firstSelection?.key);
    expect(newSelection?.key).not.toBe(firstSelection?.key);
  });
});
