import { useRef, useState } from 'react';
import {
  useOwnedFiles,
  useTopics,
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
import { moveErrorMessage, useMoveFilesFlow } from './MoveFileDialog';
import { NewTopicInput, TopicSelect, topicByName } from './TopicSelect';

/** POST /files/move takes at most this many files at once. */
const MOVE_MAX = 20;

/**
 * The Add file dialog's Your files tab: the files the user pays for (lost
 * access left out), searched by name on the server, as the shared cards with
 * each file's workspace. A pick of several moves them into this workspace
 * and the topic in the footer; files already here are dimmed and cannot be
 * picked.
 */
export function YourFilesPanel({
  defaultTopicId = null,
  onMoved,
  workspaceId,
}: {
  /** The topic the footer starts on: the open one. */
  defaultTopicId?: string | null;
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
  const { data: topics } = useTopics(workspaceId);
  const { confirm, move } = useMoveFilesFlow(workspace?.name ?? '');
  const [picked, setPicked] = useState<Map<string, SourceFile>>(new Map());
  const [topic, setTopic] = useState<{
    topicId: string | null;
    topicName: string | null;
  }>({ topicId: defaultTopicId, topicName: null });
  const [newTopic, setNewTopic] = useState<string | null>(null);
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
    // A topic name still being typed counts, so Move never drops it.
    const typed = newTopic?.trim();
    const { topicId, topicName } = typed ? topicByName(topics, typed) : topic;
    const only = selected.length === 1 ? selected[0] : undefined;
    try {
      const moved = await move(
        {
          fileIds: selected.map((file) => file.id),
          topicId: topicId ?? undefined,
          topicName: topicName ?? undefined,
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
                    // A file outside workspaces has no place line, as on
                    // other file cards (Epo 2026-10-30).
                    subtitle={
                      here
                        ? m.source_your_files_here()
                        : file.workspaceId && (
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
          {newTopic === null ? (
            <TopicSelect
              disabled={moving}
              field
              onChange={(topicId) => setTopic({ topicId, topicName: null })}
              onCreateRequest={() => setNewTopic('')}
              topicName={topic.topicName}
              topics={topics ?? []}
              value={topic.topicId}
            />
          ) : (
            <NewTopicInput
              field
              onCancel={() => setNewTopic(null)}
              onChange={setNewTopic}
              onConfirm={() => {
                const name = newTopic.trim();
                if (!name) return;
                setTopic(topicByName(topics, name));
                setNewTopic(null);
              }}
              value={newTopic}
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
