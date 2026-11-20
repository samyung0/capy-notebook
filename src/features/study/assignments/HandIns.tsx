import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  paperFileLinksQuery,
  type SubmissionOf,
  usePaperFileLinks,
  useRemoveHandInFile,
} from '@/api/hooks';
import type {
  Assignment,
  AssignmentMemberRow,
  PaperFile,
  SourceFile,
} from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { Menu } from '@/components/ui/Menu';
import { userToast } from '@/components/ui/userToast';
import { formatFileSize } from '@/features/files/fileUtils';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { fileIconName } from '@/lib/fileIcons';
import { Td, Th } from '../practice/studyPage';
import { dayLabel } from './assignmentText';
import { LateBadge } from './LateBadge';
import { PaperPages } from './LazyPaper';
import type { SubmissionFiles } from './useAddSubmissionFiles';

// Hand-ins (Epo 2026-11-08, mocks S3 and T2): an unmarked assignment that
// takes files. The member adds their work and hands it in; staff read it on
// the Members tab and the Grading tab, where, when it is graded on points (Epo
// 2026-11-14), they grade it beside the file (Epo 2026-11-19); the Members tab
// shows grades read only, as a graded quiz's Responses.

export const iconOf = (file: PaperFile) =>
  fileIconName(file as Pick<SourceFile, 'kind' | 'name'>);

/** Opens one stored file in a new tab: what pages cannot show (a document). */
function OpenFile({
  assignmentId,
  file,
}: {
  assignmentId: string;
  file: PaperFile;
}) {
  const { data: links } = usePaperFileLinks(
    { handInId: assignmentId },
    file.id
  );
  if (!links?.url) return null;
  return (
    <Button asChild iconRight="navigationForward" variant="outline">
      <a href={links.url} rel="noreferrer" target="_blank">
        {m.assignment_open_file()}
      </a>
    </Button>
  );
}

/** A hand-in's files, page by page, with Open file for a single one. */
function HandInViewer({
  assignmentId,
  files,
  onClose,
  title,
}: {
  assignmentId: string;
  files: readonly PaperFile[];
  onClose: () => void;
  title: string;
}) {
  const of = { handInId: assignmentId };
  return (
    <SimpleDialog
      footer={
        files.length === 1 && (
          <OpenFile assignmentId={assignmentId} file={files[0]!} />
        )
      }
      onClose={onClose}
      open
      title={title}
      width={720}
    >
      <PaperPages
        className="grid-cols-1 sm:grid-cols-2"
        files={files}
        of={of}
        width={320}
      />
    </SimpleDialog>
  );
}

/** S3's Your work: Add files at the section's top right while it is open, each
 * file's ⋮ with Open and Remove; once handed in, the files alone. The page
 * holds `uploads` (useAddSubmissionFiles), so Hand in waits for them. */
export function YourWork({
  assignment,
  open,
  uploads,
}: {
  assignment: Assignment;
  /** Takes changes: not handed in, not closed. */
  open: boolean;
  uploads: SubmissionFiles;
}) {
  const files = assignment.mine?.handIn ?? [];
  const { add, ready, uploading } = uploads;
  const { mutate: remove, isPending: removing } = useRemoveHandInFile(
    assignment.id
  );
  const [viewing, setViewing] = useState<PaperFile | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  return (
    <section className="mt-6.5 max-w-183">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 className="t-subtitle">{m.assignment_your_work()}</h2>
        {open && (
          <>
            <Button
              disabled={!ready}
              iconLeft="plus"
              onClick={() => picker.current?.click()}
              size="sm"
              variant="outline"
            >
              {m.assignment_paper_add()}
            </Button>
            <input
              className="hidden"
              multiple
              onChange={(e) => {
                void add(e.target.files);
                e.target.value = '';
              }}
              ref={picker}
              type="file"
            />
          </>
        )}
      </div>
      {files.length === 0 && uploading.length === 0 && open && (
        <p className="mt-2 text-fg-muted">{m.assignment_hand_in_empty()}</p>
      )}
      <SubmissionFileList
        className="mt-2"
        files={files}
        meta={(file) => formatFileSize(file.sizeBytes)}
        onOpen={setViewing}
        onRemove={open ? (file) => remove(file.id) : undefined}
        removing={removing}
        uploading={uploading}
      />
      {viewing && (
        <HandInViewer
          assignmentId={assignment.id}
          files={[viewing]}
          onClose={() => setViewing(null)}
          title={viewing.name}
        />
      )}
    </section>
  );
}

