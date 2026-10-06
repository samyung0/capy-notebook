import type { FileKind, SourceFile, SourceUploadPolicy } from '@/api/types';
import { fileExt } from '@/features/files/fileUtils';
import { m } from '@/i18n';

import {
  fastParseExtensions,
  fastParseLimits,
  type SourceAnalysisErrorCode,
  type SourceAnalysisInput,
  type SourceAnalysisResult,
  sourceAnalysisExtension,
} from './sourceAnalysis';
import { getFileKind, isTextKind, type ParseMode } from './sourceUpload';

export type SourceAnalysisStatus =
  | 'idle'
  | 'queued'
  | 'analyzing'
  | 'ready'
  | 'error';

interface AnalyzedSource {
  analysisError?: SourceAnalysisErrorCode;
  analysisInput?: SourceAnalysisInput;
  analysisResult?: SourceAnalysisResult;
  analysisStatus: SourceAnalysisStatus;
  kind: FileKind;
  parseMode: ParseMode;
}

export type SourceAnalysisIssue =
  | { code: SourceAnalysisErrorCode | 'unsupported' }
  | {
      code: 'scanned_pages_warning' | 'too_many_scanned_pages';
      ocrPages: number;
    };

/** What the row says about a fast-parse source's analysis. Failures come from
 * the worker. The OCR bands derive from the policy's maxOcrPages because the
 * browser count is an estimate: a PDF over 105% of the cap is refused, one
 * from 95% warns and uploads (the parser refuses it if it really is over).
 * Office estimates miss slide-master text, so they only ever warn. */
export function sourceAnalysisIssue(
  source: AnalyzedSource,
  policy: Pick<SourceUploadPolicy, 'parseModes'>
): SourceAnalysisIssue | null {
  if (source.parseMode !== 'fast') return null;
  if (source.analysisStatus === 'error') {
    if (!source.analysisInput) return { code: 'unsupported' };
    return { code: source.analysisError ?? 'failed' };
  }
  const result = source.analysisResult;
  const limits = fastParseLimits(policy);
  if (source.analysisStatus !== 'ready' || !result || !limits) return null;
  const ocrPages = result.ocrPageCount;
  if (result.extension === 'pdf' && ocrPages * 100 > limits.maxOcrPages * 105) {
    return { code: 'too_many_scanned_pages', ocrPages };
  }
  if (ocrPages * 100 >= limits.maxOcrPages * 95) {
    return { code: 'scanned_pages_warning', ocrPages };
  }
  return null;
}

export function sourceAnalysisIssueMessage(
  issue: SourceAnalysisIssue,
  policy: Pick<SourceUploadPolicy, 'parseModes'>
): string {
  const limits = fastParseLimits(policy);
  switch (issue.code) {
    case 'unsupported':
      return m.source_analysis_unsupported();
    case 'password_protected':
      return m.source_analysis_password_protected();
    case 'unreadable':
      return m.source_analysis_unreadable();
    case 'too_many_pages':
      return m.source_analysis_too_many_pages({ max: limits?.maxPages });
    case 'too_many_scanned_pages':
      return m.source_analysis_too_many_scanned_pages({
        max: limits?.maxOcrPages,
        ocr: issue.ocrPages,
      });
    case 'scanned_pages_warning':
      return m.source_analysis_scanned_pages_warning({
        max: limits?.maxOcrPages,
        ocr: issue.ocrPages,
      });
    case 'failed':
      return m.source_analysis_failed();
  }
}

export function sourceAnalysisBlocksSubmit(
  source: AnalyzedSource,
  policy: SourceUploadPolicy
): boolean {
  if (source.parseMode !== 'fast' || isTextKind(source.kind, policy)) {
    return false;
  }
  // Running or failed analysis holds submit until the source is removed or
  // its parsing is turned off, so every reserved fast-parse document carries
  // an estimate.
  return (
    !source.analysisInput ||
    source.analysisStatus !== 'ready' ||
    !source.analysisResult ||
    sourceAnalysisIssue(source, policy)?.code === 'too_many_scanned_pages'
  );
}

export interface LocalSourceSelection {
  file: File;
  kind: SourceFile['kind'];
}

export interface RejectedLocalSource {
  file: File;
  reason: 'file_too_large';
}

export function validateLocalSourceSelection(
  files: readonly File[],
  policy: SourceUploadPolicy
): {
  accepted: LocalSourceSelection[];
  rejected: RejectedLocalSource[];
} {
  const accepted: LocalSourceSelection[] = [];
  const rejected: RejectedLocalSource[] = [];
  for (const file of files) {
    const kind = getFileKind(file.name, policy);
    if (file.size > policy.maxBytes) {
      rejected.push({ file, reason: 'file_too_large' });
    } else {
      accepted.push({ file, kind });
    }
  }
  return { accepted, rejected };
}

/** A source the policy fast-parses but the browser cannot estimate starts in
 * the error state, so the row says why submit stays disabled instead of
 * sitting idle forever. */
export function initialAnalysisStatus(
  name: string,
  input: SourceAnalysisInput | undefined,
  policy: Pick<SourceUploadPolicy, 'parseModes'>
): SourceAnalysisStatus {
  if (input) return 'idle';
  return fastParseExtensions(policy).has(fileExt(name)) ? 'error' : 'idle';
}

export function aggregateSourceAnalysis(
  results: readonly (SourceAnalysisResult | undefined)[]
): { ocrPages: number; pages: number; textPages: number } {
  return results.reduce(
    (total, result) => ({
      ocrPages: total.ocrPages + (result?.ocrPageCount ?? 0),
      pages: total.pages + (result?.pageCount ?? 0),
      textPages: total.textPages + (result?.textPageCount ?? 0),
    }),
    { ocrPages: 0, pages: 0, textPages: 0 }
  );
}

export function remoteSourceAnalysisInput(
  item: {
    analysisUrl: string;
    driveId?: string;
    fileId: string;
    name: string;
    sizeBytes: number;
  },
  provider: 'google' | 'microsoft',
  headers: Readonly<Record<string, string>>,
  inspectionKey: string,
  policy: Pick<SourceUploadPolicy, 'parseModes'>
): SourceAnalysisInput | undefined {
  const kind = sourceAnalysisExtension(item.name, policy);
  const limits = fastParseLimits(policy);
  if (!(kind && limits)) return;
  return {
    key: `${inspectionKey}\0${provider}\0${item.driveId ?? ''}\0${item.fileId}\0${item.sizeBytes}`,
    kind,
    maxPages: limits.maxPages,
    name: item.name,
    source: { headers, url: item.analysisUrl },
  };
}

/** Analysis of a file already stored in the workspace (Retry processing),
 * read through its short-lived presigned link. */
export function storedSourceAnalysisInput(
  file: { id: string; name: string; revision: number },
  url: string,
  policy: Pick<SourceUploadPolicy, 'parseModes'>
): SourceAnalysisInput | undefined {
  const kind = sourceAnalysisExtension(file.name, policy);
  const limits = fastParseLimits(policy);
  if (!(kind && limits)) return;
  return {
    key: `stored\0${file.id}\0${file.revision}`,
    kind,
    maxPages: limits.maxPages,
    name: file.name,
    source: { url },
  };
}
