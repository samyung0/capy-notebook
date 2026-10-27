import { useState } from 'react';
import { updateConversationBodyTitleMax } from '@/api/gen/validators';
import {
  useConversations,
  useDeleteConversation,
  useUpdateConversation,
} from '@/api/hooks';
import type { Conversation } from '@/api/types';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonList, Spinner } from '@/components/ui/feedback';
import { HoverActions } from '@/components/ui/HoverActions';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { sampleChats } from '@/features/guide/tourSamples';
import { useRunningTour } from '@/features/guide/tourStore';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { PanelNewRow } from '../PanelNewRow';
import { matchesSearch, PanelSearch } from '../PanelSearch';

/**
 * A workspace's chats (or with a null `workspaceId` the account chat's) for
 * the left panel and the Chat history dialog: a title search, New chat, then
 * Pinned and Older. Each row's ⋮ pins, renames, archives or deletes it
 * (after a confirm).
 */
export function ConversationList({
  workspaceId,
  activeId,
  onOpen,
  onNew,
  onRemoved,
  listClassName,
}: {
  workspaceId: string | null;
  /** The thread the chat panel shows, highlighted. */
  activeId: string | null;
  onOpen: (id: string) => void;
  /** Draws New chat on top; the phone dialog puts it in its header instead. */
  onNew?: () => void;
  /** A thread left the list (archived or deleted). */
  onRemoved: (id: string) => void;
  listClassName?: string;
}) {
  const { data: conversations } = useConversations(workspaceId, {
    errorBoundary: false,
  });
  const { mutate: update, mutateAsync: rename } =
    useUpdateConversation(workspaceId);
  const { mutate: remove } = useDeleteConversation(workspaceId);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const tour = useRunningTour();
  // The tour shows example rows where this workspace has no chats yet.
  const sample =
    tour?.workspaceId === workspaceId && conversations?.length === 0;

  const shown = conversations?.filter((c) =>
    matchesSearch(c.title || m.chat_untitled(), query)
  );
  const groups = [
    { label: m.chat_group_pinned(), rows: shown?.filter((c) => c.pinnedAt) },
    { label: m.chat_group_older(), rows: shown?.filter((c) => !c.pinnedAt) },
  ];

  function row(c: Conversation) {
    const active = c.id === activeId;
    return (
      <div
        className={cn(
          'group relative flex items-center rounded-button px-2 hover:bg-surface-hover-bg',
          active && 'bg-surface-hover-bg'
        )}
        key={c.id}
      >
        <button
          aria-current={active ? 'true' : undefined}
          className={cn(
            'flex w-full min-w-0 items-center rounded-button py-1.5 text-left',
            active && 'font-bold'
          )}
          onClick={() => onOpen(c.id)}
          type="button"
        >
          <span className="line-clamp-1 flex-1 translate-y-px">
            {c.title || m.chat_untitled()}
          </span>
          {/* A turn still answering, in any tab (Epo 2026-10-27, T19). */}
          {c.running && (
            <Spinner
              className="ml-1.5 size-3.5 shrink-0"
              label={m.chat_running()}
            />
          )}
        </button>
        <HoverActions
          className={cn(
            'absolute top-1/2 right-1 -translate-y-1/2 pl-0 [--scroll-fade-start:0px]',
            active && 'bg-surface-hover-bg'
          )}
          items={[
            c.pinnedAt
              ? {
                  icon: 'unpin',
                  label: m.chat_unpin(),
                  onClick: () => update({ id: c.id, pinned: false }),
                }
              : {
                  icon: 'pin',
                  label: m.chat_pin(),
                  onClick: () => update({ id: c.id, pinned: true }),
                },
            {
              icon: 'write',
              label: m.action_rename(),
              onClick: () => setRenaming(c),
            },
            {
              icon: 'archive',
              label: m.chat_archive(),
              onClick: () => {
                update({ archived: true, id: c.id });
                onRemoved(c.id);
              },
            },
            {
              danger: true,
              icon: 'trash',
              label: m.action_delete(),
              onClick: () => setDeleting(c),
            },
          ]}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelSearch label={m.chat_search()} onChange={setQuery} value={query} />
      {onNew && (
        <PanelNewRow icon="newChat" label={m.chat_new()} onClick={onNew} />
      )}
      <div
        className={cn(
          'scroll-fade-y min-h-0 flex-1 overflow-auto px-2.5 pt-2 pb-4 [--scroll-fade-bottom-padding:--spacing(4)]',
          listClassName
        )}
      >
        {!conversations && (
          <SkeletonList className="px-1.5 py-2" count={5} rowHeight={32} />
        )}
        {shown?.length === 0 &&
          (sample ? (
            <div className="flex flex-col" inert>
              <div className="t-label px-1.5 py-1.5 text-fg-muted">
                {m.tour_example()}
              </div>
              {sampleChats().map((title) => (
                <div className="rounded-button px-2 py-1.5" key={title}>
                  <span className="line-clamp-1 translate-y-px">{title}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-2 py-1.5 text-fg-muted text-sm">
              {conversations?.length
                ? m.chat_no_matches()
                : m.chat_no_conversations()}
            </p>
          ))}
        <div className="flex flex-col gap-3">
          {groups.map(
            (group) =>
              !!group.rows?.length && (
                <div className="flex flex-col" key={group.label}>
                  <div className="t-label px-1.5 py-1.5 text-fg-muted">
                    {group.label}
                  </div>
                  {group.rows.map(row)}
                </div>
              )
          )}
        </div>
      </div>
      {renaming && (
        <NameFormDialog
          defaultName={renaming.title}
          maxLength={updateConversationBodyTitleMax}
          onClose={() => setRenaming(null)}
          onSubmit={(title) => rename({ id: renaming.id, title })}
          open
          submitLabel={m.action_save()}
          title={m.chat_rename()}
        />
      )}
      <ConfirmDialog
        body={m.chat_delete_body()}
        confirmLabel={m.action_delete()}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          remove(deleting.id);
          onRemoved(deleting.id);
        }}
        open={!!deleting}
        title={m.chat_delete_title({
          title: deleting?.title || m.chat_untitled(),
        })}
      />
    </div>
  );
}