/** A submission's files, each with its ⋮ to open it and, while it takes
 * changes, remove it; then the files still uploading. Your work's and Your
 * answers' list (Epo 2026-11-19); a file quiz's results list them with an
 * Open button on each and no lines between (`results`, mock
 * QEetGvcmf2vvkVfqcYAKLz; Epo 2026-11-20 "remove all dividers"). */
export function SubmissionFileList({
  className,
  files,
  meta,
  onOpen,
  onRemove,
  removing,
  results = false,
  uploading,
}: {
  className?: string;
  files: readonly PaperFile[];
  meta: (file: PaperFile) => string;
  onOpen: (file: PaperFile) => void;
  results?: boolean;
  /** Absent once it takes no changes. */
  onRemove?: (file: PaperFile) => void;
  removing: boolean;
  uploading: readonly string[];
}) {
  return (
    <ul className={className}>
      {files.map((file) => (
        <li
          className={cn(
            'flex min-h-10 items-center gap-2',
            !results && 'border-divider border-b'
          )}
          key={file.id}
        >
          <FileIcon className="size-4 shrink-0" name={iconOf(file)} />
          {results ? (
            <span className="min-w-0 flex-1 truncate font-semibold">
              {file.name}
            </span>
          ) : (
            <button
              className="min-w-0 flex-1 truncate text-left font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action"
              onClick={() => onOpen(file)}
              type="button"
            >
              {file.name}
            </button>
          )}
          <span className="t-meta shrink-0 text-fg-muted">{meta(file)}</span>
          {results && (
            <Button
              aria-label={m.assignment_open_named({ name: file.name })}
              onClick={() => onOpen(file)}
              size="sm"
              variant="outline"
            >
              {m.assignment_open()}
            </Button>
          )}
          {onRemove && (
            <Menu
              items={[
                {
                  icon: 'navigationForward',
                  label: m.assignment_open(),
                  onClick: () => onOpen(file),
                },
                {
                  danger: true,
                  disabled: removing,
                  icon: 'trash',
                  label: m.assignment_hand_in_remove(),
                  onClick: () => onRemove(file),
                },
              ]}
            />
          )}
        </li>
      ))}
      {uploading.map((name) => (
        <li
          className="t-meta flex min-h-10 items-center border-divider border-b text-fg-secondary"
          key={name}
        >
          {m.assignment_paper_uploading({ name })}
        </li>
      ))}
    </ul>
  );
}

/** Several photos read as one "3 photos"; else each file by name. */
const allPhotos = (files: readonly PaperFile[]) =>
  files.length > 1 && files.every((file) => file.kind === 'image');

/** What a member handed in, in one line: a file's name, "2 files", "3 photos". */
export const workSummary = (files: readonly PaperFile[]) =>
  files.length === 1
    ? files[0]!.name
    : allPhotos(files)
      ? m.assignment_photos({ count: files.length })
      : m.assignment_paper_files({ count: files.length });

/** A grade as given, read only: "14.5 / 20". */
export function GradeText({
  member,
  points,
}: {
  member: AssignmentMemberRow;
  points: number;
}) {
  if (member.correct === undefined) return null;
  return (
    <span className="whitespace-nowrap font-bold">
      {formatPoints(member.correct)}{' '}
      <span className="font-semibold text-fg-muted">
        / {formatPoints(points)}
      </span>
    </span>
  );
}

/** A member's avatar and name; `sub`, a muted second line under the name,
 * the avatar centred on both. */
export function MemberCell({
  member,
  sub,
}: {
  member: AssignmentMemberRow;
  sub?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar
        aria-hidden
        className="size-6.5 shrink-0 text-[10px]"
        name={member.name}
        src={member.avatarUrl || undefined}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-semibold">{member.name}</span>
        {sub && (
          <span className="t-meta mt-0.5 truncate text-fg-muted">{sub}</span>
        )}
      </span>
    </span>
  );
}

/** T2: who handed in what. A row opens the Grading tab at that member (Epo
 * 2026-11-19), as a graded quiz's opens their attempt; a graded one's Grade
 * column shows each grade, read only. No Member header: the section's
 * Members title says it. */
