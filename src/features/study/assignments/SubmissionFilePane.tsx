import { useQuery } from '@tanstack/react-query';
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react';
import { type SubmissionOf, usePaperFileLinks } from '@/api/hooks';
import type { PaperFile } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { FileError } from '@/features/files/FileStates';
import { UnsupportedPreview } from '@/features/files/FileViewer';
import { FileHeaderTarget } from '@/features/files/fileModeContext';
import { officeFormatOf } from '@/features/files/fileUtils';
import { photoPagePdf } from '@/features/files/pagesPdf';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { CHIP } from './AssignmentHead';
import { PreviewDialog } from './AssignmentPreview';
import { iconOf, useOpenSubmissionFile } from './HandIns';

const PdfView = lazy(() => import('@/features/files/PdfView'));
const WordCopy = lazy(() => import('./WordCopy'));

/** A submission's file as the workspace shows it: a header with its name,
 * the viewer's page count and zoom, and open in a new tab, then the PDF, the
 * photo, or what can't be shown with its download. Grading's file side, and
 * the dialog a file opens in elsewhere (`SubmissionFileDialog`). A PDF or a
 * photo has staff's marks (Epo 2026-11-25): their tools for staff on a graded
 * one, read only for its member once the grade shows, as the server says. A
 * photo is drawn as a page its own size (T2); a Word file is marked on its
 * PDF copy (C1), which staff who mark it make on first open, and which its
 * member sees once it shows Feedback given. */
export function SubmissionFilePane({
  className,
  end,
  file,
  marking = false,
  of,
}: {
  className?: string;
  /** After open in new tab: full screen's exit. */
  end?: ReactNode;
  file: PaperFile;
  /** Staff who mark it: a graded assignment's. */
  marking?: boolean;
  of: SubmissionOf;
}) {
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const { data: links, isError, refetch } = usePaperFileLinks(of, file.id);
  const openFile = useOpenSubmissionFile(of);
  const image = file.kind === 'image';
  const word = officeFormatOf(file) === 'docx';
  const page = usePhotoPage(file, image ? links?.url : undefined);
  // A copy shows to staff who mark it, and to its member with their marks.
  const copy = word && (marking || file.marked) ? links?.previewUrl : undefined;
  const pdfUrl = image ? page.url : word ? copy : links?.url;
  return (
    <div className={cn('flex flex-col', className)}>
      {/* The workspace file header's row. */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-divider border-b pr-2 pl-4 sm:gap-2">
        <FileIcon
          className="size-4.5 shrink-0 -translate-y-px md:size-5"
          name={iconOf(file)}
        />
        <h2 className="t-subtitle min-w-0 flex-1 truncate">{file.name}</h2>
        {copy && (
          <span className={cn(CHIP, 'whitespace-nowrap')}>
            {m.assignment_copy_marked()}
          </span>
        )}
        {/* One run of buttons, no gaps, as the workspace header's right side;
            the viewer's page count and zoom portal into the first part. */}
        <div className="flex items-center gap-0">
          <div className="contents" ref={setHeader} />
          {/* The signed link, fetched fresh: the browser shows a PDF or photo
              and downloads the rest (Epo 2026-11-19); a marked copy's names
              the original it stands for (C1). */}
          {copy ? (
            <>
              {/* A phone keeps the file's name: the icon alone there. */}
              <Button
                className="max-sm:hidden"
                onClick={() => void openFile(file)}
                size="sm"
                type="button"
                variant="outline"
              >
                {m.assignment_open_original()}
                <Icon name="externalLink" />
              </Button>
              <ToolbarButton
                className="sm:hidden"
                label={m.assignment_open_original()}
                onClick={() => void openFile(file)}
              >
                <Icon name="externalLink" />
              </ToolbarButton>
            </>
          ) : (
            <ToolbarButton
              label={m.media_open_new_tab()}
              onClick={() => void openFile(file)}
            >
              <Icon name="externalLink" />
            </ToolbarButton>
          )}
          {end}
        </div>
      </div>
      {/* The workspace's own box for its viewers (CenterContent). */}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {isError || page.isError ? (
          <FileError
            onRetry={() => void (page.isError ? page.refetch() : refetch())}
          />
        ) : links ? (
          word && !copy && marking ? (
            <Suspense
              fallback={
                <SkeletonList className="p-4" count={3} rowHeight={40} />
              }
            >
              <WordCopy file={file} of={of} url={links.url} />
            </Suspense>
          ) : image || file.kind === 'pdf' || copy ? (
            pdfUrl ? (
              <FileHeaderTarget.Provider value={header}>
                <Suspense
                  fallback={
                    <SkeletonList className="p-4" count={3} rowHeight={40} />
                  }
                >
                  {/* Staff mark it with the Files page's PDF tools (Epo
                  2026-11-25, mock B6H1Z7o4byVFBVyCRSUK3B T1); the server
                  says whether they may (Graded off reads only, T3). Its
                  member gets the marks layer only once there are marks to
                  read (Feedback given): no empty Marks bar before. */}
                  <PdfView
                    annotationFile={marking || file.marked ? file : undefined}
                    onRetry={() => void refetch()}
                    url={pdfUrl}
                  />
                </Suspense>
              </FileHeaderTarget.Provider>
            ) : (
              // A photo's page still being drawn.
              <SkeletonList className="p-4" count={3} rowHeight={40} />
            )
          ) : (
            <UnsupportedPreview
              // Its link is signed to download.
              download={() => void openFile(file)}
              file={{ id: file.id, name: file.name, workspaceId: '' }}
            />
          )
        ) : (
          <SkeletonList className="p-4" count={3} rowHeight={40} />
        )}
      </div>
    </div>
  );
}

/** A photo's one-page PDF (`photoPagePdf`) at a `blob:` URL while shown;
 * none until `url` is the photo's link. */
function usePhotoPage(file: PaperFile, url: string | undefined) {
  const { data, isError, refetch } = useQuery({
    enabled: !!url,
    queryFn: async () => {
      const response = await fetch(url as string);
      if (!response.ok) throw new Error(`Photo ${response.status}`);
      return photoPagePdf(await response.blob());
    },
    // One revision's bytes never change; its link does, hourly.
    queryKey: ['file', file.id, 'photo-page', file.revision],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [pageUrl, setPageUrl] = useState<string>();
  useEffect(() => {
    if (!data) return;
    const next = URL.createObjectURL(data);
    setPageUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setPageUrl(undefined);
    };
  }, [data]);
  return { isError, refetch, url: pageUrl };
}

/** One submission file over the page, in Preview's dialog: a member opening
 * their own work, staff opening a graded quiz's upload. */
export function SubmissionFileDialog({
  file,
  marking,
  of,
  onClose,
}: {
  file: PaperFile;
  marking?: boolean;
  of: SubmissionOf;
  onClose: () => void;
}) {
  return (
    <PreviewDialog onClose={onClose} title={file.name}>
      <SubmissionFilePane
        className="min-h-0 flex-1"
        file={file}
        marking={marking}
        of={of}
      />
    </PreviewDialog>
  );
}
