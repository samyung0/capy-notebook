import type React from 'react';
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { chatTurn, WORKSPACE_ONLY_DEFAULT } from '@/api/chatStream';
import { isApiError } from '@/api/client';
import {
  useConversations,
  useMe,
  useMessages,
  useWorkspaces,
} from '@/api/hooks';
import { CHAT_CHARACTER_LIMIT } from '@/api/limits.generated';
import { isMissing } from '@/api/queryClient';
import type {
  ChatMessage,
  ChatSteps,
  Citation,
  ResourceRef,
  UserColor,
} from '@/api/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { CharCount } from '@/components/ui/Input';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { Textarea } from '@/components/ui/TextArea';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { audioStartMs, formatClock } from '@/features/files/citationRegions';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import {
  isString,
  PREF_KEYS,
  readPref,
  removePref,
  writePref,
} from '@/lib/localPrefs';
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
import { useVoiceInput, VoiceButton, VoiceElapsed } from './chat/VoiceInput';
import { insertTranscript } from './chat/voiceRecording';
import { sourceEntryId, webHref } from './chat/webCitation';
import type { TabAction } from './PanelTabRow';
import {
  type Seeded,
  seedsAgain,
  toChatMessage,
  useChatStream,
} from './useChatStream';
import { useProcessFileChanges } from './useProcessFileChanges';

/** Page label for a citation, or a transcript passage's start time; absent
 * for sources with no page model (txt/md and anything stored without
 * parsing). */
function pageLabel(c: Citation): string | null {
  const start = audioStartMs(c.regions);
  if (start !== undefined) return formatClock(start);
  if (!c.pageStart) return null;
  return c.pageEnd && c.pageEnd !== c.pageStart
    ? `pp. ${c.pageStart}–${c.pageEnd}`
    : `p. ${c.pageStart}`;
}

/** Where an account chat's cited source lives, before its name: its
 * workspace's icon and name, or No workspace. Workspace chats' citations
 * carry no place. */
function CitationPlace({ citation }: { citation: Citation }) {
  const { data: workspaces } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const iconId =
    citation.workspaceName &&
    workspaces?.find((workspace) => workspace.id === citation.workspaceId)
      ?.iconId;
  return (
    <>
      {iconId && (
        <img
          alt=""
          className="mx-0.5 size-3.5 shrink-0 -translate-y-px rounded-[4px]"
          height={14}
          src={iconUrl(iconId)}
          width={14}
        />
      )}
      <span className="min-w-0 max-w-[45%] shrink-0 truncate text-fg-muted">
        {citation.workspaceName || m.files_no_workspace()}
      </span>
      <span aria-hidden className="text-fg-muted">
        ·
      </span>
    </>
  );
}

