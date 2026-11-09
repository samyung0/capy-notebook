import { useState } from 'react';
import {
  type SubmissionOf,
  useSourceUploadPolicy,
  useUploadSource,
} from '@/api/hooks';
import { userToast } from '@/components/ui/userToast';
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
 * (`sourceTransfers`), so a phone's camera fits the image caps. The page holds
 * the returned state: Submit waits while a file uploads. */
export function useAddSubmissionFiles(of: SubmissionOf) {
  const { data: policy } = useSourceUploadPolicy(undefined, {
    errorBoundary: false,
  });
  const { mutateAsync: upload } = useUploadSource(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const add = async (list: FileList | readonly File[] | null) => {
    if (!list?.length || !policy) return;
    const picked = [...list];
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
    // The batch's notification counts the files that upload.
    const batchId = crypto.randomUUID();
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
                  maxBytes: policy.maxBytes,
                },
                () => undefined,
                new AbortController().signal
              )
            ).file
          : file;
        await upload({
          ...of,
          batchId,
          batchTotal: accepted.length,
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
