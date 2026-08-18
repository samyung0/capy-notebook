import { isApiError } from '@/api/client';
import type { FileKind, SourceUploadPolicy } from '@/api/types';

export type ParseMode = 'accurate' | 'fast' | 'none';

const PARSING_MODES = ['accurate', 'fast'] as const;
type ParsingMode = (typeof PARSING_MODES)[number];

export function fileExt(name: string): string {
  return name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : '';
}

function extensionWithDot(name: string): string {
  const ext = fileExt(name);
  return ext ? `.${ext}` : '';
}

export function getFileKind(
  name: string,
  policy: SourceUploadPolicy
): FileKind {
  const ext = extensionWithDot(name);
  if (!ext && policy.allowNoExtension) return 'txt';
  return (
    policy.kinds.find((kind) =>
      kind.extensions.some((candidate) => candidate.toLowerCase() === ext)
    )?.kind ?? 'unknown'
  );
}

export function isTextKind(
  kind: FileKind,
  policy: SourceUploadPolicy
): boolean {
  return policy.kinds.some((entry) => entry.kind === kind && entry.text);
}

export function parseModeIssues(
  file: Pick<File, 'name' | 'size'>,
  kind: FileKind,
  policy: SourceUploadPolicy,
  pageCount?: number | null
): Record<ParsingMode, string | null> {
  if (isTextKind(kind, policy)) return { accurate: null, fast: null };
  const ext = extensionWithDot(file.name);
  const issueFor = (mode: ParsingMode) => {
    const rule = policy.parseModes.find((entry) => entry.mode === mode);
    if (
      !rule?.extensions.some((candidate) => candidate.toLowerCase() === ext)
    ) {
      return 'format not supported';
    }
    if (file.size > rule.maxBytes) {
      return `over ${Math.round(rule.maxBytes / 1024 / 1024)} MB`;
    }
    if (
      rule.maxPages != null &&
      pageCount != null &&
      pageCount > rule.maxPages
    ) {
      return `over ${rule.maxPages} pages`;
    }
    return null;
  };
  return { accurate: issueFor('accurate'), fast: issueFor('fast') };
}

export function defaultParseMode(
  file: Pick<File, 'name' | 'size'>,
  kind: FileKind,
  policy: SourceUploadPolicy,
  pageCount?: number | null
): ParseMode {
  if (isTextKind(kind, policy)) return 'none';
  const issues = parseModeIssues(file, kind, policy, pageCount);
  if (!issues.fast) return 'fast';
  if (!issues.accurate) return 'accurate';
  return 'none';
}

/** Whether the image-captioning switch has anything to act on for this mode. */
export function supportsFigures(
  mode: ParseMode,
  kind: FileKind,
  policy: SourceUploadPolicy
): boolean {
  if (mode === 'none' || isTextKind(kind, policy)) return false;
  return (
    policy.parseModes.find((entry) => entry.mode === mode)?.supportsFigures ??
    false
  );
}

export interface UploadProgressItem {
  size: number;
  uploadPct?: number;
}

/** Returns a byte-weighted batch percentage so large files contribute fairly. */
export function aggregateUploadPct(
  items: readonly UploadProgressItem[]
): number {
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  if (totalBytes === 0) return 0;
  const uploadedBytes = items.reduce(
    (sum, item) =>
      sum + (item.size * Math.max(0, Math.min(100, item.uploadPct ?? 0))) / 100,
    0
  );
  return Math.round((uploadedBytes / totalBytes) * 100);
}

export const MAX_SOURCE_UPLOAD_FILES = 20;
export const MAX_FILES_PER_WORKSPACE = 100;
export const SOURCE_UPLOAD_CONCURRENCY = 3;

export function capSourceUploads<T>(
  existingCount: number,
  incoming: T[],
  workspaceRoom: number = MAX_SOURCE_UPLOAD_FILES
): { accepted: T[]; rejected: number } {
  const cap = Math.max(
    0,
    Math.min(MAX_SOURCE_UPLOAD_FILES, workspaceRoom) - existingCount
  );
  return {
    accepted: incoming.slice(0, cap),
    rejected: Math.max(0, incoming.length - cap),
  };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(
    Array.from({ length: items.length === 0 ? 0 : workerCount }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = {
            status: 'fulfilled',
            value: await fn(items[index], index),
          };
        } catch (reason) {
          results[index] = { reason, status: 'rejected' };
        }
      }
    })
  );
  return results;
}

export function retryAfterMs(error: unknown): number | null {
  if (!isApiError(error) || error.status !== 429) return null;
  const seconds = Number(error.body?.retryAfterSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1000;
  return Math.min(30_000, Math.ceil(seconds) * 1000);
}

export async function withUploadRetry<T>(
  fn: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delay = retryAfterMs(error);
      if (delay == null || attempt >= 4) throw error;
      await wait(delay);
    }
  }
}
