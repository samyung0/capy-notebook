import { type ReactNode, useEffect, useState } from 'react';
import { isApiError } from '@/api/client';
import { useUndoEdit } from '@/api/hooks';
import type {
  ChatMessage,
  ChatSteps,
  Citation,
  MaterialRefType,
  ResourceEffect,
  ResourceRef,
  UndoRef,
} from '@/api/types';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { toolErrorMessage } from '../toolErrorMessage';
import { ActivityIcon } from './ActivityIcon';
import { LangAnswer } from './LangAnswer';
import {
  type ActivityIconKind,
  buildTrace,
  foldSegments,
  foldTrace,
  groupTitle,
  latestStep,
  type StepState,
  stepTitle,
  THINKING_DELAY_MS,
  type ToolBlock,
  type TraceRow,
  toolIcon,
  undoAction,
} from './trace';

type Undoable = ResourceEffect & { undo: UndoRef };

/** What a receipt calls back with once the server answers its Undo or Redo. */
export interface UndoHandlers {
  onOpenResource?: (ref: ResourceRef) => void;
  /** The receipt's effect replaces the one its undo ref came from. */
  onUndoApplied: (operationId: string, effect: ResourceEffect) => void;
  /** A refused step: the button stays disabled for this session. */
  onUndoRefused: (effect: Undoable) => void;
}

const MATERIAL_KINDS = new Set<string>([
  'note',
  'quiz',
  'flashcards',
  'mindmap',
  'diagram',
]);
const materialKind = (kind?: string) =>
  kind && MATERIAL_KINDS.has(kind) ? (kind as MaterialRefType) : undefined;

function useDelayed(on: boolean, ms: number) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), ms);
    return () => window.clearTimeout(timer);
  }, [on, ms]);
  return on && shown;
}

/** A row sentence with its label (file, query, page) emphasised. */
function Title({ text, label }: { text: string; label?: string }) {
  const at = label ? text.indexOf(label) : -1;
  return (
    <span className="min-w-0 truncate">
      {at < 0 || !label ? (
        text
      ) : (
        <>
          {text.slice(0, at)}
          <span className="font-medium text-fg-secondary group-data-[state=failed]/row:text-inherit">
            {label}
          </span>
          {text.slice(at + label.length)}
        </>
      )}
    </span>
  );
}

const ROW =
  'group/row flex w-fit min-w-0 max-w-full items-center gap-2 text-fg-muted text-sm data-[state=failed]:text-tint-error-fg';

function StepRow({ tool, state }: { tool: ToolBlock; state: StepState }) {
  const title = stepTitle(tool, state);
  const failed = state === 'failed';
  return (
    <div className="min-w-0">
      <div className={ROW} data-state={state}>
        {failed ? (
          <ActivityIcon kind="alert" />
        ) : state === 'unknown' ? (
          <ActivityIcon kind="unknown" />
        ) : state === 'stopped' ? (
          <ActivityIcon kind="stop" />
        ) : (
          <ActivityIcon
            kind={toolIcon(tool.name)}
            running={state === 'running'}
          />
        )}
        <Title label={title.label} text={title.text} />
      </div>
      {failed || state === 'unknown' ? (
        <p
          className={cn(
            'mt-0.5 ml-6.5 text-[13px]',
            failed ? 'text-tint-error-fg' : 'text-fg-muted'
          )}
        >
          {toolErrorMessage(tool.error ?? (failed ? undefined : UNKNOWN_ERROR))}
        </p>
      ) : null}
    </div>
  );
}

const UNKNOWN_ERROR = { code: 'outcome_unknown', message: '' };

function ThinkingRow({
  running,
  seconds,
}: {
  running: boolean;
  seconds?: number;
}) {
  return (
    <div className={ROW}>
      <ActivityIcon kind="think" running={running} />
      <span className="min-w-0 truncate">
        {running
          ? m.chat_trace_thinking()
          : seconds
            ? m.chat_trace_thought_for({ seconds })
            : m.chat_trace_thought()}
      </span>
    </div>
  );
}

/** Normal's folded turn: one line naming the latest step. Clicking it opens
 * the earlier steps above it and any later rows below, flush, in order. */
