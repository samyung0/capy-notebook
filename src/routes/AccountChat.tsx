import {
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useUnreadNotificationCount } from '@/api/hooks';
import type { Citation, ResourceRef } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { Panel } from '@/components/app/layout';
import { ProfileMenu } from '@/components/app/ProfileMenu';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { searchFromOpenItem } from '@/features/materials/openItem';
import { ChatPanel, type ChatRequest } from '@/features/workspace/ChatPanel';
import { ArchivedChatsDialog } from '@/features/workspace/chat/ArchivedChatsDialog';
import { ChatHistoryDialog } from '@/features/workspace/chat/ChatHistoryDialog';
import { ConversationList } from '@/features/workspace/chat/ConversationList';
import { PanelTabRow } from '@/features/workspace/PanelTabRow';
import { m } from '@/i18n';
import { useMediaQuery } from '@/lib/useMediaQuery';

/**
 * Chat across all the user's files (Epo 2026-10-27, option E): the
 * workspace's Chats left panel in the app sidebar's place and its Chat panel
 * filling the rest, the thread in a readable centred column. Below lg the
 * Chats list opens from the header's menu button. The URL names the shown
 * conversation; moving between chats replaces it, so the back arrow returns
 * to the page the user came from.
 */
export default function AccountChat() {
  const { conversationId } = useParams({ strict: false });
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const lg = useMediaQuery('(min-width: 1024px)');
  const { data: unread } = useUnreadNotificationCount({
    errorBoundary: false,
  });
  const [request, setRequest] = useState<ChatRequest>();
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  const urlRef = useRef(conversationId ?? null);
  urlRef.current = conversationId ?? null;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const show = useCallback(
    (id: string | null) =>
      navigate({
        params: { conversationId: id ?? undefined },
        replace: true,
        to: '/chat/{-$conversationId}',
      }),
    [navigate]
  );

  // The URL drives the panel: a conversation it does not show yet opens.
  useEffect(() => {
    const id = conversationId ?? null;
    if (id === activeRef.current) return;
    setRequest((previous) => ({ id, seq: (previous?.seq ?? 0) + 1 }));
  }, [conversationId]);

  // A new chat's first turn names its conversation: the URL follows. The
  // panel reports no thread while one opens, so only named threads count;
  // New chat goes through the URL instead.
  const onActiveChange = useCallback(
    (id: string | null) => {
      activeRef.current = id;
      setActive(id);
      if (id && id !== urlRef.current) void show(id);
    },
    [show]
  );
  const onRemoved = (id: string) => {
    if (id === active) void show(null);
  };

  function back() {
    if (canGoBack) router.history.back();
    else void navigate({ to: '/' });
  }

  // Cited and created items open where they live: a workspace item in its
  // workspace, a standalone one on its own page.
  function openCitation(citation: Citation) {
    const { materialId, workspaceId } = citation;
    if (workspaceId)
      void navigate({
        params: { workspaceId },
        search: materialId
          ? { material: materialId, mode: 'view' }
          : searchFromOpenItem({
              id: citation.fileId,
              kind: 'file',
              page: citation.pageStart ?? undefined,
            }),
        to: '/workspaces/$workspaceId',
      });
    else if (materialId)
      void navigate({
        params: { materialId },
        to: '/materials/$materialId',
      });
    else
      void navigate({
        params: { fileId: citation.fileId },
        to: '/files/$fileId',
      });
  }
  function openResource(ref: ResourceRef) {
    const material = ref.kind === 'material';
    if (ref.workspaceId)
      void navigate({
        params: { workspaceId: ref.workspaceId },
        search: searchFromOpenItem(
          material
            ? { id: ref.id, kind: 'material' }
            : { id: ref.id, kind: 'file' }
        ),
        to: '/workspaces/$workspaceId',
      });
    else if (material)
      void navigate({
        params: { materialId: ref.id },
        to: '/materials/$materialId',
      });
    else void navigate({ params: { fileId: ref.id }, to: '/files/$fileId' });
  }

  // The Chat panel's row: Back, the Chats menu below lg, the title with its
  // scope where a workspace chat names its views, and New chat.
  const header = (
    <div className="flex h-12.25 shrink-0 items-center gap-1 pt-2.5 pr-2 pl-1.5">
      <ToolbarButton label={m.action_back()} onClick={back}>
        <Icon name="navigationBack" />
      </ToolbarButton>
      {!lg && (
        <ToolbarButton
          label={m.chat_chats()}
          onClick={() => setHistoryOpen(true)}
        >
          <Icon name="menu" />
        </ToolbarButton>
      )}
      <div className="ml-1 flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="t-subtitle shrink-0">{m.workspace_tab_chat()}</h1>
        <span className="t-meta min-w-0 truncate text-fg-muted">
          {m.chat_all_your_files()}
        </span>
      </div>
      <ToolbarButton
        disabled={!active}
        label={m.chat_new()}
        onClick={() => void show(null)}
      >
        <Icon name="newChat" />
      </ToolbarButton>
    </div>
  );

  return (
    <>
      <div className="flex h-full min-h-0 gap-2.5">
        {lg && (
          <Panel
            className="w-75 shrink-0 xl:w-85"
            frost="left"
            sectionClassName="h-full gap-0"
          >
            <div className="flex h-full min-h-0 flex-col" data-account-chats>
              <PanelTabRow
                actions={[
                  {
                    icon: 'archive',
                    label: m.chat_archived_title(),
                    onClick: () => setArchivedOpen(true),
                  },
                ]}
                title={m.chat_chats()}
              />
              <ConversationList
                activeId={active}
                onNew={() => void show(null)}
                onOpen={(id) => void show(id)}
                onRemoved={onRemoved}
                workspaceId={null}
              />
              <div className="flex shrink-0 flex-col border-divider border-t px-2.5 py-2">
                <ProfileMenu
                  dot={(unread?.count ?? 0) > 0}
                  notifications
                  trigger="row"
                />
              </div>
            </div>
          </Panel>
        )}
        <Panel
          className="min-w-0 flex-1"
          frost="right"
          sectionClassName="h-full gap-0 overflow-hidden"
        >
          <AppErrorBoundary>
            <ChatPanel
              color="purple"
              fill
              historyButton={false}
              onActiveChange={onActiveChange}
              onOpenCitation={openCitation}
              onOpenResource={openResource}
              renderTabRow={() => header}
              request={request}
              workspaceId={null}
            />
          </AppErrorBoundary>
        </Panel>
      </div>
      {!lg && (
        <ChatHistoryDialog
          activeId={active}
          onClose={() => setHistoryOpen(false)}
          onNew={() => void show(null)}
          onOpen={(id) => void show(id)}
          onRemoved={onRemoved}
          open={historyOpen}
          workspaceId={null}
        />
      )}
      <ArchivedChatsDialog
        onClose={() => setArchivedOpen(false)}
        open={archivedOpen}
        workspaceId={null}
      />
    </>
  );
}