/** A reply's sources under it (exported for tests). */
export function Citations({
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
        if (c.kind === 'web') {
          // A web result on its own row: its title links to the page in a
          // new tab beside its site and date, its snippet under them. A long
          // site name truncates within the row; the date always shows.
          const href = webHref(c.url);
          const body = (
            <>
              <span className="text-fg-muted">{i + 1}</span>
              <span className="min-w-0 truncate underline">{c.fileName}</span>
              {c.siteName ? (
                <span className="min-w-0 max-w-[40%] shrink-0 truncate text-fg-muted">
                  {c.siteName}
                </span>
              ) : null}
              {c.published ? (
                <span className="shrink-0 text-fg-muted">{c.published}</span>
              ) : null}
              {href ? (
                <Icon className="size-3 shrink-0" name="externalLink" />
              ) : null}
            </>
          );
          return (
            <div
              className="flex min-w-0 basis-full flex-col gap-0.5"
              key={`${c.chunkId}:${i}`}
            >
              <Badge
                asChild
                className="max-w-full self-start frosted:not-hover:bg-(--frost-fill) font-medium hover:bg-page-hover"
                size="sm"
              >
                {href ? (
                  <a
                    href={href}
                    id={sourceEntryId(msg.id, i)}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {body}
                  </a>
                ) : (
                  <span id={sourceEntryId(msg.id, i)}>{body}</span>
                )}
              </Badge>
              {c.snippet ? (
                <p className="line-clamp-2 px-2.25 text-fg-muted text-xs">
                  {c.snippet}
                </p>
              ) : null}
            </div>
          );
        }
        const page = pageLabel(c);
        return (
          <Badge
            asChild
            className="max-w-full frosted:not-hover:bg-(--frost-fill) font-medium hover:bg-page-hover"
            key={`${c.materialId || c.fileId}:${i}`}
            size="sm"
          >
            <button onClick={() => onOpen?.(c)} title={c.snippet} type="button">
              <span className="text-fg-muted">{i + 1}</span>
              {c.workspaceId !== undefined && <CitationPlace citation={c} />}
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
  // A web citation's raised number moves to its sources-list entry; a file
  // or note citation opens its passage.
  const openCitation = (citation: Citation) => {
    if (citation.kind !== 'web') {
      onOpenCitation?.(citation);
      return;
    }
    const index = msg.citations?.indexOf(citation) ?? -1;
    const entry = document.getElementById(sourceEntryId(msg.id, index));
    entry?.scrollIntoView({ block: 'nearest' });
    entry?.focus();
  };
  return (
    // An answer's copy stops at the answer when it runs into this message's
    // label or sources (answerCopy.ts).
    <div className="py-2.5" data-chat-message>
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
          onOpenCitation={openCitation}
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
  /** With a null id: the new chat's first question, sent once. */
  prompt?: string;
  seq: number;
}

/** Requests whose prompt went out, so a remounted panel never resends it. */
const sentPrompts = new WeakSet<ChatRequest>();

/** The pending-sources notice's button: process the omitted files' changes. */
function ProcessChangesButton({
  workspaceId,
  fileIds,
}: {
  workspaceId: string;
  fileIds: string[];
}) {
  const { mutate: processChanges, isPending: processingChanges } =
    useProcessFileChanges(workspaceId);
  return (
    <Button
      disabled={processingChanges}
      onClick={() => processChanges({ fileIds })}
      size="sm"
      variant="ghost-hover"
    >
      {m.source_process_changes()}
    </Button>
  );
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
  focusOnOpen = false,
  onActiveChange,
  fill = false,
}: {
  /** The workspace whose chat this is; null is the account chat, across all
   * the user's files (no open item, Your files only). */
  workspaceId: string | null;
  /** The panel fills the page (the account chat): the thread and composer
   * keep a readable centred column. */
  fill?: boolean;
  /** The history clock; off where the left panel lists the chats. */
  historyButton?: boolean;
  /** Opens a thread (or, with a null id, a new chat) whenever `seq` changes:
   * the left panel's list drives the rail's chat through it. */
  request?: ChatRequest;
  /** Each opened chat (a request, new or restored) puts the caret in the
   * composer: the account chat page. */
  focusOnOpen?: boolean;
  /** The shown thread, for the left panel to highlight, and whether the panel
   * shows any messages: a first send refused before it got a conversation
   * still has its message and error, so New chat stays available. */
  onActiveChange?: (id: string | null, shown: boolean) => void;
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
  const { data: conversations } = useConversations(workspaceId, {
    errorBoundary: false,
  });

  const [text, setText] = useState('');
  const overLimit = textLength(text) > CHAT_CHARACTER_LIMIT;
  const [historyOpen, setHistoryOpen] = useState(false);
  // The conversation this panel showed before a reload or a closed tab opens
  // again in its first render (Epo 2026-10-27, T19); a request the panel
  // mounts with (the account chat's URL) wins over it.
  const [restoredId] = useState(() =>
    request ? null : readPref(PREF_KEYS.openChat(workspaceId), null, isString)
  );
  const [selectId, setSelectId] = useState(request ? request.id : restoredId);
  // Workspace only applies per message; it stays where the learner left it.
  const [workspaceOnly, setWorkspaceOnly] = useState(WORKSPACE_ONLY_DEFAULT);
  const {
    data: history,
    error: historyError,
    fetchStatus: historyFetchStatus,
  } = useMessages(selectId, {
    errorBoundary: false,
  });
  // A thread the link names that is gone or not the caller's (review r1 F2).
  const missingThread = !!selectId && isMissing(historyError);
  const opening =
    selectId !== null && conversationId !== selectId && !historyError;
  const hydratedRef = useRef<Seeded | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const dockFieldRef = useRef<HTMLTextAreaElement>(null);

  // A transcript goes where the caret is (over a selection) in the field on
  // screen, the dock's or the composer's, or at the end while the questions
  // hide the composer; it is never sent by itself.
  function insertVoice(transcript: string) {
    const field = dock && !pageOpen ? dockFieldRef.current : fieldRef.current;
    if (!field) {
      setText(
        (value) =>
          insertTranscript(value, transcript, value.length, value.length).value
      );
      return;
    }
    const inserted = insertTranscript(
      field.value,
      transcript,
      field.selectionStart,
      field.selectionEnd
    );
    flushSync(() => setText(inserted.value));
    field.focus({ preventScroll: true });
    field.setSelectionRange(inserted.caret, inserted.caret);
  }

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
  // The questions take the composer's place, and a recording stops with it;
  // the dock on the file has no questions.
  const voice = useVoiceInput(
    workspaceId,
    insertVoice,
    (!!dock && !pageOpen) || questions.length === 0
  );

  // Seed local state when a saved conversation opens: cached history paints at
  // once, then this open's refetch seeds it again once and decides whether a
  // running answer is followed. Later refetches (after a turn) leave it alone.
  useEffect(() => {
    if (!(selectId && history)) return;
    // A fetch paused offline or failed leaves the cached history painted,
    // never followed.
    const current = historyFetchStatus === 'idle' && !historyError;
    if (!seedsAgain(hydratedRef.current, selectId, current)) return;
    hydratedRef.current = { current, id: selectId };
    hydrate(selectId, history.map(toChatMessage), current);
  }, [selectId, history, historyFetchStatus, historyError, hydrate]);

  // The shown conversation is kept while the panel is mounted: leaving the
  // page forgets it, a reload or a closed tab does not.
  const shownId = selectId ?? conversationId;
  useEffect(() => {
    const key = PREF_KEYS.openChat(workspaceId);
    if (shownId) writePref(key, shownId);
    else removePref(key);
  }, [shownId, workspaceId]);
  useEffect(
    () => () => removePref(PREF_KEYS.openChat(workspaceId)),
    [workspaceId]
  );

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
    void send(trimmed, chatTurn(workspaceOnly, openResource));
  }

  function openNew() {
    hydratedRef.current = null;
    setSelectId(null);
    startNew();
  }
  // A kept conversation that is gone (deleted, archived away) opens a new
  // chat; a requested one shows it is missing.
  const forgetGone = useEffectEvent(() => {
    if (
      selectId === restoredId &&
      isApiError(historyError) &&
      historyError.status === 404
    )
      openNew();
  });
  useEffect(() => forgetGone(), [historyError]);
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
    else {
      openNew();
      if (next.prompt && !sentPrompts.has(next)) {
        sentPrompts.add(next);
        void send(next.prompt, chatTurn(workspaceOnly, openResource));
      }
    }
    if (focusOnOpen) fieldRef.current?.focus({ preventScroll: true });
  });
  useEffect(() => {
    if (request) followRequest(request);
  }, [request]);
  const shown = messages.length > 0;
  useEffect(() => {
    onActiveChange?.(conversationId, shown);
  }, [conversationId, shown, onActiveChange]);

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
      void send(trimmed, chatTurn(workspaceOnly, openResource));
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
    disabled: !shown,
    icon: 'newChat',
    label: m.chat_new(),
    onClick: openNew,
  };
  const title =
    conversations?.find((c) => c.id === conversationId)?.title ||
    m.chat_untitled();
  // The sources switch's narrow side: the workspace's files, or in the
  // account chat the user's own (Epo D4).
  const onlyLabel = workspaceId
    ? m.chat_workspace_only()
    : m.chat_your_files_only();
  const onlyHint = workspaceId
    ? m.chat_workspace_only_hint()
    : m.chat_your_files_only_hint();

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
        className={cn(
          'scroll-fade-y flex flex-1 flex-col gap-4 self-stretch overflow-auto py-4 [--scroll-fade-bottom-padding:--spacing(4)]',
          // Filling the page, the column stays 48rem wide in the middle.
          fill ? 'px-[max(--spacing(4),calc(50%_-_24rem))]' : 'px-4'
        )}
        ref={scrollRef}
      >
        {!messages.length && opening && (
          <SkeletonList className="mt-auto" count={3} rowHeight={56} />
        )}
        {!(messages.length || opening) && (
          <div className="m-auto max-w-[80%] text-center">
            <Icon
              className="non-scaling-svg mx-auto mb-2 size-6.5"
              name="message"
            />
            {missingThread ? (
              <>
                <p className="font-medium">{m.error_not_found_title()}</p>
                <p>{m.error_not_found_body()}</p>
              </>
            ) : (
              <p>{m.chat_empty()}</p>
            )}
          </div>
        )}
        {pendingSources?.omitted && (
          <div
            className="rounded-lg border border-line bg-surface p-3 text-sm"
            role="status"
          >
            <p>{m.source_pending_context()}</p>
            {canReprocess && workspaceId && (
              <ProcessChangesButton
                fileIds={pendingSources.fileIds}
                workspaceId={workspaceId}
              />
            )}
          </div>
        )}
        {messages.map((msg, index) =>
          msg.role === 'user' ? (
            <div
              className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-tile rounded-tr-sm bg-page frosted:bg-(--frost-fill) px-3.5 py-2.5"
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

      <div
        className={cn(
          'grow-0 p-3',
          // In line with the thread's 48rem column, past the 12px padding.
          fill && 'mx-auto w-full max-w-[49.5rem]'
        )}
      >
        {questions.length > 0 && last ? (
          <QuestionBlock
            disabled={streaming}
            key={last.id}
            onDismiss={() => setDismissedId(last.id)}
            onSend={(answer) =>
              void send(answer, chatTurn(workspaceOnly, openResource))
            }
            questions={questions}
          />
        ) : (
          <>
            {/* One row: the field grows upward and the buttons stay on its
                last line. A recording's waveform and time take the field's
                place; it stays mounted so the transcript lands at its caret. */}
            <div className="flex items-end gap-2 rounded-input border border-line bg-surface frosted:bg-(--frost-fill) py-1 pr-1 pl-3 transition-colors focus-within:border-action-accent has-[textarea[aria-invalid=true]]:border-solid-error has-[textarea[aria-invalid=true]]:transition-none">
              {voice.phase === 'recording' && (
                <VoiceElapsed
                  analyser={voice.analyser}
                  className="h-9 flex-1"
                  elapsedMs={voice.elapsedMs}
                />
              )}
              <Textarea
                aria-invalid={overLimit || undefined}
                aria-label={m.chat_placeholder()}
                className={cn(
                  // A line is as tall as the buttons; 16px on phones, which
                  // zoom the page into smaller fields.
                  'max-h-[calc(7lh+--spacing(4))] min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-2 text-fg leading-5 focus:border-0 max-sm:text-base',
                  voice.phase === 'recording' && 'hidden'
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
                ref={fieldRef}
                rows={1}
                value={text}
              />
              {/* Mic and Send touch: each icon's own box keeps them apart. */}
              <span className="flex h-9 shrink-0 items-center">
                <CharCount
                  className="mr-1"
                  max={CHAT_CHARACTER_LIMIT}
                  value={textLength(text)}
                />
                {voice.supported && (
                  <VoiceButton
                    className="size-9 rounded-lg"
                    onToggle={voice.toggle}
                    phase={voice.phase}
                  />
                )}
                <IconButton
                  className="size-9 rounded-lg"
                  disabled={!(streaming || (text.trim() && !overLimit))}
                  icon="send"
                  // An outlined plane: grey until there is something to send.
                  iconClassName={cn(
                    'transition-[opacity,filter,scale] duration-(--motion-duration-fast) ease-(--motion-ease-in-out) motion-reduce:transition-none',
                    text.trim() ? 'text-send' : 'text-fg-muted',
                    streaming
                      ? 'scale-25 opacity-0 blur-[2px]'
                      : 'scale-100 opacity-100 blur-none'
                  )}
                  label={streaming ? m.chat_stop() : m.chat_send()}
                  onClick={streaming ? stop : submit}
                  size="toolbar"
                  variant="ghost-hover"
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
                    <span className="size-3 rounded-[3px] bg-action-accent" />
                  </span>
                </IconButton>
              </span>
            </div>
            {voice.error && (
              <p
                className="mt-2 px-1 text-sm text-tint-error-fg"
                data-error-surface="inline"
                role="alert"
              >
                {voice.error}
              </p>
            )}
          </>
        )}
        {/* The scope in use, switched from a menu; the ghost padding is
            pulled back so its text lines up with the field's. */}
        <div className="mt-1 flex items-center pl-[5px]">
          <Menu
            align="start"
            className="w-72"
            itemClassName="whitespace-normal text-left"
            items={[
              {
                checked: !workspaceOnly,
                description: m.chat_grounded_outside(),
                label: m.chat_all_sources(),
                onClick: () => setWorkspaceOnly(false),
              },
              {
                checked: workspaceOnly,
                description: onlyHint,
                label: onlyLabel,
                onClick: () => setWorkspaceOnly(true),
              },
            ]}
            side="top"
            trigger={
              <Button
                className="h-7.5 gap-0.5 rounded-button px-2 font-semibold text-[13px] text-fg-secondary"
                size="sm"
                variant="ghost-hover"
              >
                {workspaceOnly ? onlyLabel : m.chat_all_sources()}
                <Icon
                  className="size-3.5 -translate-y-px text-fg-muted"
                  name="chevronDown"
                />
              </Button>
            }
          />
          <Popover>
            <PopoverTrigger asChild>
              <IconButton
                className="-ml-1 -translate-y-px rounded-full text-fg-muted [&>svg]:size-3.5"
                icon="info"
                label={m.chat_scope_info_label()}
                size="xs"
                variant="ghost-hover"
              />
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="t-meta text-fg-secondary"
              side="top"
            >
              {workspaceOnly ? onlyHint : m.chat_grounded_outside()}
            </PopoverContent>
          </Popover>
        </div>
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
          fieldRef={dockFieldRef}
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
          voice={voice}
        />
      )}
    </div>
  );
}
