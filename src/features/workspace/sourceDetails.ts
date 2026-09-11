import type { FileKind, SourceFile, SourceUploadPolicy } from '@/api/types';
import { fileExt } from '@/features/files/fileUtils';

import {
  fastParseExtensions,
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

export function sourceAnalysisBlocksSubmit(
  source: {
    analysisInput?: SourceAnalysisInput;
    analysisResult?: SourceAnalysisResult;
    analysisStatus: SourceAnalysisStatus;
    kind: FileKind;
    parseMode: ParseMode;
  },
  policy: SourceUploadPolicy
): boolean {
  if (source.parseMode !== 'fast' || isTextKind(source.kind, policy)) {
    return false;
  }
  // Running or failed analysis holds submit until the source is removed, so
  // every reserved fast-parse document carries an estimate.
  return (
    !source.analysisInput ||
    source.analysisStatus !== 'ready' ||
    !source.analysisResult
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
  if (!kind) return;
  return {
    key: `${inspectionKey}\0${provider}\0${item.driveId ?? ''}\0${item.fileId}\0${item.sizeBytes}`,
    kind,
    name: item.name,
    source: { headers, url: item.analysisUrl },
  };
}
