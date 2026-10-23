import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Textarea } from '@/components/ui/TextArea';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { ChatBubbleIcon } from './ChatBubbleIcon';
import { VoiceButton, VoiceElapsed, type VoiceInput } from './VoiceInput';

/** The chat dock and the chat page share this name, so a view transition
 * grows one into the other. */
export const CHAT_DOCK_TRANSITION = '[view-transition-name:chat-dock]';

/** Runs a state change as a view transition where the browser has them. */
export function withViewTransition(update: () => void) {
  if (
    !document.startViewTransition ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}

const BUTTON = 52;
// Scrolls this soon after a focus or a keyboard resize are the browser
// making room, not the reader.
const SETTLE_MS = 600;

/**
 * Chat on the file page below lg. Below md, and on Office files at any width,
 * a round button morphs into a one-line field; from md the field shows itself. Focusing the field leaves the page
 * as it is (the keyboard overlays it, see useKeyboardHeight); sending is the
 * caller's (it opens the chat page). Voice input is the composer's own
 * (useVoiceInput in ChatPanel): its button sits left of Send, its elapsed time
 * or error on a line above the field, and the field stays open while a
 * recording runs or is transcribed.
 */
export function ChatDock({
  text,
  onTextChange,
  onSend,
  sendDisabled,
  overLimit,
  office,
  back,
  onOpenHistory,
  fieldRef,
  voice,
}: {
  text: string;
  onTextChange: (text: string) => void;
  onSend: () => void;
  sendDisabled: boolean;
  overLimit: boolean;
  /** Office files keep their bottom chrome clear: the button floats above it. */
  office: boolean;
  /** After leaving a conversation: returns to it, or closes. */
  back?: { title: string; onOpen: () => void; onClose: () => void };
  /** Opens the chat page with its history. */
  onOpenHistory: () => void;
  /** The dock's field, which a transcript is inserted into at its caret. */
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  voice: VoiceInput;
}) {
  const md = useMediaQuery('(min-width: 768px)');
  const fieldOnly = md && !office;
  const voiceBusy = voice.phase !== 'idle';
  // A recording started on the chat page keeps the field open here.
  const [expanded, setExpanded] = useState(voiceBusy);
  const open = fieldOnly || expanded;
  const draft = text.trim().length > 0;
  const rowRef = useRef<HTMLDivElement>(null);
  const settledAt = useRef(0);
  const [size, setSize] = useState({ height: BUTTON, width: BUTTON });

  // The field lays out at the row's full width even while the surface is a
  // button, so its height is known before it opens.
  const fieldBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const field = fieldBox.current;
    if (!(row && field)) return;
    let height: number | undefined;
    const measure = () => {
      // The field lays out at --dock-width, which starts at the button's 52px:
      // set the real width before reading, or the first read wraps the
      // placeholder and the dock mounts several lines tall. The fix-up would
      // wait for the next ResizeObserver frame, which a view transition holds
      // back (returning from the chat page).
      const width = row.offsetWidth;
      row.style.setProperty('--dock-width', `${width}px`);
      const next = field.offsetHeight;
      // A line added or removed while open: the text starts where it was and
      // slides with the surface's height transition instead of jumping. Runs
      // before paint, so the jump is never drawn.
      const delta = height === undefined ? 0 : next - height;
      height = next;
      if (delta && field.closest('[data-open=true]'))
        fieldRef.current?.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: 'none' }],
          { duration: 350, easing: 'cubic-bezier(0.34, 1.25, 0.64, 1)' }
        );
      setSize({ height, width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const settle = () => {
      settledAt.current = performance.now() + SETTLE_MS;
    };
    viewport.addEventListener('resize', settle);
    return () => viewport.removeEventListener('resize', settle);
  }, []);

  // Scrolling the page either way folds the field into the button, focused or
  // not; a draft stays and shows as the button's dot. Positions are tracked
  // from mount, so the first scroll after opening already has a distance.
  const folds = !fieldOnly && expanded && !voiceBusy;
  const foldsRef = useRef(folds);
  foldsRef.current = folds;
  useEffect(() => {
    const last = new WeakMap<Element, number>();
    const onScroll = (event: Event) => {
      const scroller = event.target;
      if (!(scroller instanceof Element) || rowRef.current?.contains(scroller))
        return;
      const top = scroller.scrollTop;
      const previous = last.get(scroller) ?? top;
      last.set(scroller, top);
      if (!foldsRef.current || performance.now() < settledAt.current) return;
      if (Math.abs(top - previous) > 4) {
        fieldRef.current?.blur();
        setExpanded(false);
      }
    };
    document.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);

  function expand() {
    // Synchronous, so the focus below still counts as the tap's own and the
    // phone opens its keyboard.
    flushSync(() => setExpanded(true));
    fieldRef.current?.focus();
  }

  return (
    <div
      className="motion-chat-dock-row pointer-events-none absolute inset-x-4 bottom-4 data-[office=true]:bottom-[calc(var(--office-inset)+8px)] data-[open=true]:bottom-[calc(--spacing(4)+var(--keyboard-inset,0px))]"
      // The open field keeps the button's gap from the screen's edge on every
      // file, lifted above the keyboard that covers the page; only the button
      // rises above an Office file's bottom chrome. Folding drops the lift at
      // once rather than when the closing keyboard reports its height, so the
      // dock moves down while it narrows, not after.
      data-keyboard-overlay
      data-office={office && !open}
      data-open={open}
      data-workspace-chat-dock
    >
      <div
        className={cn(
          'motion-chat-dock-height relative',
          fieldOnly && 'mx-auto max-w-xl'
        )}
        data-open={open}
        ref={rowRef}
        style={
          {
            '--dock-height': `${size.height}px`,
            '--dock-width': `${size.width}px`,
          } as CSSProperties
        }
      >
        {back && (
          <div
            className={cn(
              'pointer-events-auto absolute left-0 flex h-9 min-w-40 items-center rounded-button bg-overlay pl-1 shadow-pop ring-1 ring-overlay-line',
              open
                ? 'bottom-[calc(100%+8px)] max-w-[min(18rem,100%)]'
                : 'bottom-2 max-w-[min(18rem,calc(100%-60px))]'
            )}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-2 px-2 font-semibold text-sm text-tint-accent-1-fg"
              onClick={back.onOpen}
              type="button"
            >
              <Icon className="shrink-0" name="navigationBack" size={16} />
              <span className="truncate">{back.title}</span>
            </button>
            <ToolbarButton label={m.action_close()} onClick={back.onClose}>
              <Icon name="x" />
            </ToolbarButton>
          </div>
        )}
        <div
          className={cn(
            'motion-chat-dock pointer-events-auto absolute right-0 bottom-0 h-full overflow-hidden shadow-pop ring-1 ring-overlay-line focus-within:ring-action-accent',
            CHAT_DOCK_TRANSITION
          )}
          data-open={open}
          // Focus anywhere in the field (text, history, send) keeps it open,
          // so Tab reaches its buttons.
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            if (!(fieldOnly || draft || voiceBusy)) setExpanded(false);
          }}
          onFocus={() => {
            settledAt.current = performance.now() + SETTLE_MS;
          }}
        >
          {!fieldOnly && (
            <button
              aria-label={m.workspace_tab_chat()}
              // The purple circle is the surface's own (motion-chat-dock), so it
              // turns into the field instead of fading over it.
              className="absolute right-0 bottom-0 grid size-13 place-items-center rounded-full"
              data-chat-dock-trigger
              data-workspace-chat-button
              inert={open}
              onClick={expand}
              type="button"
            >
              <ChatBubbleIcon />
              {draft && (
                <span className="absolute top-2.5 right-2.5 size-2.5 rounded-full bg-white ring-2 ring-[#3f3188]" />
              )}
            </button>
          )}
          <div
            className="absolute right-0 bottom-0 w-(--dock-width) p-1.5"
            data-chat-dock-field
            inert={!open}
            ref={fieldBox}
          >
            {/* A line of its own above the row, inside the measured box so
                the surface grows to show it: beside the buttons, the time
                would squeeze a phone's field to a few words a line. */}
            {voice.phase === 'recording' ? (
              <div className="flex px-2 pt-1">
                <VoiceElapsed elapsedMs={voice.elapsedMs} />
              </div>
            ) : (
              voice.error && (
                <p
                  className="px-2 pt-1 pb-0.5 text-sm text-tint-error-fg"
                  data-error-surface="inline"
                  role="alert"
                >
                  {voice.error}
                </p>
              )
            )}
            <div className="flex items-end gap-1">
              <IconButton
                className="-translate-y-px p-2.5 text-fg-muted"
                icon="clock"
                label={m.chat_history()}
                onClick={onOpenHistory}
                onMouseDown={(event) => event.preventDefault()}
                size="sm"
                variant="ghost-hover"
              />
              {/* 16px text: phones zoom the page into smaller fields. */}
              <Textarea
                aria-invalid={overLimit || undefined}
                aria-label={m.chat_placeholder()}
                className="max-h-[calc(4lh+--spacing(4))] min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-2 text-base/[22px] text-fg focus:border-0"
                onChange={(event) => onTextChange(event.target.value)}
                placeholder={m.chat_placeholder()}
                ref={fieldRef}
                rows={1}
                value={text}
              />
              {voice.supported && (
                <VoiceButton
                  elapsed={false}
                  elapsedMs={voice.elapsedMs}
                  // Keeps the field focused through the tap, as Send does.
                  onMouseDown={(event) => event.preventDefault()}
                  onToggle={voice.toggle}
                  phase={voice.phase}
                />
              )}
              <IconButton
                className="p-2.5"
                disabled={sendDisabled}
                icon="send"
                label={m.chat_send()}
                onClick={onSend}
                // Keeps the field focused through the tap, so its blur cannot
                // fold the dock before the send lands.
                onMouseDown={(event) => event.preventDefault()}
                size="sm"
                variant="accent"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
