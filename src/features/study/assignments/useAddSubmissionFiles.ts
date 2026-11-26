import { useState } from 'react';
import {
  type SubmissionOf,
  useSourceUploadPolicy,
  useUploadSource,
} from '@/api/hooks';
import {
  SUBMISSION_BYTES_MAX,
  SUBMISSION_FILE_MAX,
  SUBMISSION_FILES_MAX,
} from '@/api/limits.generated';
import type { PaperFile } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import { formatFileSize } from '@/features/files/fileUtils';
import {
  localSourceAnalysisInput,
  SourceAnalysisError,
  type SourceAnalysisInput,
  SourceAnalysisQueue,
} from '@/features/workspace/sourceAnalysis';
import { compressSource } from '@/features/workspace/sourceCompress';
import {
  getFileKind,
  sourceCompression,
} from '@/features/workspace/sourceUpload';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';

/** Why a picked file is refused before it uploads: a password-protected or
 * damaged document, as the normal upload's browser analysis finds it (Q726 A);
 * null when it may go. Other failures leave it to the upload. */
async function pickRefusal(
  queue: SourceAnalysisQueue,
  input: SourceAnalysisInput | null
) {
  if (!input) return null;
  try {
    await queue.enqueue({ id: input.key, input }).promise;
    return null;
  } catch (error) {
    if (!(error instanceof SourceAnalysisError)) return null;
    if (error.code === 'password_protected')
      return m.assignment_paper_password();
    if (error.code === 'unreadable') return m.assignment_paper_damaged();
    return null;
  }
}

/** Adds picked files to a paper or a hand-in, each through the normal upload
 * with the attempt or assignment named, as one quiet batch. A password-protected
 * or damaged document is refused as it is picked, the others still going. A
 * photo or an Office file's pictures are compressed first, as any upload's are
 * (`sourceTransfers`), so a phone's camera fits the image caps. The bounds are
 * the same on every plan (Epo 2026-11-25): at most SUBMISSION_FILES_MAX files,
 * each within SUBMISSION_FILE_MAX after compression and all within
 * SUBMISSION_BYTES_MAX, which the server checks again. The page holds the
 * returned state: Submit waits while a file uploads. */
export function useAddSubmissionFiles(of: SubmissionOf) {
  const { data: policy } = useSourceUploadPolicy(undefined, {
    errorBoundary: false,
  });
  const { mutateAsync: upload } = useUploadSource(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const add = async (
    list: FileList | readonly File[] | null,
    /** The files the paper or hand-in holds already. */
    held: readonly PaperFile[]
  ) => {
    if (!list?.length || !policy) return;
    const picked = [...list];
    if (held.length + uploading.length + picked.length > SUBMISSION_FILES_MAX) {
      userToast({
        title: m.assignment_files_too_many({ max: SUBMISSION_FILES_MAX }),
        variant: 'error',
      });
      return;
    }
    let bytes = held.reduce((n, f) => n + f.sizeBytes, 0);
    const maxBytes = Math.min(policy.maxBytes, SUBMISSION_FILE_MAX);
    setUploading((prev) => [...prev, ...picked.map((f) => f.name)]);
    // One entry: two picks of the same name each hold Submit.
    const done = (file: File) =>
      setUploading((prev) => {
        const at = prev.indexOf(file.name);
        return at < 0 ? prev : [...prev.slice(0, at), ...prev.slice(at + 1)];
      });
    const queue = new SourceAnalysisQueue();
    const accepted: File[] = [];
    for (const file of picked) {
      const refusal = await pickRefusal(
        queue,
        localSourceAnalysisInput(file, policy)
      );
      if (refusal) {
        userToast({ title: refusal, variant: 'error' });
        done(file);
      } else accepted.push(file);
    }
    queue.dispose();
    // Compressed and checked against the submission limits first, so the
    // batch's notification counts only the files that upload.
    const sendable: {
      file: File;
      kind: ReturnType<typeof getFileKind>;
      sent: File;
    }[] = [];
    for (const file of accepted) {
      try {
        const kind = getFileKind(file.name, policy);
        const compression = sourceCompression(file.name, kind);
        const sent = compression
          ? (
              await compressSource(
                {
                  compression,
                  file,
                  imageMaxBytes: policy.imageMaxBytes,
                  maxBytes,
                },
                () => undefined,
                new AbortController().signal
              )
            ).file
          : file;
        const refusal =
          sent.size > SUBMISSION_FILE_MAX
            ? m.assignment_file_too_large({
                name: file.name,
                size: formatFileSize(SUBMISSION_FILE_MAX),
              })
            : bytes + sent.size > SUBMISSION_BYTES_MAX &&
              m.assignment_files_too_large({
                size: formatFileSize(SUBMISSION_BYTES_MAX),
              });
        if (refusal) {
          userToast({ title: refusal, variant: 'error' });
          done(file);
          continue;
        }
        bytes += sent.size;
        sendable.push({ file, kind, sent });
      } catch (error) {
        userToast({
          title: errorCopy(error, m.assignment_paper_upload_failed()),
          variant: 'error',
        });
        done(file);
      }
    }
    const batchId = crypto.randomUUID();
    for (const { file, kind, sent } of sendable) {
      try {
        await upload({
          ...of,
          batchId,
          batchTotal: sendable.length,
          file: sent,
          kind,
        });
      } catch (error) {
        userToast({
          title: errorCopy(error, m.assignment_paper_upload_failed()),
          variant: 'error',
        });
      } finally {
        done(file);
      }
    }
  };
  return { add, ready: !!policy, uploading };
}

export type SubmissionFiles = ReturnType<typeof useAddSubmissionFiles>;
