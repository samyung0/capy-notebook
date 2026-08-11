import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import { useConversations, useMessages } from '@/api/hooks';
import type { ChatMessage, Citation, UserColor } from '@/api/types';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Menu } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { userColorPairDark } from '@/lib/userColor';
import { toChatMessage, useChatStream } from './useChatStream';

/** Page label for a citation, absent for sources with no page model (txt/md,
 * and PDFs parsed in the lightweight 'normal' mode). */
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
  onOpen?: (fileId: string, page?: number) => void;
}) {
  // TODO: highlight the cited region on the page — the bbox is already stored
  // on each citation, only the overlay is missing.
  if (!msg.citations?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {msg.citations.map((c, i) => {
        const page = pageLabel(c);
        return (
          <button
            className="inline-flex items-center gap-1 rounded-full bg-tint-info px-2 py-0.5 font-medium text-[11px] text-tint-info-fg hover:brightness-97"
            key={`${c.fileId}:${i}`}
            onClick={() => onOpen?.(c.fileId, c.pageStart ?? undefined)}
            title={c.snippet}
            type="button"
          >
            <Icon name="files" size={12} /> {c.fileName}
            {page && <span className="opacity-70">{page}</span>}
          </button>
        );
      })}
    </div>
  );
}

function AssistantBubble({
  msg,
  streaming,
  onOpenCitation,
}: {
  msg: ChatMessage;
  streaming: boolean;
  onOpenCitation?: (fileId: string, page?: number) => void;
}) {
  const empty = !msg.content;
  return (
    <div className="mr-auto max-w-[92%] px-3.5 py-2.5">
      {empty && streaming && msg.status === 'streaming' ? (
        <Spinner />
      ) : (
        <div className="streamdown-body max-w-none [&_p]:my-1.5 [&_pre]:my-2">
          <Streamdown
            className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            components={{
              ol: ({ children }) => (
                <ol className="ml-4 list-outside list-decimal whitespace-normal">
                  {children}
                </ol>
              ),
              ul: ({ children }) => (
                <ul className="ml-4 list-outside list-disc whitespace-normal">
                  {children}
                </ul>
              ),
            }}
          >
            {msg.content}
          </Streamdown>
        </div>
      )}
      {msg.status === 'aborted' && (
        <p className="mt-1 py-1 text-fg-muted italic">Stopped.</p>
      )}
      {msg.status === 'error' && (
        <div
          className="mt-2 rounded-card border border-tint-error bg-tint-error px-3 py-2 text-sm text-solid-error"
          role="alert"
        >
          <p className="font-medium">The response was interrupted.</p>
          <p>Check your connection and send your message again.</p>
        </div>
      )}
      <Citations msg={msg} onOpen={onOpenCitation} />
    </div>
  );
}

export function ChatPanel({
  workspaceId,
  color,
  onOpenCitation,
}: {
  workspaceId: string;
  color?: UserColor;
  /** Opens a cited source in the center pane, scrolled to the cited page. */
  onOpenCitation?: (fileId: string, page?: number) => void;
}) {
  const { messages, conversationId, streaming, send, stop, startNew, hydrate } =
    useChatStream(workspaceId);
  const { data: conversations } = useConversations(workspaceId, {
    errorBoundary: false,
  });
  // TODO: add time stamp for convos (last chat), show timestamp and action menu in chat history dropdown items

  const [text, setText] = useState('');
  const [selectId, setSelectId] = useState<string | null>(null);
  const { data: history } = useMessages(selectId, { errorBoundary: false });
  const hydratedRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const lightPair = userColorPairDark(color);

  // Seed local state when a previously-saved conversation is opened.
  useEffect(() => {
    if (selectId && history && hydratedRef.current !== selectId) {
      hydratedRef.current = selectId;
      hydrate(selectId, history.map(toChatMessage));
    }
  }, [selectId, history, hydrate]);

  // Keep the newest message in view as tokens stream in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    setText('');
    void send(trimmed);
  }

  function openNew() {
    hydratedRef.current = null;
    setSelectId(null);
    startNew();
  }

  return (
    <div
      className="flex h-full flex-col"
      style={
        {
          '--temp-btn-bg': lightPair.bg,
          '--temp-btn-fg': lightPair.fg,
        } as React.CSSProperties
      }
    >
      <div className="flex items-center justify-end pt-1.5 pb-3 pl-3">
        <div className="flex grow-0 items-center">
          {/* TODO: change chat history/details to dialog for better visibility/responsiveness */}
          {/* TODO: add action menu to the side inside of history item and let user edit name/delete */}
          <Menu
            align="start"
            items={
              conversations?.length
                ? conversations.map((c) => ({
                    icon: 'message' as const,
                    label: c.title || 'Untitled chat',
                    onClick: () => {
                      hydratedRef.current = null;
                      setSelectId(c.id);
                    },
                  }))
                : [{ disabled: true, label: 'No conversations yet' }]
            }
            trigger={
              <IconButton
                className="translate-x-px rounded-r-none bg-(--temp-btn-bg) py-1.5 pl-3.5 text-(--temp-btn-fg) hover:bg-(--temp-btn-bg) hover:brightness-97 disabled:opacity-30"
                icon="clock"
                label="Open history"
                size="sm"
                strokeWidth={1.5}
                variant="accent-light"
              />
            }
          />
          <IconButton
            className="rounded-r-none rounded-l-none bg-(--temp-btn-bg) py-1.5 pr-2.5 text-(--temp-btn-fg) hover:bg-(--temp-btn-bg) hover:brightness-97 disabled:opacity-30"
            disabled={!conversationId}
            icon="plus"
            label="New chat"
            onClick={openNew}
            size="sm"
            strokeWidth={1.5}
            variant="accent-light"
          />
        </div>
      </div>

      <div
        className="flex flex-1 flex-col gap-4 self-stretch overflow-auto p-4"
        ref={scrollRef}
      >
        {!messages.length && (
          <div className="m-auto max-w-[80%] text-center">
            <Icon className="mx-auto mb-2 size-6.5" name="message" />
            <p>Ask anything about your sources.</p>
          </div>
        )}
        {messages.map((msg) =>
          msg.role === 'user' ? (
            <div
              className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-tr-sm bg-page px-3.5 py-2.5"
              key={msg.id}
            >
              {msg.content}
            </div>
          ) : (
            <AssistantBubble
              key={msg.id}
              msg={msg}
              onOpenCitation={onOpenCitation}
              streaming={streaming}
            />
          )
        )}
      </div>

      <div className="grow-0 p-3">
        {/* TODO: use form? */}
        <Input
          actionCallback={streaming ? stop : submit}
          actionClassName="bg-(--temp-btn-bg) text-(--temp-btn-fg) hover:bg-(--temp-btn-bg) hover:opacity-85"
          actionIcon={streaming ? 'x' : 'send'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={m.chat_placeholder()}
          size="lg"
          value={text}
          // className="min-w-0 flex-1 border-none bg-transparent text-sm text-fg outline-none placeholder:text-placeholder"
        />
        {/* TODO: update workdings to sth like answer generated may not be accurate etc  */}
        <p className="mt-2 text-center text-[11px] text-fg-muted">
          {m.chat_grounded()}
        </p>
      </div>
    </div>
  );
}
