import type { SourceFile } from '@/api/types';
import { notIndexedMessage } from '@/features/files/fileUtils';
import { m } from '@/i18n';
import type { SourceTransfer } from './sourceTransfers';

export type TransferStatus =
  | { kind: 'progress'; label: string; value: number }
  | { kind: 'indeterminate'; label: string }
  | {
      detail?: string;
      kind: 'done' | 'background' | 'info' | 'error';
      label: string;
    };

/** One row's status: the transfer stage until the file exists, then the
 * file's own ingest status from the files cache. */
export function transferStatus(
  transfer: SourceTransfer,
  file: SourceFile | undefined
): TransferStatus {
  switch (transfer.stage) {
    case 'waiting':
      return { kind: 'progress', label: m.source_transfer_waiting(), value: 0 };
    case 'uploading':
      return {
        kind: 'progress',
        label: m.source_transfer_uploading(),
        value: transfer.uploadPct,
      };
    case 'importing':
      return { kind: 'indeterminate', label: m.source_transfer_importing() };
    case 'background':
      return {
        detail: m.source_transfer_background_detail(),
        kind: 'background',
        label: m.source_transfer_background(),
      };
    case 'failed':
      return {
        detail: transfer.error,
        kind: 'error',
        label: m.source_transfer_not_added(),
      };
    case 'added':
      break;
  }
  // Not in the cache yet, or still waiting for a parser.
  if (!file || file.status === 'pending') {
    return { kind: 'progress', label: m.source_transfer_queued(), value: 0 };
  }
  if (file.status === 'processing') {
    return {
      kind: 'progress',
      label: m.source_transfer_parsing(),
      value: file.ingestPct ?? 0,
    };
  }
  if (file.status === 'failed') {
    return {
      detail: m.files_not_indexed_failed(),
      kind: 'error',
      label: m.source_transfer_parse_failed(),
    };
  }
  // Ready, or a file without a status, which the app treats as done. A file
  // without an index is one the user chose not to parse or one over an ingest
  // limit: information, not a warning.
  return file.indexed
    ? { kind: 'done', label: m.source_transfer_ready() }
    : {
        detail: notIndexedMessage(file),
        kind: 'info',
        label: m.source_transfer_not_searchable(),
      };
}
