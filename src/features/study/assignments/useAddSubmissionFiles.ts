import { useState } from 'react';
import {
  type SubmissionOf,
  useSourceUploadPolicy,
  useUploadSource,
} from '@/api/hooks';
import { userToast } from '@/components/ui/userToast';
import { compressSource } from '@/features/workspace/sourceCompress';
import {
  getFileKind,
  sourceCompression,
} from '@/features/workspace/sourceUpload';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';

/** Adds picked files to a paper or a hand-in, each through the normal upload
 * with the attempt or assignment named, as one quiet batch. A photo or an
 * Office file's pictures are compressed first, as any upload's are
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
    const batchId = crypto.randomUUID();
    setUploading((prev) => [...prev, ...picked.map((f) => f.name)]);
    for (const file of picked) {
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
          batchTotal: picked.length,
          file: sent,
          kind,
        });
      } catch (error) {
        userToast({
          title: errorCopy(error, m.assignment_paper_upload_failed()),
          variant: 'error',
        });
      } finally {
        // One entry: two picks of the same name each hold Submit.
        setUploading((prev) => {
          const at = prev.indexOf(file.name);
          return at < 0 ? prev : [...prev.slice(0, at), ...prev.slice(at + 1)];
        });
      }
    }
  };
  return { add, ready: !!policy, uploading };
}

export type SubmissionFiles = ReturnType<typeof useAddSubmissionFiles>;