function FoldRow({
  icon,
  title,
  before,
  after,
  citations,
  handlers,
}: {
  icon: ActivityIconKind;
  title: string;
  before: TraceRow[];
  after: TraceRow[];
  citations?: Citation[];
  handlers: UndoHandlers;
}) {
  const [open, setOpen] = useState(false);
  const list = (rows: TraceRow[]) =>
    rows.length ? (
      <TraceList citations={citations} handlers={handlers} rows={rows} />
    ) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {open ? list(before) : null}
      <button
        aria-expanded={open}
        className={cn(
          ROW,
          'cursor-pointer rounded-md text-left hover:text-fg focus-visible:outline-2 focus-visible:outline-action'
        )}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ActivityIcon kind={icon} />
        <span className="min-w-0 truncate">{title}</span>
      </button>
      {open ? list(after) : null}
    </div>
  );
}

/** A row that opens to list the rows behind it. */
function ExpandRow({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className={cn(
          ROW,
          'cursor-pointer rounded-md text-left hover:text-fg focus-visible:outline-2 focus-visible:outline-action'
        )}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {icon}
        <span className="min-w-0 truncate">{title}</span>
        {description ? (
          <span className="shrink-0 text-[12.5px] opacity-80">
            {description}
          </span>
        ) : null}
        <Icon
          className={cn(
            '-ml-1 size-3.5 shrink-0 transition-transform duration-(--motion-duration-quick) ease-(--motion-ease-smooth-out) motion-reduce:transition-none',
            open && 'rotate-90'
          )}
          name="chevronRight"
        />
      </button>
      {open ? <div className="mt-1.5 mb-0.5 ml-6.5">{children}</div> : null}
    </div>
  );
}

function toastRefusal(effect: Undoable, code: string) {
  const redo = undoAction(effect.operation) === 'redo';
  const edit =
    effect.operation === 'edited' || effect.operation === 'edit_undone';
  userToast({
    description:
      code === 'undo_unavailable'
        ? m.chat_undo_unavailable()
        : toolErrorMessage({ code, message: '' }),
    title: edit
      ? redo
        ? m.chat_redo_failed_edit()
        : m.chat_undo_failed_edit()
      : redo
        ? m.chat_redo_failed_change()
        : m.chat_undo_failed_change(),
    variant: 'error',
  });
}

/** Undo on created, edited and restored effects; Redo once undone. Hidden
 * unless the server says the step is available. */
function UndoButton({
  effect,
  handlers,
}: {
  effect: Undoable;
  handlers: UndoHandlers;
}) {
  const { mutate: undo, isPending } = useUndoEdit();
  const redo = undoAction(effect.operation) === 'redo';
  const { operationId, status } = effect.undo;
  if (status !== 'available') return null;
  return (
    <Button
      className="px-1.5 py-1"
      disabled={isPending}
      onClick={() =>
        undo(operationId, {
          onError: (error) => {
            toastRefusal(effect, isApiError(error) ? (error.code ?? '') : '');
            handlers.onUndoRefused(effect);
          },
          onSuccess: (receipt) => {
            if (receipt.outcome === 'succeeded' && receipt.effect) {
              handlers.onUndoApplied(operationId, receipt.effect);
              return;
            }
            toastRefusal(effect, receipt.error?.code ?? '');
            handlers.onUndoRefused(effect);
          },
        })
      }
      size="xs"
      variant={redo ? 'ghost-hover' : 'danger-light'}
    >
      {isPending
        ? redo
          ? m.chat_redo_pending()
          : m.chat_undo_pending()
        : redo
          ? m.chat_redo()
          : m.chat_undo_edit()}
    </Button>
  );
}

function OpenButton({
  resource,
  onOpen,
}: {
  resource: ResourceRef;
  onOpen?: (ref: ResourceRef) => void;
}) {
  if (!onOpen) return null;
  return (
    <UnderlineLink
      noArrow
      onClick={() =>
        onOpen({ id: resource.id, kind: resource.kind, title: resource.title })
      }
    >
      {m.chat_open_resource()}
    </UnderlineLink>
  );
}

const hasUndo = (effect: ResourceEffect): effect is Undoable => !!effect.undo;

