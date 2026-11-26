import { Link, type LinkProps } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { Assignment, FileKind } from '@/api/types';
import { ItemCard } from '@/components/app/ItemCard';
import { ListViewToggle, useListView } from '@/components/app/ListToolbar';
import type { Thumbnail } from '@/components/app/ThumbnailPanel';
import { FileIcon, type FileIconName } from '@/components/ui/FileIcon';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { PREF_KEYS } from '@/lib/localPrefs';
import { fileLink } from './assignmentPage';
import { assignmentFileIcon } from './todoParts';

/** One file in a `FileCards` block: a link, or `onOpen` for one opened in
 * place (a submission's viewer); `menu` puts a ⋮ on it. */
export interface FileCard {
  icon: FileIconName;
  key: string;
  link?: LinkProps;
  menu?: MenuItem[];
  name: string;
  /** The card's foot, the row's end: a submitted file's Feedback given. */
  note?: ReactNode;
  onOpen?: () => void;
  thumbnail?: Thumbnail;
}

/** A titled block of files (Epo 2026-11-19, as the Files page): rows that open
 * each, or the Files page's cards, with the same list and grid toggle. An
 * assignment's Files, its question paper and a member's own work all use it
 * (Epo 2026-11-25, mock NgtaKfyZp9yk2uh9Ysxhhi). `action` sits beside the
 * title; `children` follow the files (a hint, files still uploading). */
export function FileCards({
  action,
  children,
  files,
  title,
}: {
  action?: ReactNode;
  children?: ReactNode;
  files: FileCard[];
  title: string;
}) {
  const [view, setView] = useListView(PREF_KEYS.assignmentFilesView);
  return (
    <section className="mt-6.5">
      {/* -mr-1.5: the toggle's icon on the gutter, as in ListToolbar. */}
      <div
        className={cn(
          'flex min-h-8 items-center justify-between gap-3',
          files.length > 0 && '-mr-1.5'
        )}
      >
        <h2 className="t-subtitle">{title}</h2>
        <div className="flex items-center gap-2">
          {action}
          {files.length > 0 && (
            <ListViewToggle onViewChange={setView} view={view} />
          )}
        </div>
      </div>
      {files.length > 0 &&
        (view === 'grid' ? (
          // Smaller than the Files page's: two to a phone, 176px from sm.
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,176px)]">
            {files.map((file) => (
              <ItemCard
                actions={file.menu && <Menu items={file.menu} />}
                icon={file.icon}
                key={file.key}
                link={file.link}
                meta={file.note}
                onOpen={file.onOpen}
                thumbnail={file.thumbnail ?? {}}
                title={file.name}
                view="grid"
              />
            ))}
          </div>
        ) : (
          <ul className="mt-2">
            {files.map((file) => (
              <li
                className="flex min-h-10 items-center gap-2 border-divider border-b hover:bg-surface-hover-bg"
                key={file.key}
              >
                <FileRow file={file} />
                {file.note}
                {file.menu && <Menu items={file.menu} />}
              </li>
            ))}
          </ul>
        ))}
      {children}
    </section>
  );
}

function FileRow({ file }: { file: FileCard }) {
  const className =
    'flex min-h-10 min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset';
  const body = (
    <>
      <FileIcon className="size-4 shrink-0" name={file.icon} />
      <span className="min-w-0 flex-1 truncate font-semibold">{file.name}</span>
    </>
  );
  return file.link ? (
    <Link className={className} {...file.link}>
      {body}
    </Link>
  ) : (
    <button className={className} onClick={file.onOpen} type="button">
      {body}
    </button>
  );
}

/** An assignment's Files, for its staff and its members alike. */
export function AssignmentFiles({ assignment }: { assignment: Assignment }) {
  if (assignment.files.length === 0) return null;
  return (
    <FileCards
      files={assignment.files.map((file) => ({
        icon: assignmentFileIcon(file),
        key: file.fileId ?? file.materialId ?? file.name,
        link: fileLink(assignment.workspaceId, file),
        name: file.name,
        thumbnail: {
          fileKind: file.fileId ? (file.kind as FileKind) : undefined,
          preview: file.preview as Thumbnail['preview'],
          thumbnailUrl: file.thumbnailUrl,
        },
      }))}
      title={m.assignment_field_files()}
    />
  );
}
