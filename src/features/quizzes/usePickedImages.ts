import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { uploadEditorAsset } from '@/api/editorAssets';
import type { Question } from '@/api/types';
import { questionAssetIds, replaceAssetIds } from '@/features/questions/types';
import { fitQuizImage } from './quizImage';

/** Images picked in a question dialog stay in this browser until the quiz
 * saves, so an abandoned pick never reaches storage. `pick` hands the dialog
 * a local id, `previewUrl` shows it until upload, and `uploadPicked` uploads
 * the picks the questions still use and swaps in their asset ids. */
export function usePickedImages(
  quizId: string,
  /** Called with what did upload before a partial failure is thrown, so a
   * retried save sends only the rest. */
  onUploaded: (questions: Question[]) => void
) {
  const picked = useRef(new Map<string, File>());
  const previews = useRef(new Map<string, string>());
  useEffect(() => {
    const urls = previews.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, []);
  const { isPending, mutateAsync: uploadPicked } = useMutation({
    mutationFn: async (current: Question[]) => {
      const uploaded = new Map<string, string>();
      const ids = new Set(current.flatMap(questionAssetIds));
      const results = await Promise.allSettled(
        [...picked.current].flatMap(([id, file]) =>
          ids.has(id)
            ? [
                uploadEditorAsset(quizId, file, 'image').then(({ assetId }) => {
                  uploaded.set(id, assetId);
                  picked.current.delete(id);
                  const url = previews.current.get(id);
                  if (url) previews.current.set(assetId, url);
                }),
              ]
            : []
        )
      );
      const next = current.map((question) =>
        replaceAssetIds(question, uploaded)
      );
      onUploaded(next);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      return next;
    },
  });
  async function pick(file: File) {
    const fitted = await fitQuizImage(file);
    const assetId = crypto.randomUUID();
    picked.current.set(assetId, fitted);
    previews.current.set(assetId, URL.createObjectURL(fitted));
    return { assetId };
  }
  return {
    isPending,
    pick,
    previewUrl: (assetId: string) => previews.current.get(assetId),
    uploadPicked,
  };
}
