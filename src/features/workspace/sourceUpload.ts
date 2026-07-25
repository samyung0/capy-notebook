import type { FileKind, SourceUploadPolicy } from '@/api/types';

export type ParseMode = 'advanced' | 'normal' | 'none';

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
): { advanced: string | null; normal: string | null } {
  if (isTextKind(kind, policy)) return { advanced: null, normal: null };
  const ext = extensionWithDot(file.name);
  const issueFor = (mode: 'advanced' | 'normal') => {
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
      mode === 'normal' &&
      rule.maxPages != null &&
      pageCount != null &&
      pageCount > rule.maxPages
    ) {
      return `over ${rule.maxPages} pages`;
    }
    return null;
  };
  return { advanced: issueFor('advanced'), normal: issueFor('normal') };
}

export function defaultParseMode(
  file: Pick<File, 'name' | 'size'>,
  kind: FileKind,
  policy: SourceUploadPolicy,
  pageCount?: number | null
): ParseMode {
  if (isTextKind(kind, policy)) return 'none';
  const issues = parseModeIssues(file, kind, policy, pageCount);
  if (!issues.normal) return 'normal';
  if (!issues.advanced) return 'advanced';
  return 'none';
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
