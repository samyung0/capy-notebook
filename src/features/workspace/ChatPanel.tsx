import type React from 'react';
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { chatTurn, LIBRARY_DEFAULT } from '@/api/chatStream';
import { useConversations, useMe, useMessages } from '@/api/hooks';
import { CHAT_CHARACTER_LIMIT } from '@/api/limits.generated';
import type {
  ChatMessage,
  ChatSteps,
  Citation,
  ResourceRef,
  UserColor,
} from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { CharCount } from '@/components/ui/Input';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { Textarea } from '@/components/ui/TextArea';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { textLength } from '@/lib/textLength';
import { userColorPairDark } from '@/lib/userColor';
import {
  CHAT_DOCK_TRANSITION,
  ChatDock,
  withViewTransition,
} from './chat/ChatDock';
import { ChatHistoryDialog } from './chat/ChatHistoryDialog';
import { ChatTrace, type UndoHandlers } from './chat/ChatTrace';
import { LangAnswer } from './chat/LangAnswer';
import { QuestionBlock } from './chat/QuestionBlock';
import { extractQuestions } from './chat/questions';
import type { TabAction } from './PanelTabRow';
import { toChatMessage, useChatStream } from './useChatStream';
import { useProcessFileChanges } from './useProcessFileChanges';

/** Page label for a citation, absent for sources with no page model (txt/md
 * and anything stored without parsing). */
function pageLabel(c: Citation): string | null {
  if (!c.pageStart) return null;
  return c.pageEnd && c.pageEnd !== c.pageStart
    ? `pp. ${c.pageStart}–${c.pageEnd}`
    : `p. ${c.pageStart}`;
}

function Citations({
  msg,
  onOpen,
}: {
  msg: ChatMessage;
  onOpen?: (citation: Citation) => void;
}) {
  if (!msg.citations?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {msg.citations.map((c, i) => {
        const page = pageLabel(c);
        return (
          <Badge
            asChild
            className="max-w-full font-medium hover:bg-page-hover"
            key={`${c.materialId || c.fileId}:${i}`}
            size="sm"
          >
            <button onClick={() => onOpen?.(c)} title={c.snippet} type="button">
              <span className="text-fg-muted">{i + 1}</span>
              <span className="truncate">{c.fileName}</span>
              {page ? <span className="text-fg-muted">{page}</span> : null}
            </button>
          </Badge>
        );
      })}
    </div>
  );
}

function AssistantBubble({
  msg,
  streaming,
  latest,
  mode,
  handlers,
  onOpenCitation,
}: {
  msg: ChatMessage;
  streaming: boolean;
  /** The last message of the thread: its questions live in the question block. */
  latest: boolean;
  mode: ChatSteps;
  handlers: UndoHandlers;
  onOpenCitation?: (citation: Citation) => void;
}) {
  const live = streaming && msg.status === 'streaming';
  // Text streaming before the answer phase is narration, drawn below the
  // trace until its block ends and the trace takes it.
  const draft = msg.phase === 'answering' ? msg.currentBlockText : undefined;
  const answer = msg.content || draft || '';
  return (
    <div className="py-2.5">
      <ChatTrace handlers={handlers} live={live} mode={mode} msg={msg} />
      {msg.currentBlockText && msg.phase !== 'answering' && !msg.content ? (
        <div className="mt-6 mb-4">
          <LangAnswer
            citations={msg.citations}
            complete={false}
            content={msg.currentBlockText}
            latest={false}
            streaming
          />
        </div>
      ) : null}
      {answer ? (
        <LangAnswer
          citations={msg.citations}
          complete={msg.status === 'complete'}
          content={answer}
          latest={latest}
          onOpenCitation={onOpenCitation}
          streaming={live}
        />
      ) : null}
      {msg.status === 'aborted' && (
        <p className="mt-1 py-1 text-fg-muted italic">{m.chat_stopped()}</p>
      )}
      {msg.status === 'error' && (
        <div
          className="mt-2 rounded-lg bg-tint-error px-2.5 py-1.5 text-sm text-tint-error-fg"
          role="alert"
        >
          <p className="font-medium">{m.chat_interrupted()}</p>
          <p>{msg.error || m.chat_retry_connection()}</p>
        </div>
      )}
      {msg.modelDisplayName || msg.modelSlug ? (
        <p className="mt-6 text-fg-muted">
          {msg.modelDisplayName || msg.modelSlug}
        </p>
      ) : null}
      <Citations msg={msg} onOpen={onOpenCitation} />
    </div>
  );
}

/** Below lg chat has no panel: a dock on the file page and a chat page over
 * the viewer, which the dock grows into on send. */
