import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { SimpleDialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import { mountDrawingBoard } from '@/features/blocksuite/drawingBoard';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { errorCopy } from '@/lib/errors';
import {
  deleteLocalDrawingDraft,
  localDrawingDraft,
  saveLocalDrawingDraft,
} from '@/lib/localDb';
import {
  DRAWING_BOARD_MAX,
  type DrawingValue,
  holdOpenDrawing,
} from './drawingValue';

type Board = ReturnType<typeof mountDrawingBoard>;

/** The question pinned over the board: its title, marks, first words (a
 * phone's folded line) and text. */
export type PinnedQuestion = {
  body: ReactNode;
  marks: string;
  /** The number and label alone ("1 (a)"), before a phone's folded line. */
  short: string;
  summary: string;
  title: string;
};

const DRAFT_DELAY_MS = 800;
const PHONE_WIDTH = 768;
/** Past this many board units on its longest side, the 1,568 px marking image
 * loses lowercase labels (bench/grading 2026-11-06), so Done asks first (W1,
 * Epo 2026-11-07). */
const WIDE_BOARD_SPAN = 2000;

/** The first fit's room, [top, right, bottom, left]: clear of the pinned
 * question (340px at 16px in) and Done, and of the toolbar when drawing. */
const fitPadding = (readOnly: boolean): [number, number, number, number] => {
  const bottom = readOnly ? 16 : 130;
  return window.innerWidth < PHONE_WIDTH
    ? [72, 12, readOnly ? 12 : 96, 12]
    : [72, 40, bottom, 372];
};

const readAsDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** A board's chrome is hidden while one of its cards (a plane, a chart) is open
 * full screen with its own Done. */
const UNDER_CARD =
  '[.answer-board:has(.capy-board[data-editor-open])_&]:hidden';

/**
 * A drawing answer's board, full screen (Epo 2026-11-03, boards B1, P2, P3): the
 * question pinned at the top left, folded to one line on a phone, and Done at the
 * top right. Taking an answer, the board is kept on this device as it changes
 * (`draft`) and Done hands back its document and marking image, or null for an
 * empty board; read only, Done is Close.
 */
export default function DrawingBoardScreen({
  draft,
  onClose,
  onDone,
  pinned,
  readOnly = false,
  saved,
  store,
}: {
  /** The device key a board being drawn is kept under, when the page has one. */
  draft?: string;
  onClose: () => void;
  onDone?: (value: DrawingValue | null) => void;
  /** An assignment's Done stores the drawing before the board closes, or
   * forgets it when emptied (null); a refusal (too big, storage full, offline)
   * keeps it open with nothing lost. */
  store?: (value: DrawingValue | null) => Promise<string | null>;
  pinned: PinnedQuestion;
  readOnly?: boolean;
  saved?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  // The board mounts once; closing reads the latest handler.
  const close = useRef(onClose);
  close.current = onClose;
  const phoneDone = useRef<HTMLButtonElement>(null);
  const board = useRef<Board | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  // Desktop shows the question until hidden; a phone folds it to one line.
  const [shown, setShown] = useState(true);
  const [unfolded, setUnfolded] = useState(false);
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const keep = () => {
      if (!draft) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const current = board.current;
        if (!current) return;
        saveLocalDrawingDraft({
          doc: current.snapshot(),
          key: draft,
          savedAt: new Date().toISOString(),
        }).catch(() => {
          // A browser without IndexedDB keeps the board on the page only.
        });
      }, DRAFT_DELAY_MS);
    };
    (async () => {
      // A board drawn and not sent with Done is picked up where it was left.
      const kept =
        draft && !readOnly
          ? await localDrawingDraft(draft).catch(() => undefined)
          : undefined;
      if (cancelled) return;
      try {
        board.current = mountDrawingBoard(element, {
          // Where to draw (W3, W4); a read-only board draws none.
          answerArea: { label: m.drawing_answer_area() },
          fitPadding: fitPadding(readOnly),
          onChange: readOnly ? undefined : keep,
          readOnly,
          saved: kept?.doc ?? saved,
        });
        setReady(true);
      } catch (error) {
        userToast({
          description: errorCopy(error, m.drawing_answer_open_failed()),
          title: m.drawing_answer_open_failed(),
          variant: 'error',
        });
        close.current();
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      board.current?.unmount();
      board.current = null;
    };
  }, [draft, readOnly, saved]);

  // On a phone the board's undo and redo sit left of Done (drawingBoard.css),
  // both 8px from the top and the edge.
  useEffect(() => {
    const width = phoneDone.current?.offsetWidth ?? 0;
    host.current?.style.setProperty(
      '--capy-board-done-width',
      `${width + 8}px`
    );
  }, []);

  /** Done; `anyway` skips the wide-board question (Done anyway, a time limit). */
  const finish = async (anyway = false) => {
    const current = board.current;
    if (!current || busy) return;
    if (readOnly || !onDone) return onClose();
    const stats = current.stats();
    const empty = stats.canvas.length === 0 && stats.blocks.length === 0;
    if (!empty && !anyway && stats.span > WIDE_BOARD_SPAN) {
      setWide(true);
      return;
    }
    const saved = empty ? null : current.save();
    if (saved && saved.bytes > DRAWING_BOARD_MAX) {
      userToast({ title: m.drawing_answer_too_big(), variant: 'error' });
      return;
    }
    setBusy(true);
    try {
      let value: DrawingValue | null = null;
      if (saved) {
        value = {
          board: saved.doc,
          image: await readAsDataUrl(await current.toImage()),
        };
        if (store) value.drawing = (await store(value)) ?? undefined;
      } else if (store) await store(null);
      if (draft) await deleteLocalDrawingDraft(draft).catch(() => undefined);
      onDone(value);
    } catch (error) {
      userToast({
        description: errorCopy(error, m.drawing_answer_capture_failed()),
        title: m.drawing_answer_capture_failed(),
        variant: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  // A time limit running out presses Done here (finishOpenDrawing), asking nothing.
  const latestFinish = useRef(finish);
  latestFinish.current = finish;
  useEffect(() => {
    if (readOnly || !onDone) return;
    return holdOpenDrawing(() => latestFinish.current(true));
  }, [onDone, readOnly]);

  const doneButton = (ref?: React.Ref<HTMLButtonElement>) => (
    <Button
      className={UNDER_CARD}
      disabled={!ready || busy}
      onClick={() => finish()}
      ref={ref}
      variant={readOnly ? 'outline' : 'dark'}
    >
      {busy && <Spinner className="size-4" />}
      {readOnly ? m.action_close() : m.drawing_board_done()}
    </Button>
  );

  return createPortal(
    <div
      aria-label={pinned.title}
      aria-modal="true"
      className="answer-board fixed inset-0 z-50 bg-canvas"
      role="dialog"
    >
      <div className="absolute inset-0 [&>div]:h-full" ref={host} />
      {!ready && (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner />
        </div>
      )}
      {/* Phones: one line under a top bar, unfolding over the board (P2, P3). */}
      <div
        className={cn(
          'absolute inset-x-0 top-0 flex items-center gap-2 px-2 pt-2 md:hidden',
          UNDER_CARD
        )}
      >
        <button
          aria-expanded={unfolded}
          className="flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-input border border-line bg-surface px-2.5 text-left"
          onClick={() => setUnfolded((open) => !open)}
          type="button"
        >
          <b className="shrink-0 leading-normal">{pinned.short}</b>
          <span className="min-w-0 flex-1 truncate leading-normal">
            {pinned.summary}
          </span>
          <Icon name={unfolded ? 'chevronUp' : 'chevronDown'} size={18} />
        </button>
        {/* Room for the board's two 40px undo and redo buttons, then Done. */}
        <span className="w-20 shrink-0" />
        {doneButton(phoneDone)}
      </div>
      {unfolded && (
        <aside
          aria-label={pinned.title}
          className={cn(
            'absolute inset-x-2 top-14 flex max-h-[60dvh] flex-col gap-2 overflow-y-auto rounded-card border border-line bg-surface p-3.5 shadow-sm md:hidden',
            UNDER_CARD
          )}
        >
          <PinnedHead marks={pinned.marks} title={pinned.title} />
          {pinned.body}
        </aside>
      )}
      {/* Wider screens: the card at the top left, hidden to a chip. */}
      <aside
        aria-label={pinned.title}
        className={cn(
          'absolute top-4 left-4 hidden max-h-[calc(100dvh-180px)] w-[340px] flex-col gap-2 overflow-y-auto rounded-card border border-line bg-surface p-3.5 shadow-sm md:flex',
          !shown && 'w-auto',
          UNDER_CARD
        )}
      >
        <PinnedHead
          marks={pinned.marks}
          onToggle={() => setShown((open) => !open)}
          shown={shown}
          title={pinned.title}
        />
        {shown && pinned.body}
      </aside>
      <div className={cn('absolute top-4 right-4 hidden md:block', UNDER_CARD)}>
        {doneButton()}
      </div>
      <SimpleDialog
        footer={
          <>
            <Button
              onClick={() => {
                setWide(false);
                finish(true);
              }}
              size="lg"
              variant="outline"
            >
              {m.drawing_wide_done_anyway()}
            </Button>
            <Button
              autoFocus
              onClick={() => setWide(false)}
              size="lg"
              variant="dark"
            >
              {m.drawing_wide_keep()}
            </Button>
          </>
        }
        onClose={() => setWide(false)}
        // Phones keep their header close; wider screens have the two buttons only (W1).
        onCloseClick={() => setWide(false)}
        open={wide}
        showCloseButton={false}
        title={m.drawing_wide_title()}
      >
        <p className="text-[0.9375rem] sm:text-base">{m.drawing_wide_body()}</p>
      </SimpleDialog>
    </div>,
    document.body
  );
}

function PinnedHead({
  marks,
  onToggle,
  shown = true,
  title,
}: {
  marks: string;
  onToggle?: () => void;
  shown?: boolean;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <b>{title}</b>
      <span className="t-meta text-fg-muted">{marks}</span>
      {onToggle && (
        <button
          aria-label={
            shown
              ? m.drawing_answer_hide_question()
              : m.drawing_answer_show_question()
          }
          className="-my-1 ml-auto grid size-8 cursor-pointer place-items-center rounded-input hover:bg-surface-hover-bg"
          onClick={onToggle}
          type="button"
        >
          <Icon name={shown ? 'minus' : 'plus'} size={18} />
        </button>
      )}
    </div>
  );
}
