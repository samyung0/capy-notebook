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
