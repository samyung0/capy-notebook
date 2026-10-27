import { useRef, useState } from 'react';
import {
  useChapters,
  useOwnedFiles,
  useWorkspace,
  useWorkspaces,
} from '@/api/hooks';
import type { SourceFile } from '@/api/types';
import { ListEnd } from '@/components/app/ListEnd';
import { PanelScrollRoot } from '@/components/app/layout';
import { PreviewCard } from '@/components/app/PreviewCard';
import { Button } from '@/components/ui/Button';
import { DialogFooter, DialogPrimary } from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { Spinner } from '@/components/ui/feedback';
import { SearchInput } from '@/components/ui/SearchInput';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { fileIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';
import { useDebounced } from '@/lib/useDebounced';
import { ChapterSelect, chapterByName, NewChapterInput } from './ChapterSelect';
import { moveErrorMessage, useMoveFilesFlow } from './MoveFileDialog';

/** POST /files/move takes at most this many files at once. */
const MOVE_MAX = 20;

/**
 * The Add file dialog's Your files tab: the files the user pays for (lost
 * access left out), searched by name on the server, as the shared cards with
 * each file's workspace. A pick of several moves them into this workspace
 * and the chapter in the footer; files already here are dimmed and cannot be
 * picked.
 */
export function YourFilesPanel({
  onMoved,
  workspaceId,
}: {
  onMoved: () => void;
  workspaceId: string;
}) {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    isPending,
  } = useOwnedFiles(q ? { q } : {});
  const files = (data?.pages ?? [])
    .flatMap((page) => page.items)
    .filter((file) => !file.lostAccess);
  const { data: workspaces } = useWorkspaces();
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: chapters } = useChapters(workspaceId);
  const { confirm, move } = useMoveFilesFlow(workspace?.name ?? '');
  const [picked, setPicked] = useState<Map<string, SourceFile>>(new Map());
  const [chapter, setChapter] = useState<{
    chapterId: string | null;
    chapterName: string | null;
  }>({ chapterId: null, chapterName: null });
  const [newChapter, setNewChapter] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [formError, setFormError] = useState<{
    errorId: string | null;
    message: string;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  function toggle(file: SourceFile) {
    setFormError(null);
    setPicked((current) => {
      const next = new Map(current);
      if (next.has(file.id)) next.delete(file.id);
      else next.set(file.id, file);
      return next;
    });
  }

  async function submit() {
    const selected = [...picked.values()];
    if (moving || selected.length === 0) return;
    setFormError(null);
    setMoving(true);
    // A chapter name still being typed counts, so Move never drops it.
    const typed = newChapter?.trim();
    const { chapterId, chapterName } = typed
      ? chapterByName(chapters, typed)
      : chapter;
    const only = selected.length === 1 ? selected[0] : undefined;
    try {
      const moved = await move(
        {
          chapterId: chapterId ?? undefined,
          chapterName: chapterName ?? undefined,
          fileIds: selected.map((file) => file.id),
          workspaceId,
        },
        selected.map((file) => file.workspaceId),
        only
          ? { name: only.name, workspaceName: only.workspaceName ?? '' }
          : { count: selected.length }
      );
      if (moved) onMoved();
    } catch (error) {
      setFormError({
        errorId: unexpectedErrorId(error),
        message: moveErrorMessage(error),
      });
    } finally {
      setMoving(false);
    }
  }

  const full = picked.size >= MOVE_MAX;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <SearchInput
        actionCallback={() => setSearch('')}
        actionClassName="hidden group-has-[input:not(:placeholder-shown)]/search:inline-flex"
        actionIcon="x"
        actionLabel={m.action_clear_search()}
        aria-label={m.source_your_files_search()}
        maxLength={120}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={m.source_your_files_search()}
        value={search}
      />
      <PanelScrollRoot.Provider value={scrollRef}>
        <div
          className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1"
          ref={scrollRef}
        >
          {isPending ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : files.length === 0 ? (
            <p className="t-meta py-8 text-center text-fg-muted">
              {m.source_your_files_empty()}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
              {files.map((file) => {
                const here = file.workspaceId === workspaceId;
                const selected = picked.has(file.id);
                const ws = workspaces?.find((w) => w.id === file.workspaceId);
                const wsName = file.workspaceName ?? ws?.name;
                return (
                  <PreviewCard
                    check
                    className={cn(here && 'opacity-50')}
                    disabled={here || moving || (full && !selected)}
                    icon={fileIconName(file)}
                    key={file.id}
                    onClick={() => toggle(file)}
                    selected={selected}
                    subtitle={
                      here ? (
                        m.source_your_files_here()
                      ) : file.workspaceId ? (
                        <>
                          {ws && (
                            <img
                              alt=""
                              className="size-3.5 shrink-0 -translate-y-px rounded-[3px]"
                              src={iconUrl(ws.iconId)}
                            />
                          )}
                          <span className="truncate">{wsName}</span>
                        </>
                      ) : (
                        m.files_no_workspace()
                      )
                    }
                    thumbnail={{
                      fileKind: file.kind,
                      preview: file.preview,
                      thumbnailUrl: file.thumbnailUrl,
                    }}
                    title={file.name}
                  />
                );
              })}
            </div>
          )}
          <ListEnd
            className="py-2"
            fetchNextPage={fetchNextPage}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
          />
        </div>
      </PanelScrollRoot.Provider>
      <FormAlert
        errorId={formError?.errorId}
        message={formError?.message ?? null}
      />
      <DialogFooter className="shrink-0">
        <div className="mr-auto">
          {newChapter === null ? (
            <ChapterSelect
              chapterName={chapter.chapterName}
              chapters={chapters ?? []}
              disabled={moving}
              field
              onChange={(chapterId) =>
                setChapter({ chapterId, chapterName: null })
              }
              onCreateRequest={() => setNewChapter('')}
              value={chapter.chapterId}
            />
          ) : (
            <NewChapterInput
              field
              onCancel={() => setNewChapter(null)}
              onChange={setNewChapter}
              onConfirm={() => {
                const name = newChapter.trim();
                if (!name) return;
                setChapter(chapterByName(chapters, name));
                setNewChapter(null);
              }}
              value={newChapter}
            />
          )}
        </div>
        <DialogPrimary pending={moving}>
          <Button
            disabled={moving || picked.size === 0}
            onClick={() => void submit()}
            size="lg"
            variant="accent"
          >
            {moving ? (
              <Spinner />
            ) : picked.size === 0 ? (
              m.action_move()
            ) : picked.size === 1 ? (
              m.source_move_files_one()
            ) : (
              m.source_move_files({ count: picked.size })
            )}
          </Button>
        </DialogPrimary>
      </DialogFooter>
      {confirm}
    </div>
  );
}
