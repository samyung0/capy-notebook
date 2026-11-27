import { useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useRef } from 'react';
import { useFile, useFileLinks } from '@/api/hooks';
import { Skeleton } from '@/components/ui/feedback';
import { useNearScreen } from '@/features/collaboration/useNearScreen';
import { CannotShow } from '@/features/materials/CannotShow';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

const FilmView = lazy(() => import('./FilmView'));

const loading = <Skeleton className="aspect-video w-full rounded-none" />;

/** A film shown in place, view-only: a note's film block, a canvas card (Epo
 * 2026-11-27). A live link to its file, read with the reader's own access: a
 * film they cannot open, or one in the Trash, says it can't be shown, and its
 * restore brings it back. The player and its file load only while it is on
 * screen. */
export function FilmEmbed({
  contain = false,
  fileId,
}: {
  /** Fit inside the container's box (a canvas card), not its width. */
  contain?: boolean;
  fileId: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // Only on screen: each drawn film's player holds hundreds of MB, and the
  // engine's heap keeps its high-water mark (bench/manim/reports/
  // 2026-11-27-note-films-memory.md). Scrolling back resumes where it was.
  const { near } = useNearScreen(box, { lingerMs: 3000, margin: '0px' });
  const {
    data: file,
    isError: unreadable,
    isPending: reading,
  } = useFile(near ? fileId : null, { errorBoundary: false });
  const readable = !!file && !file.trash && file.kind === 'film';
  const {
    data: links,
    isError: linkFailed,
    refetch,
  } = useFileLinks(readable ? fileId : '', { errorBoundary: false });
  const gone = unreadable || linkFailed || (!!file && !readable);
  return (
    <div
      className={cn(contain && 'size-full')}
      contentEditable={false}
      ref={box}
    >
      {gone ? (
        <CannotShow label={m.film_cannot_show()} />
      ) : near && !reading && links ? (
        <Suspense fallback={loading}>
          <FilmView
            contain={contain}
            embedded
            key={links.url}
            name={file?.name ?? ''}
            onRetry={() => void refetch()}
            url={links.url}
          />
        </Suspense>
      ) : (
        loading
      )}
    </div>
  );
}

/** Open for a placed film: its file in the file viewer, in its workspace or on
 * its own page. Undefined while the file reads, or when it can't be opened. */
export function useOpenFilm(fileId: string) {
  const navigate = useNavigate();
  const { data: file } = useFile(fileId, { errorBoundary: false });
  if (!file || file.trash || file.lostAccess) return;
  return () =>
    void (file.workspaceId
      ? navigate({
          params: { workspaceId: file.workspaceId },
          search: { file: file.id },
          to: '/workspaces/$workspaceId',
        })
      : navigate({ params: { fileId: file.id }, to: '/files/$fileId' }));
}
