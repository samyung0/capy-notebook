import { useQueryClient } from '@tanstack/react-query';
import {
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '@/api/client';
import {
  fileQuery,
  materialQuery,
  useUnreadNotificationCount,
} from '@/api/hooks';
import { showErrorToast } from '@/api/queryClient';
import type { Citation, ResourceRef } from '@/api/types';
import { AppErrorBoundary } from '@/components/app/AppErrorBoundary';
import { Panel } from '@/components/app/layout';
import { ProfileMenu } from '@/components/app/ProfileMenu';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { searchFromOpenItem } from '@/features/materials/openItem';
import { useVoiceAsk } from '@/features/voice/voiceAsk';
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
  const queryClient = useQueryClient();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const lg = useMediaQuery('(min-width: 1024px)');
  const { data: unread } = useUnreadNotificationCount({
    errorBoundary: false,
  });
  const [request, setRequest] = useState<ChatRequest>();
  const [active, setActive] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
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

  // A spoken question (the sidebar's voice card) always starts a new chat;
  // the URL drops any open thread without opening another new one.
  useVoiceAsk((prompt) => {
    activeRef.current = null;
    setRequest((previous) => ({
      id: null,
      prompt,
      seq: (previous?.seq ?? 0) + 1,
    }));
    if (urlRef.current) void show(null);
  });

  // A new chat's first turn names its conversation: the URL follows. The
  // panel reports no thread while one opens, so only named threads count;
  // New chat goes through the URL instead.
  const onActiveChange = useCallback(
    (id: string | null, panelShown: boolean) => {
      activeRef.current = id;
      setActive(id);
      setShown(panelShown);
      if (id && id !== urlRef.current) void show(id);
    },
    [show]
  );
  // New chat also leaves a first send refused before it got a conversation,
  // which the URL (still /chat) cannot tell apart from a new chat.
  const newChat = () => {
    activeRef.current = null;
    setRequest((previous) => ({ id: null, seq: (previous?.seq ?? 0) + 1 }));
    if (urlRef.current) void show(null);
  };
  const onRemoved = (id: string) => {
    if (id === active) void show(null);
  };

  function back() {
    if (canGoBack) router.history.back();
    else void navigate({ to: '/' });
  }

  // Cited and created items open where they live now (Epo 2026-10-28,
  // review M1), read again on click so a Move after the answer does not
  // strand the link: a workspace item in its workspace (a citation at its
  // page), a standalone one on its own page, which also shows an item gone
  // or out of reach (a 404). Any other failure, offline included, is the
  // error toast and the chat stays (review r1 F1).
  async function openItem(
    kind: 'file' | 'material',
    id: string,
    search: Record<string, unknown>
  ) {
    // Fresh, not the cache: the item may have moved since it was read.
    let item: { workspaceId?: string | null } | null;
    try {
      item = await (kind === 'file'
        ? queryClient.fetchQuery({ ...fileQuery(id), staleTime: 0 })
        : queryClient.fetchQuery({ ...materialQuery(id), staleTime: 0 }));
    } catch (error) {
      if (!(isApiError(error) && error.status === 404)) {
        showErrorToast(error);
        return;
      }
      item = null;
    }
    const workspaceId = item?.workspaceId;
    if (workspaceId)
      void navigate({
        params: { workspaceId },
        search,
        to: '/workspaces/$workspaceId',
      });
    else if (kind === 'material')
      void navigate({
        params: { materialId: id },
        to: '/materials/$materialId',
      });
    else void navigate({ params: { fileId: id }, to: '/files/$fileId' });
  }
  function openCitation(citation: Citation) {
    const { materialId } = citation;
    if (materialId)
      void openItem('material', materialId, {
        material: materialId,
        mode: 'view',
      });
    else
      void openItem(
        'file',
        citation.fileId,
        searchFromOpenItem({
          id: citation.fileId,
          kind: 'file',
          page: citation.pageStart ?? undefined,
        })
      );
  }
  function openResource(ref: ResourceRef) {
    const kind = ref.kind === 'material' ? 'material' : 'file';
    void openItem(kind, ref.id, searchFromOpenItem({ id: ref.id, kind }));
  }

  // The Chat panel's row: Back, the Chats menu below lg, the title and New
  // chat.
  const header = (
    <div className="flex h-12.25 shrink-0 items-center gap-1 pt-2.5 pr-2 pl-1.5">
      <ToolbarButton label={m.action_back()} onClick={back}>
        <Icon className="-translate-y-px" name="navigationBack" />
      </ToolbarButton>
      {!lg && (
        <ToolbarButton
          label={m.chat_chats()}
          onClick={() => setHistoryOpen(true)}
        >
          <Icon name="menu" />
        </ToolbarButton>
      )}
      <h1 className="t-subtitle ml-1 min-w-0 flex-1 truncate">
        {m.workspace_tab_chat()}
      </h1>
      <ToolbarButton disabled={!shown} label={m.chat_new()} onClick={newChat}>
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
                onNew={newChat}
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
              focusOnOpen
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
          onNew={newChat}
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
