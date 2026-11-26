import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  paperFileLinksQuery,
  type SubmissionOf,
  useRemoveHandInFile,
} from '@/api/hooks';
import type {
  Assignment,
  AssignmentMemberRow,
  FileKind,
  PaperFile,
  SourceFile,
} from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { IconButton } from '@/components/ui/IconButton';
import { userToast } from '@/components/ui/userToast';
import { formatPoints } from '@/features/quizzes/grade';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import { fileIconName } from '@/lib/fileIcons';
import { Td, Th } from '../practice/studyPage';
import { type FileCard, FileCards } from './AssignmentFiles';
import { dayLabel } from './assignmentText';
import { LateBadge } from './LateBadge';
import { SubmissionFileDialog } from './SubmissionFilePane';
import type { SubmissionFiles } from './useAddSubmissionFiles';

// Hand-ins (Epo 2026-11-08, mocks S3 and T2): an unmarked assignment that
// takes files. The member adds their work and hands it in; staff read it on
// the Members tab and the Grading tab, where, when it is graded on points (Epo
// 2026-11-14), they grade it beside the file (Epo 2026-11-19); the Members tab
// shows grades read only, as a graded quiz's Responses.

export const iconOf = (file: PaperFile) =>
  fileIconName(file as Pick<SourceFile, 'kind' | 'name'>);

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
    <FileCards
      action={
        open && (
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
                void add(e.target.files, files);
                e.target.value = '';
              }}
              ref={picker}
              type="file"
            />
          </>
        )
      }
      files={paperFileCards(
        files,
        setViewing,
        open ? { onRemove: (file) => remove(file.id), removing } : undefined
      )}
      title={m.assignment_your_work()}
    >
      {files.length === 0 && uploading.length === 0 && open && (
        <p className="mt-2 text-fg-muted">{m.assignment_hand_in_empty()}</p>
      )}
      <UploadingLines names={uploading} />
      {viewing && (
        <SubmissionFileDialog
          file={viewing}
          of={{ handInId: assignment.id }}
          onClose={() => setViewing(null)}
        />
      )}
    </FileCards>
  );
}

/** A submission's files as `FileCards` (Epo 2026-11-25, mock
 * NgtaKfyZp9yk2uh9Ysxhhi): each opens in place on a click, and while the work
 * takes changes has a trash button, no ⋮ (Epo 2026-11-26). They have no
 * thumbnails: they are stored with no ingest, so the card shows the file's
 * kind. */
export function paperFileCards(
  files: readonly PaperFile[],
  onOpen: (file: PaperFile) => void,
  removal?: { onRemove: (file: PaperFile) => void; removing: boolean }
): FileCard[] {
  return files.map((file) => ({
    icon: iconOf(file),
    key: file.id,
    name: file.name,
    // Staff marked it, shown once its member sees the grade (S1, Epo
    // 2026-11-25: no count, no names); its marks show only inside it.
    note: file.marked && (
      <span className="font-semibold text-tint-accent-1-fg">
        {m.assignment_feedback_given()}
      </span>
    ),
    onOpen: () => onOpen(file),
    remove: removal && {
      disabled: removal.removing,
      onRemove: () => removal.onRemove(file),
    },
    thumbnail: { fileKind: file.kind as FileKind },
  }));
}

/** Files still uploading, a line each, under the files. */
export function UploadingLines({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null;
  return (
    <ul className="mt-2">
      {names.map((name) => (
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
            !results && 'border-divider border-b hover:bg-surface-hover-bg'
          )}
          key={file.id}
        >
          {results ? (
            <>
              <FileIcon className="size-4 shrink-0" name={iconOf(file)} />
              <span className="min-w-0 flex-1 truncate font-semibold">
                {file.name}
              </span>
              <span className="t-meta shrink-0 text-fg-muted">
                {meta(file)}
              </span>
            </>
          ) : (
            // The whole row opens it, as the Files block's rows (Epo
            // 2026-11-26).
            <button
              className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
              onClick={() => onOpen(file)}
              type="button"
            >
              <FileIcon className="size-4 shrink-0" name={iconOf(file)} />
              <span className="min-w-0 flex-1 truncate font-semibold">
                {file.name}
              </span>
              <span className="t-meta shrink-0 text-fg-muted">
                {meta(file)}
              </span>
            </button>
          )}
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
            <IconButton
              disabled={removing}
              icon="trash"
              label={m.assignment_hand_in_remove()}
              onClick={() => onRemove(file)}
              size="md"
              tooltip
              variant="danger-light"
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

/** An Assignment taking no files' Responses (Epo 2026-11-21): who marked it
 * done and when, Late past the due date. One taking files has its Responses
 * or Grading tab instead (Epo 2026-11-25). */
export function DoneMembers({ members }: { members: AssignmentMemberRow[] }) {
  const done = (member: AssignmentMemberRow) =>
    member.submittedAt ? (
      <span className="flex items-center gap-2">
        {dayLabel(member.submittedAt)}
        {member.late && <LateBadge penaltyPct={member.latePenaltyPct} />}
      </span>
    ) : (
      m.assignment_not_done()
    );
  return (
    <>
      <table className="mt-2 hidden w-full table-fixed border-separate border-spacing-0 md:table">
        <thead>
          <tr>
            <Th className="w-[34%]">{m.assignment_col_member()}</Th>
            <Th>{m.assignment_done()}</Th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <Td>
                <MemberCell member={member} />
              </Td>
              <Td muted={!member.submittedAt}>{done(member)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-1 md:hidden">
        {members.map((member) => (
          <li
            className="flex min-h-14 items-center gap-3 border-divider border-b py-2"
            key={member.userId}
          >
            <div className="min-w-0 flex-1">
              <MemberCell member={member} />
              <div className="t-meta mt-0.5 truncate pl-9 text-fg-muted">
                {member.submittedAt
                  ? dayLabel(member.submittedAt)
                  : m.assignment_not_done()}
              </div>
            </div>
            {member.late && <LateBadge penaltyPct={member.latePenaltyPct} />}
          </li>
        ))}
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
