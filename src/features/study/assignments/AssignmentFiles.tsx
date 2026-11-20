import { Link } from '@tanstack/react-router';
import type { Assignment, FileKind } from '@/api/types';
import { ItemCard } from '@/components/app/ItemCard';
import { ListViewToggle, useListView } from '@/components/app/ListToolbar';
import type { Thumbnail } from '@/components/app/ThumbnailPanel';
import { FileIcon } from '@/components/ui/FileIcon';
import { m } from '@/i18n';
import { PREF_KEYS } from '@/lib/localPrefs';
import { fileLink } from './assignmentPage';
import { assignmentFileIcon } from './todoParts';

/** An assignment's Files, for its staff and its members alike (Epo 2026-11-19):
 * rows that open the file, or the Files page's cards, with the same list and
 * grid toggle. A file of another workspace says where it sits. */
export function AssignmentFiles({ assignment }: { assignment: Assignment }) {
  const [view, setView] = useListView(PREF_KEYS.assignmentFilesView);
  const { files } = assignment;
  if (files.length === 0) return null;
  const elsewhere = (file: Assignment['files'][number]) =>
    file.workspaceName && file.workspaceId !== assignment.workspaceId
      ? file.workspaceName
      : undefined;
  return (
    <section className="mt-6.5">
      {/* -mr-1.5: the toggle's icon on the gutter, as in ListToolbar. */}
      <div className="-mr-1.5 flex min-h-8 items-center justify-between gap-3">
        <h2 className="t-subtitle">{m.assignment_field_files()}</h2>
        <ListViewToggle onViewChange={setView} view={view} />
      </div>
      {view === 'grid' ? (
        // Smaller than the Files page's: two to a phone, 176px from sm.
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,176px)]">
          {files.map((file) => (
            <ItemCard
              icon={assignmentFileIcon(file)}
              key={file.fileId ?? file.materialId}
              link={fileLink(file)}
              meta=""
              thumbnail={{
                fileKind: file.fileId ? (file.kind as FileKind) : undefined,
                preview: file.preview as Thumbnail['preview'],
                thumbnailUrl: file.thumbnailUrl,
              }}
              title={file.name}
              view="grid"
              workspace={elsewhere(file)}
            />
          ))}
        </div>
      ) : (
        <ul className="mt-2">
          {files.map((file) => (
            <li key={file.fileId ?? file.materialId}>
              <Link
                className="flex min-h-10 items-center gap-2.5 border-divider border-b outline-none hover:bg-surface-hover-bg focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
                {...fileLink(file)}
              >
                <FileIcon
                  className="size-4 shrink-0"
                  name={assignmentFileIcon(file)}
                />
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {file.name}
                </span>
                {elsewhere(file) && (
                  <span className="t-meta max-w-[40%] shrink-0 truncate text-fg-muted">
                    {elsewhere(file)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