/** A file the turn created or edited: one strip in full text colour, with the
 * file's own icon, Undo (danger-light) and Open. The verb follows the
 * operation, so Undo/Redo steps rewrite it in place. */
function ReceiptRow({
  effect,
  handlers,
  deck = false,
}: {
  effect: ResourceEffect;
  handlers: UndoHandlers;
  /** create_deck: a source file whose title may carry no extension. */
  deck?: boolean;
}) {
  const { resource } = effect;
  const label = resource.title || resource.id;
  const icon =
    resource.kind === 'material'
      ? materialIconName(materialKind(resource.materialKind) ?? 'note')
      : fileIconName({ kind: deck ? 'slides' : 'unknown', name: label });
  const trashed = effect.operation === 'trashed';
  const muted = trashed || effect.operation === 'edit_undone';
  const text = receiptText(effect.operation, label);
  const at = text.indexOf(label);
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 text-sm',
        muted ? 'text-fg-muted' : 'text-fg'
      )}
    >
      <FileIcon
        className={cn('size-4.5 -translate-y-px', muted && 'opacity-60')}
        name={icon}
      />
      <span className="min-w-0 truncate">
        {text.slice(0, at)}
        <span
          className={cn(
            muted ? 'font-medium text-fg-secondary' : 'font-semibold'
          )}
        >
          {label}
        </span>
        {text.slice(at + label.length)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 pl-1">
        {hasUndo(effect) ? (
          <UndoButton effect={effect} handlers={handlers} />
        ) : null}
        {trashed ? null : (
          <OpenButton onOpen={handlers.onOpenResource} resource={resource} />
        )}
      </span>
    </div>
  );
}

function receiptText(
  operation: ResourceEffect['operation'],
  label: string
): string {
  switch (operation) {
    case 'created':
      return m.chat_step_create_done({ label });
    case 'trashed':
      return m.chat_step_trash_done({ label });
    case 'restored':
      return m.chat_step_restore_done({ label });
    case 'edit_undone':
      return m.chat_step_edit_undone({ label });
    default:
      return m.chat_step_edit_done({ label });
  }
}

function Row({
  row,
  handlers,
  citations,
}: {
  row: TraceRow;
  handlers: UndoHandlers;
  citations?: Citation[];
}) {
  switch (row.type) {
    case 'narration':
      return (
        <div>
          <LangAnswer
            citations={citations}
            complete
            content={row.text}
            latest={false}
            streaming={false}
          />
        </div>
      );
    case 'thinking':
      return <ThinkingRow running={row.running} seconds={row.seconds} />;
    case 'step':
      return <StepRow state={row.state} tool={row.tool} />;
    case 'group':
      return (
        <ExpandRow
          icon={<ActivityIcon kind={toolIcon(row.name)} />}
          title={groupTitle(row.name, row.tools.length)}
        >
          <div className="flex flex-col gap-1.5">
            {row.tools.map((tool) => (
              <StepRow key={tool.id} state="done" tool={tool} />
            ))}
          </div>
        </ExpandRow>
      );
    case 'created':
      return (
        <ReceiptRow
          deck={row.tool.name === 'create_deck'}
          effect={row.effect}
          handlers={handlers}
        />
      );
    case 'edited':
      return <ReceiptRow effect={row.effect} handlers={handlers} />;
  }
}

const isReceipt = (row: TraceRow) =>
  row.type === 'created' || row.type === 'edited';

/** A turn's created and edited files, set apart from the steps and the
 * answer between hairlines. */
function Receipts({
  rows,
  handlers,
}: {
  rows: TraceRow[];
  handlers: UndoHandlers;
}) {
  return (
    <div className="my-2 flex flex-col gap-2.5 border-line border-y py-3">
      {rows.map((row) => (
        <Row handlers={handlers} key={row.id} row={row} />
      ))}
    </div>
  );
}

/** Rows in lists 8px apart, consecutive receipts in one block; narration, in
 * answer text, sits between lists 24px away. */
