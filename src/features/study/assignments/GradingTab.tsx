import { lazy, Suspense, useState } from 'react';
import { usePaperFileLinks } from '@/api/hooks';
import type { Assignment, AssignmentMemberRow, PaperFile } from '@/api/types';
import { Accordion } from '@/components/ui/Accordion';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { FileError } from '@/features/files/FileStates';
import { UnsupportedPreview } from '@/features/files/FileViewer';
import { FileHeaderTarget } from '@/features/files/fileModeContext';
import {
  clampImageZoom,
  formatFileSize,
  IMAGE_MAX_ZOOM,
  IMAGE_MIN_ZOOM,
  IMAGE_ZOOM_STEP,
} from '@/features/files/fileUtils';
import { ImageViewer } from '@/features/files/ImageViewer';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/useMediaQuery';
import type { AssignmentsSearch } from '../studyRoutes';
import { BackToAssignments } from './AssignmentAttemptPage';
import { dayLabel } from './assignmentText';
import { GradeField } from './GradeField';
import {
  GradeText,
  iconOf,
  MemberCell,
  useOpenSubmissionFile,
  workSummary,
} from './HandIns';
import { LateBadge } from './LateBadge';

const PdfView = lazy(() => import('@/features/files/PdfView'));

/** An Assignment's Grading tab (Epo 2026-11-19, mock A, after Google
 * Classroom's grading tool): the members on the left in the app's accordion,
 * the open one showing when they handed in, their files and their grade, and
 * the chosen file on the right in the workspace's own viewers (PDF, photo),
 * its page count and zoom in its header as there. `member` and `work` in the
 * URL name them; with none the first who handed in shows. On a phone it
 * drills down: the list, then a member's file with their details under it.
 * One without uploads has no file side; one without points only reads. */
