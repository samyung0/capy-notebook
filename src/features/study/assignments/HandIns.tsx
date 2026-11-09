import { useRef, useState } from 'react';
import { usePaperFileLinks, useRemoveHandInFile } from '@/api/hooks';
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
import { formatFileSize } from '@/features/files/fileUtils';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import { Td, Th } from '../practice/studyPage';
import { dayLabel } from './assignmentText';
import { LateBadge } from './LateBadge';
import { PaperPages } from './LazyPaper';
import type { SubmissionFiles } from './useAddSubmissionFiles';

// Hand-ins (Epo 2026-11-08, mocks S3 and T2): an unmarked assignment that
// takes files. The member adds their work and hands it in; staff read it on
// the Members tab. Nothing marks it.

const iconOf = (file: PaperFile) =>
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
      <ul className="mt-2">
        {files.map((file) => (
          <li
            className="flex min-h-10 items-center gap-2 border-divider border-b"
            key={file.id}
          >
            <FileIcon className="size-4 shrink-0" name={iconOf(file)} />
            <button
              className="min-w-0 flex-1 truncate text-left font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action"
              onClick={() => setViewing(file)}
              type="button"
            >
              {file.name}
            </button>
            <span className="t-meta shrink-0 text-fg-muted">
              {formatFileSize(file.sizeBytes)}
            </span>
            {open && (
              <Menu
                items={[
                  {
                    icon: 'navigationForward',
                    label: m.assignment_open(),
                    onClick: () => setViewing(file),
                  },
                  {
                    danger: true,
                    disabled: removing,
                    icon: 'trash',
                    label: m.assignment_hand_in_remove(),
                    onClick: () => remove(file.id),
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

/** Several photos read as one "3 photos"; else each file by name. */
const allPhotos = (files: readonly PaperFile[]) =>
  files.length > 1 && files.every((file) => file.kind === 'image');

/** What a member handed in, in one line: a file's name, "2 files", "3 photos". */
const workSummary = (files: readonly PaperFile[]) =>
  files.length === 1
    ? files[0]!.name
    : allPhotos(files)
      ? m.assignment_photos({ count: files.length })
      : m.assignment_paper_files({ count: files.length });

function MemberCell({ member }: { member: AssignmentMemberRow }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar
        aria-hidden
        className="size-6.5 shrink-0 text-[10px]"
        name={member.name}
        src={member.avatarUrl || undefined}
      />
      <span className="truncate font-semibold">{member.name}</span>
    </span>
  );
}

/** T2: who handed in what. A file opens in the viewer; no mark column. */
export function HandInMembers({
  assignmentId,
  members,
}: {
  assignmentId: string;
  members: AssignmentMemberRow[];
}) {
  const [viewing, setViewing] = useState<{
    files: readonly PaperFile[];
    title: string;
  } | null>(null);
  const fileButton = (
    member: AssignmentMemberRow,
    files: readonly PaperFile[],
    label: string,
    icon: PaperFile
  ) => (
    <button
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-action"
      key={files.map((file) => file.id).join()}
      onClick={() =>
        setViewing({
          files,
          title: files.length === 1 ? files[0]!.name : member.name,
        })
      }
      type="button"
    >
      <FileIcon className="size-4 shrink-0" name={iconOf(icon)} />
      <span className="truncate">{label}</span>
    </button>
  );
  const work = (member: AssignmentMemberRow) => {
    const files = member.files ?? [];
    if (files.length === 0) return null;
    if (allPhotos(files))
      return fileButton(member, files, workSummary(files), files[0]!);
    return files.map((file) => fileButton(member, [file], file.name, file));
  };
  return (
    <>
      <table className="mt-2 hidden w-full table-fixed border-separate border-spacing-0 md:table">
        <thead>
          <tr>
            <Th className="w-[34%]">{m.assignment_col_member()}</Th>
            <Th className="w-45">{m.assignment_col_handed_in()}</Th>
            <Th>{m.assignment_col_work()}</Th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <Td>
                <MemberCell member={member} />
              </Td>
              <Td muted={!member.submittedAt}>
                {member.submittedAt ? (
                  <span className="flex items-center gap-2">
                    {dayLabel(member.submittedAt)}
                    {member.late && <LateBadge penaltyPct={0} />}
                  </span>
                ) : (
                  m.assignment_not_handed_in()
                )}
              </Td>
              <Td className="whitespace-normal">
                <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                  {work(member)}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-1 md:hidden">
        {members.map((member) => {
          const files = member.files ?? [];
          const handedIn = !!member.submittedAt && files.length > 0;
          return (
            <li className="border-divider border-b" key={member.userId}>
              <button
                className={cn(
                  'flex min-h-14 w-full items-center gap-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset',
                  !handedIn && 'cursor-default'
                )}
                disabled={!handedIn}
                onClick={() =>
                  setViewing({
                    files,
                    title: files.length === 1 ? files[0]!.name : member.name,
                  })
                }
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
                {member.late && <LateBadge penaltyPct={0} />}
              </button>
            </li>
          );
        })}
      </ul>
      {viewing && (
        <HandInViewer
          assignmentId={assignmentId}
          files={viewing.files}
          onClose={() => setViewing(null)}
          title={viewing.title}
        />
      )}
    </>
  );
}