function TraceList({
  rows,
  handlers,
  citations,
}: {
  rows: TraceRow[];
  handlers: UndoHandlers;
  citations?: Citation[];
}) {
  const lists: TraceRow[][] = [];
  for (const row of rows) {
    const last = lists.at(-1);
    if (row.type === 'narration' || !last || last[0].type === 'narration')
      lists.push([row]);
    else last.push(row);
  }
  return (
    <div className="flex flex-col gap-6">
      {lists.map((list) => (
        <div className="flex flex-col gap-2" key={list[0].id}>
          {runs(list).map((run) =>
            isReceipt(run[0]) ? (
              <Receipts handlers={handlers} key={run[0].id} rows={run} />
            ) : (
              <Row
                citations={citations}
                handlers={handlers}
                key={run[0].id}
                row={run[0]}
              />
            )
          )}
        </div>
      ))}
    </div>
  );
}

/** Each receipt run as one item, every other row on its own. */
function runs(rows: TraceRow[]): TraceRow[][] {
  const out: TraceRow[][] = [];
  for (const row of rows) {
    const last = out.at(-1);
    if (last && isReceipt(row) && isReceipt(last[0])) last.push(row);
    else out.push([row]);
  }
  return out;
}

/** The model is between steps: no tool running, no text streaming. */
export function isThinking(msg: ChatMessage, live: boolean): boolean {
  return (
    live &&
    msg.phase !== 'answering' &&
    !msg.currentBlockText &&
    !msg.activity?.some((block) => block.kind === 'tool' && !block.outcome)
  );
}

/** The steps between two narrations behind one line that names the latest
 * step; the steps before it open above that line, the ones after it below. */
function StepsFold({
  rows,
  citations,
  handlers,
}: {
  rows: TraceRow[];
  citations?: Citation[];
  handlers: UndoHandlers;
}) {
  const latest = latestStep(rows);
  return latest ? (
    <FoldRow
      after={rows.slice(latest.index + 1)}
      before={rows.slice(0, latest.index)}
      citations={citations}
      handlers={handlers}
      icon={latest.icon}
      title={latest.text}
    />
  ) : (
    <TraceList citations={citations} handlers={handlers} rows={rows} />
  );
}

/** A turn's tool calls and thinking as trace rows. Verbose keeps every row;
 * Normal shows only the current step, folding the steps between narrations
 * into one row each; narration stays as text. Receipts stay visible in both,
 * Normal adding them once the answer starts. */
export function ChatTrace({
  msg,
  live,
  mode,
  handlers,
}: {
  msg: ChatMessage;
  /** The message is still streaming. */
  live: boolean;
  mode: ChatSteps;
  handlers: UndoHandlers;
}) {
  const thinking = useDelayed(isThinking(msg, live), THINKING_DELAY_MS);
  const input = {
    activity: msg.activity ?? [],
    live,
    startedAt: msg.createdAt,
    stopped: msg.status === 'aborted',
    thinking,
  };
  const answering = !live || msg.phase === 'answering' || !!msg.content;

  if (mode === 'verbose') {
    const rows = buildTrace(input);
    return rows.length ? (
      <div className="mb-4">
        <TraceList citations={msg.citations} handlers={handlers} rows={rows} />
      </div>
    ) : null;
  }

  const fold = foldTrace(input);
  const receipts = answering ? fold.receipts : [];
  const segments = foldSegments(fold.rows);
  if (!segments.length && !receipts.length) return null;
  return (
    <div className="mb-4 flex flex-col gap-2">
      <div className="flex flex-col gap-6 empty:hidden">
        {segments.map((rows, index) => {
          const row = rows.at(-1);
          if (!row) return null;
          if (row.type === 'narration') {
            return (
              <Row
                citations={msg.citations}
                handlers={handlers}
                key={row.id}
                row={row}
              />
            );
          }
          // While it works, the last steps show only the one it is on,
          // swapping in place.
          if (!answering && index === segments.length - 1) {
            return (
              <div className="trace-enter" key={row.id}>
                <Row handlers={handlers} row={row} />
              </div>
            );
          }
          return (
            <StepsFold
              citations={msg.citations}
              handlers={handlers}
              key={rows[0].id}
              rows={rows}
            />
          );
        })}
      </div>
      {receipts.length ? (
        <Receipts handlers={handlers} rows={receipts} />
      ) : null}
    </div>
  );
}