export function GradingTab({
  assignment,
  go,
  loading,
  members,
  onExitFullscreen,
  search,
}: {
  assignment: Assignment;
  go: (next: AssignmentsSearch) => void;
  loading: boolean;
  members: AssignmentMemberRow[];
  onExitFullscreen: () => void;
  search: AssignmentsSearch;
}) {
  const wide = useMediaQuery('(min-width: 768px)');
  // Full screen (the tabs row's button, Epo 2026-11-19): the members and the
  // file over the whole window, as the workspace's open file; its exit ends
  // the file's header, or the count's row with no files.
  const fullscreen = wide && !!search.fullscreen;
  const exit = fullscreen && (
    <ToolbarButton
      label={m.material_fullscreen_exit()}
      onClick={onExitFullscreen}
    >
      <Icon name="minimize" />
    </ToolbarButton>
  );
  const files = assignment.allowUploads;
  // The member whose row was folded by hand (they stay the one shown); by
  // id, so Back to another member opens theirs.
  const [folded, setFolded] = useState<string | null>(null);
  const chosen = members.find((row) => row.userId === search.member);
  const shown =
    chosen ??
    (wide ? (members.find((row) => row.files?.length) ?? members[0]) : null);
  const file =
    shown?.files?.find((f) => f.id === search.work) ?? shown?.files?.[0];
  const open = (row: AssignmentMemberRow, fileId?: string) =>
    go({
      fullscreen: search.fullscreen,
      member: row.userId,
      tab: 'grading',
      work: fileId,
    });
  const toggle = (row: AssignmentMemberRow) => {
    if (row === shown)
      return setFolded(folded === row.userId ? null : row.userId);
    setFolded(null);
    open(row);
  };

  if (loading)
    return <SkeletonList className="mt-4" count={6} rowHeight={48} />;
  if (members.length === 0)
    return (
      <p className="tab-body-mt text-fg-muted">{m.common_nothing_yet()}</p>
    );

  // The right side: the chosen file, or that there is none.
  const pane = (row: AssignmentMemberRow, className: string) =>
    file ? (
      <FilePane
        assignmentId={assignment.id}
        className={className}
        end={exit}
        file={file}
        key={file.id}
      />
    ) : (
      <div className={cn('flex flex-col', className)}>
        {/* Full screen's exit where the file header holds it. */}
        {exit && (
          <div className="flex h-12 shrink-0 items-center justify-end pr-2">
            {exit}
          </div>
        )}
        <div className="grid flex-1 place-items-center p-6">
          <p className="text-center text-fg-muted">
            {m.assignment_nothing_handed_in({ name: row.name })}
          </p>
        </div>
      </div>
    );
  const details = (row: AssignmentMemberRow) => (
    <Details
      assignment={assignment}
      file={file}
      member={row}
      onFile={(id) => open(row, id)}
    />
  );

  // A phone: the list, or one member's file and details.
  if (!wide)
    return shown ? (
      <div className="tab-body-mt flex flex-col gap-4">
        <BackToAssignments
          label={
            assignment.points === undefined
              ? m.assignment_tab_hand_ins()
              : m.assignment_tab_grading()
          }
          link={{
            search: { assignment: assignment.id, tab: 'grading' },
            to: '.',
          }}
        />
        <MemberCell member={shown} />
        {files && pane(shown, 'page-bleed h-[70dvh] border-divider border-y')}
        {details(shown)}
      </div>
    ) : (
      <div className="tab-body-mt">
        <Count assignment={assignment} members={members} />
        <ul>
          {members.map((row) => (
            <li className="border-divider border-b" key={row.userId}>
              <button
                className="flex min-h-14 w-full items-center gap-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
                onClick={() => open(row)}
                type="button"
              >
                <RowLabel assignment={assignment} row={row} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <div
      className={cn(
        'grid',
        // Straight under the tabs' own line, or over everything.
        fullscreen
          ? 'fixed inset-0 z-40 bg-surface'
          : 'page-bleed min-h-0 flex-1',
        // A tablet keeps the file its room.
        files
          ? 'grid-cols-[300px_minmax(0,1fr)] lg:grid-cols-[360px_minmax(0,1fr)]'
          : 'grid-cols-1'
      )}
    >
      <div
        className={cn(
          // Down only: the accordion's panel reaches 4px past each side for
          // its focus rings. It scrolls with no scrollbar.
          'min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          files ? 'border-divider border-r' : 'max-w-183'
        )}
      >
        <Count assignment={assignment} end={!files && exit} members={members} />
        <ul>
          {members.map((row) => (
            <li className="border-divider border-b" key={row.userId}>
              <Accordion
                className="mx-0 min-h-14 w-full gap-2.5 rounded-none px-4 py-2 font-normal"
                label={<RowLabel assignment={assignment} row={row} />}
                onToggle={() => toggle(row)}
                open={row === shown && folded !== row.userId}
              >
                {/* Only the shown member's: a class's worth of grade forms
                  would weigh. */}
                {row === shown && (
                  <div className="px-4 pb-3 pl-10.5">{details(row)}</div>
                )}
              </Accordion>
            </li>
          ))}
        </ul>
      </div>
      {files && shown && pane(shown, 'min-h-0')}
    </div>
  );
}

/** "2 of 6 graded", or handed in when there are no points. */
function Count({
  assignment,
  end,
  members,
}: {
  assignment: Assignment;
  /** At the row's end: full screen's exit. */
  end?: React.ReactNode;
  members: AssignmentMemberRow[];
}) {
  const total = members.length;
  return (
    <div className="flex items-center justify-between gap-2 md:pr-2">
      <p className="t-meta pt-3 pb-1.5 font-semibold text-fg-muted md:px-4">
        {assignment.points === undefined
          ? m.assignment_handed_in_of({
              done: members.filter((row) => row.submittedAt).length,
              total,
            })
          : m.assignment_graded_of({
              done: members.filter((row) => row.correct !== undefined).length,
              total,
            })}
      </p>
      {end}
    </div>
  );
}

/** A member's row: who, when they handed in and what, late, and the grade or
 * To grade. */
function RowLabel({
  assignment,
  row,
}: {
  assignment: Assignment;
  row: AssignmentMemberRow;
}) {
  const { allowUploads, points } = assignment;
  const files = row.files ?? [];
  const summary = allowUploads
    ? row.submittedAt
      ? [dayLabel(row.submittedAt), files.length > 0 && workSummary(files)]
          .filter(Boolean)
          .join(' · ')
      : m.assignment_not_handed_in()
    : row.submittedAt
      ? m.assignment_done_on({ date: dayLabel(row.submittedAt) })
      : m.assignment_not_done();
  return (
    <>
      <span className="min-w-0 flex-1">
        <MemberCell member={row} sub={summary} />
      </span>
      {row.late && <LateBadge penaltyPct={row.latePenaltyPct} />}
      {points === undefined ? null : row.correct === undefined ? (
        (row.submittedAt || !allowUploads) && (
          <span className="t-meta whitespace-nowrap font-semibold text-fg-muted">
            {m.assignment_to_grade()}
          </span>
        )
      ) : (
        <GradeText member={row} points={points} />
      )}
    </>
  );
}

/** The open member's details: when they handed in, each file (the one shown
 * marked), and the grade with Save. */
function Details({
  assignment,
  file,
  member,
  onFile,
}: {
  assignment: Assignment;
  file?: PaperFile;
  member: AssignmentMemberRow;
  onFile: (fileId: string) => void;
}) {
  const { allowUploads, points } = assignment;
  const files = member.files ?? [];
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
      <dt className="text-fg-muted text-sm">{m.assignment_col_handed_in()}</dt>
      <dd className="flex min-h-7 flex-wrap items-center gap-2">
        {member.submittedAt ? (
          dayLabel(member.submittedAt)
        ) : (
          <span className="text-fg-muted">
            {allowUploads
              ? m.assignment_not_handed_in()
              : m.assignment_not_done()}
          </span>
        )}
      </dd>
      {allowUploads && (
        <>
          <dt className="self-start pt-1 text-fg-muted text-sm">
            {m.assignment_col_work()}
          </dt>
          <dd className="flex min-w-0 flex-col gap-0.5">
            {files.length === 0 && (
              <span className="min-h-7 text-fg-muted">–</span>
            )}
            {files.map((f) => (
              <button
                aria-current={f.id === file?.id || undefined}
                className={cn(
                  '-mx-2 flex min-h-7 min-w-0 items-center gap-2 rounded-button px-2 text-left outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action',
                  f.id === file?.id
                    ? 'bg-surface-hover-bg font-semibold'
                    : 'text-fg-secondary'
                )}
                key={f.id}
                onClick={() => onFile(f.id)}
                type="button"
              >
                <FileIcon className="size-4 shrink-0" name={iconOf(f)} />
                <span className="min-w-0 truncate">{f.name}</span>
                <span className="t-meta shrink-0 font-normal text-fg-muted">
                  {formatFileSize(f.sizeBytes)}
                </span>
              </button>
            ))}
          </dd>
        </>
      )}
      {points !== undefined && (
        <>
          <dt className="text-fg-muted text-sm">{m.assignment_col_grade()}</dt>
          <dd className="min-w-0">
            <GradeField
              assignment={{ ...assignment, points }}
              member={member}
            />
          </dd>
        </>
      )}
    </dl>
  );
}

/** The chosen file as the workspace shows it: a header with its name, the
 * viewer's page count and zoom, and open in a new tab, then the PDF, the
 * photo, or what can't be shown with its download. */
function FilePane({
  assignmentId,
  className,
  end,
  file,
}: {
  assignmentId: string;
  className?: string;
  /** After open in new tab: full screen's exit. */
  end?: React.ReactNode;
  file: PaperFile;
}) {
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [imageZoom, setImageZoom] = useState(IMAGE_MIN_ZOOM);
  const {
    data: links,
    isError,
    refetch,
  } = usePaperFileLinks({ handInId: assignmentId }, file.id);
  const openFile = useOpenSubmissionFile({ handInId: assignmentId });
  const image = file.kind === 'image';
  return (
    <div className={cn('flex flex-col', className)}>
      {/* The workspace file header's row. */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-divider border-b pr-2 pl-4 sm:gap-2">
        <FileIcon
          className="size-4.5 shrink-0 -translate-y-px md:size-5"
          name={iconOf(file)}
        />
        <h2 className="t-subtitle min-w-0 flex-1 truncate">{file.name}</h2>
        {/* One run of buttons, no gaps, as the workspace header's right side;
            the viewer's page count and zoom portal into the first part. */}
        <div className="flex items-center gap-0">
          <div className="contents" ref={setHeader}>
            {image && (
              <>
                <ToolbarButton
                  disabled={imageZoom <= IMAGE_MIN_ZOOM}
                  label={m.material_zoom_out()}
                  onClick={() =>
                    setImageZoom(clampImageZoom(imageZoom - IMAGE_ZOOM_STEP))
                  }
                >
                  <Icon name="zoomOut" />
                </ToolbarButton>
                <ToolbarButton
                  disabled={imageZoom >= IMAGE_MAX_ZOOM}
                  label={m.material_zoom_in()}
                  onClick={() =>
                    setImageZoom(clampImageZoom(imageZoom + IMAGE_ZOOM_STEP))
                  }
                >
                  <Icon name="zoomIn" />
                </ToolbarButton>
              </>
            )}
          </div>
          {/* The signed link, fetched fresh: the browser shows a PDF or photo
              and downloads the rest (Epo 2026-11-19). */}
          <ToolbarButton
            label={m.media_open_new_tab()}
            onClick={() => void openFile(file)}
          >
            <Icon name="externalLink" />
          </ToolbarButton>
          {end}
        </div>
      </div>
      {/* The workspace's own box for its viewers (CenterContent). */}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {isError ? (
          <FileError onRetry={() => void refetch()} />
        ) : links?.url ? (
          file.kind === 'pdf' ? (
            <FileHeaderTarget.Provider value={header}>
              <Suspense
                fallback={
                  <SkeletonList className="p-4" count={3} rowHeight={40} />
                }
              >
                <PdfView onRetry={() => void refetch()} url={links.url} />
              </Suspense>
            </FileHeaderTarget.Provider>
          ) : image ? (
            <ImageViewer
              alt={file.name}
              onRetry={() => void refetch()}
              onZoomChange={setImageZoom}
              url={links.url}
              zoom={imageZoom}
            />
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