export function HandInMembers({
  assignment,
  members,
  onOpen,
}: {
  assignment: Assignment;
  members: AssignmentMemberRow[];
  onOpen: (member: AssignmentMemberRow) => void;
}) {
  const { points } = assignment;
  // Read only, as a graded quiz's Responses: grading is the Grading tab's.
  const grade = (member: AssignmentMemberRow) =>
    points !== undefined && <GradeText member={member} points={points} />;
  const handedIn = (member: AssignmentMemberRow) =>
    member.submittedAt ? (
      <span className="flex items-center gap-2">
        {dayLabel(member.submittedAt)}
        {member.late && <LateBadge penaltyPct={member.latePenaltyPct} />}
      </span>
    ) : (
      m.assignment_not_handed_in()
    );
  // A file's own button takes its clicks; the rest of the row opens.
  const openRow = (event: React.MouseEvent, member: AssignmentMemberRow) => {
    if ((event.target as Element).closest('input, button, a')) return;
    onOpen(member);
  };
  return (
    <>
      <table className="mt-2 hidden w-full table-fixed border-separate border-spacing-0 md:table">
        <thead>
          <tr>
            <Th className="w-[34%]">
              <span className="sr-only">{m.assignment_col_member()}</span>
            </Th>
            <Th className="w-45">{m.assignment_col_handed_in()}</Th>
            <Th>{m.assignment_col_work()}</Th>
            {points !== undefined && (
              <Th className="w-36">{m.assignment_col_grade()}</Th>
            )}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr
              className="cursor-pointer hover:bg-surface-hover-bg"
              key={member.userId}
              onClick={(event) => openRow(event, member)}
            >
              <Td>
                {/* The row's button for the keyboard; a click anywhere opens. */}
                <button
                  className="flex min-w-0 max-w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-action"
                  onClick={() => onOpen(member)}
                  type="button"
                >
                  <MemberCell member={member} />
                </button>
              </Td>
              <Td muted={!member.submittedAt}>{handedIn(member)}</Td>
              <Td className="whitespace-normal" muted={!member.files?.length}>
                {member.files?.length ? (
                  <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                    {member.files.map((file) => (
                      <SubmissionFileLink
                        file={file}
                        key={file.id}
                        of={{ handInId: assignment.id }}
                      />
                    ))}
                  </span>
                ) : (
                  '–'
                )}
              </Td>
              {points !== undefined && <Td>{grade(member)}</Td>}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-1 md:hidden">
        {members.map((member) => {
          const files = member.files ?? [];
          return (
            <li
              className="flex items-center gap-3 border-divider border-b"
              key={member.userId}
            >
              <button
                className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
                onClick={() => onOpen(member)}
                type="button"
              >
                <div className="min-w-0 flex-1">
                  <MemberCell member={member} />
                  <div className="t-meta mt-0.5 truncate pl-9 text-fg-muted">
                    {member.submittedAt
                      ? [
                          dayLabel(member.submittedAt),
                          files.length > 0 && workSummary(files),
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : m.assignment_not_handed_in()}
                  </div>
                </div>
                {member.late && (
                  <LateBadge penaltyPct={member.latePenaltyPct} />
                )}
                <span className="shrink-0">{grade(member)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Opens a hand-in's or paper's file on its signed link (Epo 2026-11-19): a
 * PDF or photo in a new tab for the browser to show, opened on the click
 * itself so no popup blocker stops it; anything else downloads through a
 * hidden frame, so the page neither leaves nor asks to. */
export function useOpenSubmissionFile(of: SubmissionOf) {
  const qc = useQueryClient();
  const busy = useRef(false);
  return async (file: PaperFile) => {
    if (busy.current) return;
    busy.current = true;
    const shown = file.kind === 'pdf' || file.kind === 'image';
    const tab = shown ? window.open('', '_blank') : null;
    try {
      if (shown && !tab) {
        userToast({
          title: m.assignment_file_popup_blocked(),
          variant: 'error',
        });
        return;
      }
      const { url } = await qc.fetchQuery({
        ...paperFileLinksQuery(of, file.id),
        retry: false,
      });
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
        return;
      }
      const frame = document.createElement('iframe');
      frame.hidden = true;
      frame.src = url;
      document.body.append(frame);
      setTimeout(() => frame.remove(), 60_000);
    } catch (error) {
      tab?.close();
      userToast({
        title: errorCopy(error, m.assignment_file_open_failed()),
        variant: 'error',
      });
    } finally {
      busy.current = false;
    }
  };
}

/** A hand-in's or paper's file by name, underlined (Epo 2026-11-19), opening
 * on its signed link (`useOpenSubmissionFile`). */
export function SubmissionFileLink({
  className,
  file,
  of,
}: {
  className?: string;
  file: PaperFile;
  of: SubmissionOf;
}) {
  const open = useOpenSubmissionFile(of);
  return (
    <button
      className={cn(
        'inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-left font-semibold underline decoration-[1.5px] underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-action',
        className
      )}
      onClick={() => void open(file)}
      type="button"
    >
      <FileIcon className="size-4 shrink-0" name={iconOf(file)} />
      <span className="truncate">{file.name}</span>
    </button>
  );
}