export interface ChatDockOptions {
  /** Workspace actions after New chat in the chat page's ⋮. */
  menuItems: MenuItem[];
  /** An Office file is open: the dock stays a button above its bottom chrome. */
  office: boolean;
}

export interface ChatRequest {
  id: string | null;
  seq: number;
}

export function ChatPanel({
  workspaceId,
  color,
  canReprocess,
  openResource,
  onOpenCitation,
  onOpenResource,
  renderTabRow,
  dock,
  historyButton = true,
  request,
  onActiveChange,
}: {
  workspaceId: string;
  /** The history clock; off where the left panel lists the chats. */
  historyButton?: boolean;
  /** Opens a thread (or, with a null id, a new chat) whenever `seq` changes:
   * the left panel's list drives the rail's chat through it. */
  request?: ChatRequest;
  /** The shown thread, for the left panel to highlight. */
  onActiveChange?: (id: string | null) => void;
  color?: UserColor;
  /** Draws the panel's tab row with this chat's own actions (history, new chat). */
  renderTabRow?: (actions: TabAction[]) => ReactNode;
  dock?: ChatDockOptions;
  /** Owner-only: shows the process-changes button under the pending notice. */
  canReprocess?: boolean;
  /** What the learner has open in the center pane, sent with each turn. */
  openResource?: { id: string; kind: 'file' | 'material' } | null;
  /** Opens and highlights a cited source in the center pane. */
  onOpenCitation?: (citation: Citation) => void;
  /** Opens a resource a tool created, edited or restored, in the center pane. */
  onOpenResource?: (ref: ResourceRef) => void;
}) {
  const {
    pendingSources,
    messages,
    conversationId,
    streaming,
    send,
    stop,
    startNew,
    hydrate,
    applyUndo,
    refuseUndo,
  } = useChatStream(workspaceId);
  const { data: me } = useMe({ errorBoundary: false });
  const mode: ChatSteps = me?.chatSteps ?? 'normal';
  const sendKey = me?.chatSendKey ?? 'enter';
  // Dock only: the chat page is open, or a chip leads back to it after a
  // citation or a created file took the learner to the file.
  const [pageOpen, setPageOpen] = useState(false);
  const [backShown, setBackShown] = useState(false);
  function toFile() {
    if (!dock) return;
    setPageOpen(false);
    setBackShown(true);
  }
  const openCitation =
    onOpenCitation &&
    ((citation: Citation) => {
      toFile();
      onOpenCitation(citation);
    });
  const openCreated =
    onOpenResource &&
    ((ref: ResourceRef) => {
      toFile();
      onOpenResource(ref);
    });
  const handlers: UndoHandlers = {
    onOpenResource: openCreated,
    onUndoApplied: applyUndo,
    onUndoRefused: refuseUndo,
  };
  const { mutate: processChanges, isPending: processingChanges } =
    useProcessFileChanges(workspaceId);
  const { data: conversations } = useConversations(workspaceId, {
    errorBoundary: false,
  });

  const [text, setText] = useState('');
  const overLimit = textLength(text) > CHAT_CHARACTER_LIMIT;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectId, setSelectId] = useState<string | null>(null);
  // The Library switch applies per turn; it stays where the learner left it.
  const [library, setLibrary] = useState(LIBRARY_DEFAULT);
  const { data: history } = useMessages(selectId, { errorBoundary: false });
  const hydratedRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const lightPair = userColorPairDark(color);

  // Questions belong to the latest completed reply only and take the
  // composer's place until answered or dismissed; after that, unanswered ones
  // stay readable in the bubble and are never re-asked.
  const last = messages.at(-1);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const questions = useMemo(
    () =>
      !streaming &&
      last?.role === 'assistant' &&
      last.status === 'complete' &&
      last.id !== dismissedId
        ? extractQuestions(last.content)
        : [],
    [last, streaming, dismissedId]
  );

  // Seed local state when a previously-saved conversation is opened.
  useEffect(() => {
    if (selectId && history && hydratedRef.current !== selectId) {
      hydratedRef.current = selectId;
      hydrate(selectId, history.map(toChatMessage));
    }
  }, [selectId, history, hydrate]);

  // Keep the newest message in view as tokens stream in or a thread opens;
  // an Undo on an older receipt changes messages too and must not scroll.
  const shownCount = useRef(0);
  useEffect(() => {
    if (!streaming && messages.length === shownCount.current) return;
    shownCount.current = messages.length;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || streaming || overLimit) return;
    setText('');
    void send(trimmed, chatTurn(library, openResource));
  }

  function openNew() {
    hydratedRef.current = null;
    setSelectId(null);
    startNew();
  }
  function openThread(id: string) {
    hydratedRef.current = null;
    setSelectId(id);
  }
  // An archived or deleted thread leaves the panel for a new chat.
  function onRemoved(id: string) {
    if (id === conversationId) openNew();
  }

  const followRequest = useEffectEvent((next: ChatRequest) => {
    if (next.id) openThread(next.id);
    else openNew();
  });
  useEffect(() => {
    if (request) followRequest(request);
  }, [request]);
  useEffect(() => {
    onActiveChange?.(conversationId);
  }, [conversationId, onActiveChange]);

  // The dock always starts a new conversation (one still answering keeps
  // streaming in the background), then grows into the chat page; the keyboard
  // closes so the answer has the page.
  function sendFromDock() {
    const trimmed = text.trim();
    if (!trimmed || overLimit) return;
    (document.activeElement as HTMLElement | null)?.blur();
    withViewTransition(() => {
      openNew();
      setText('');
      void send(trimmed, chatTurn(library, openResource));
      setPageOpen(true);
      setBackShown(false);
    });
  }

  const colorVars = {
    '--temp-btn-bg': lightPair.bg,
    '--temp-btn-fg': lightPair.fg,
  } as React.CSSProperties;
  const historyAction: TabAction = {
    icon: 'clock',
    label: m.chat_history(),
    onClick: () => setHistoryOpen(true),
  };
  const newAction: TabAction = {
    disabled: !conversationId,
    icon: 'newChat',
    label: m.chat_new(),
    onClick: openNew,
  };
  const title =
    conversations?.find((c) => c.id === conversationId)?.title ||
    m.chat_untitled();

  const thread = (
    <>
      <ChatHistoryDialog
        activeId={conversationId}
        onClose={() => setHistoryOpen(false)}
        onNew={openNew}
        onOpen={openThread}
        onRemoved={onRemoved}
        open={historyOpen}
        workspaceId={workspaceId}
      />

      <div
        className="scroll-fade-y flex flex-1 flex-col gap-4 self-stretch overflow-auto px-4 py-4 [--scroll-fade-bottom-padding:--spacing(4)]"
        ref={scrollRef}
      >
        {!messages.length && (
          <div className="m-auto max-w-[80%] text-center">
            <Icon
              className="non-scaling-svg mx-auto mb-2 size-6.5"
              name="message"
            />
            <p>{m.chat_empty()}</p>
          </div>
        )}
        {pendingSources?.omitted && (
          <div
            className="rounded-lg border border-line bg-surface p-3 text-sm"
            role="status"
          >
            <p>{m.source_pending_context()}</p>
            {canReprocess && (
              <Button
                disabled={processingChanges}
                onClick={() => processChanges(pendingSources.fileIds)}
                size="sm"
                variant="ghost-hover"
              >
                {m.source_process_changes()}
              </Button>
            )}
          </div>
        )}
        {messages.map((msg, index) =>
          msg.role === 'user' ? (
            <div
              className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-tr-sm bg-page px-3.5 py-2.5"
              key={msg.id}
            >
              {msg.content}
            </div>
          ) : (
            <AssistantBubble
              handlers={handlers}
              key={msg.key ?? msg.id}
              latest={
                index === messages.length - 1 &&
                msg.status !== 'aborted' &&
                msg.status !== 'error' &&
                msg.id !== dismissedId
              }
              mode={mode}
              msg={msg}
              onOpenCitation={openCitation}
              streaming={streaming}
            />
          )
        )}
      </div>

      <div className="grow-0 p-3">
        {questions.length > 0 && last ? (
          <QuestionBlock
            disabled={streaming}
            key={last.id}
            onDismiss={() => setDismissedId(last.id)}
            onSend={(answer) =>
              void send(answer, chatTurn(library, openResource))
            }
            questions={questions}
          />
        ) : (
          <div
            className={cn(
              'flex flex-col gap-2 rounded-input border border-line bg-surface px-3 pt-2.5 pb-2 transition-colors focus-within:border-action-accent has-[textarea[aria-invalid=true]]:border-solid-error has-[textarea[aria-invalid=true]]:transition-none'
            )}
          >
            <Textarea
              aria-invalid={overLimit || undefined}
              aria-label={m.chat_placeholder()}
              className={cn(
                // 16px on phones, which zoom the page into smaller fields.
                'max-h-[7lh] min-h-[2lh] resize-none rounded-none border-0 bg-transparent px-0 py-0 text-fg focus:border-0 max-sm:text-base'
              )}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // The chosen send key sends; the other one adds a new line.
                // An IME's Enter confirms its candidate and never sends.
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                if (e.shiftKey !== (sendKey === 'shift_enter')) return;
                e.preventDefault();
                submit();
              }}
              placeholder={m.chat_placeholder()}
              rows={2}
              value={text}
            />
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-pressed={library}
                      className={cn(
                        'h-7.5 rounded-full px-2.5 font-semibold text-[13px]',
                        library &&
                          'border-transparent bg-tint-accent-1 text-tint-accent-1-fg hover:bg-tint-accent-1'
                      )}
                      iconLeft="book"
                      onClick={() => setLibrary((value) => !value)}
                      size="sm"
                      variant="outline"
                    >
                      {m.chat_library()}
                    </Button>
                  }
                />
                <TooltipContent>{m.chat_library_hint()}</TooltipContent>
              </Tooltip>
              <span className="ml-auto" />
              <CharCount max={CHAT_CHARACTER_LIMIT} value={textLength(text)} />
              <IconButton
                className="p-2.5"
                disabled={!streaming && overLimit}
                icon="send"
                iconClassName={cn(
                  'transition-[opacity,filter,scale] duration-(--motion-duration-fast) ease-(--motion-ease-in-out) motion-reduce:transition-none',
                  streaming
                    ? 'scale-25 opacity-0 blur-[2px]'
                    : 'scale-100 opacity-100 blur-none'
                )}
                label={streaming ? m.chat_stop() : m.chat_send()}
                onClick={streaming ? stop : submit}
                size="sm"
                variant={streaming ? 'ghost' : 'accent'}
              >
                <span
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute inset-0 grid place-items-center transition-[opacity,filter,scale] duration-(--motion-duration-fast) ease-(--motion-ease-in-out) motion-reduce:transition-none',
                    streaming
                      ? 'scale-100 opacity-100 blur-none'
                      : 'scale-25 opacity-0 blur-[2px]'
                  )}
                >
                  {/* Flush with the send button's bottom-right edge, not centred in its padding */}
                  <span className="translate-0.5 grid size-6.5 place-items-center rounded-full border-2 border-action-accent">
                    <Icon
                      className="size-3 fill-current text-action-accent"
                      name="stop"
                    />
                  </span>
                </span>
              </IconButton>
            </div>
          </div>
        )}
        {/* TODO: update workdings to sth like answer generated may not be accurate etc  */}
        <p className="mt-2 text-center text-[11px] text-fg-muted">
          {library ? m.chat_grounded_library() : m.chat_grounded()}
        </p>
      </div>
    </>
  );

  if (!dock)
    return (
      <div className="flex h-full flex-col" style={colorVars}>
        {renderTabRow?.(
          historyButton ? [historyAction, newAction] : [newAction]
        )}
        {thread}
      </div>
    );
  // Over the viewer: the chat page when open, else the dock on the file.
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      style={colorVars}
    >
      <div
        className={cn(
          // The keyboard covers the page; the composer stays just above it.
          'pointer-events-auto absolute inset-0 flex flex-col overflow-hidden rounded-card-xl bg-surface pb-(--keyboard-inset,0px) shadow-card',
          CHAT_DOCK_TRANSITION
        )}
        data-keyboard-overlay
        data-workspace-chat-page
        hidden={!pageOpen}
      >
        <div className="flex h-12 shrink-0 items-center gap-1 border-divider border-b pr-1 pl-2 sm:h-14 sm:gap-2 sm:pr-2 sm:pl-4">
          <ToolbarButton
            label={m.action_back()}
            onClick={() =>
              withViewTransition(() => {
                setPageOpen(false);
                setBackShown(messages.length > 0);
              })
            }
          >
            <Icon name="navigationBack" />
          </ToolbarButton>
          <Icon
            className="size-4 shrink-0 -translate-y-px text-solid-accent-1 md:size-5"
            name="message"
          />
          <h2 className="t-body min-w-0 flex-1 truncate font-semibold">
            {title}
          </h2>
          <ToolbarButton
            label={historyAction.label}
            onClick={historyAction.onClick}
          >
            <Icon name="clock" />
          </ToolbarButton>
          <Menu
            items={[newAction, ...dock.menuItems]}
            trigger={
              <ToolbarButton label={m.a11y_open_menu()}>
                <Icon name="moreVertical" />
              </ToolbarButton>
            }
          />
        </div>
        {thread}
      </div>
      {!pageOpen && (
        <ChatDock
          back={
            backShown
              ? {
                  onClose: () => setBackShown(false),
                  onOpen: () =>
                    withViewTransition(() => {
                      setPageOpen(true);
                      setBackShown(false);
                    }),
                  title,
                }
              : undefined
          }
          office={dock.office}
          onOpenHistory={() => {
            withViewTransition(() => {
              setPageOpen(true);
              setBackShown(false);
            });
            setHistoryOpen(true);
          }}
          onSend={sendFromDock}
          onTextChange={setText}
          overLimit={overLimit}
          sendDisabled={!text.trim() || overLimit}
          text={text}
        />
      )}
    </div>
  );
}
