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
import { userToast } from '@/components/ui/userToast';
import { materialKindLabel } from '@/features/materials/MaterialListCard';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { toolErrorMessage } from '../toolErrorMessage';
import { ActivityIcon } from './ActivityIcon';
import { LangAnswer } from './LangAnswer';
import {
  buildTrace,
  currentRow,
  foldTrace,
  groupTitle,
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

/** A row that opens to list the rows behind it. `flat` (the Normal summary)
 * drops the chevron and lists the rows flush with it. */
function ExpandRow({
  icon,
  title,
  description,
  flat = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  flat?: boolean;
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
        {flat ? null : (
          <Icon
            className={cn(
              '-ml-1 size-3.5 shrink-0 transition-transform duration-(--motion-duration-quick) ease-(--motion-ease-smooth-out) motion-reduce:transition-none',
              open && 'rotate-90'
            )}
            name="chevronRight"
          />
        )}
      </button>
      {open ? (
        <div className={cn('mt-1.5 mb-0.5', !flat && 'ml-6.5')}>{children}</div>
      ) : null}
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

/** Undo on created, edited and restored effects; Redo once undone. Disabled
 * unless the server says the step is available. */
function UndoButton({
  effect,
  quiet,
  handlers,
}: {
  effect: Undoable;
  /** Inside a card: ghost buttons; on a row: outlined. */
  quiet: boolean;
  handlers: UndoHandlers;
}) {
  const { mutate: undo, isPending } = useUndoEdit();
  const redo = undoAction(effect.operation) === 'redo';
  const { operationId } = effect.undo;
  return (
    <Button
      disabled={isPending || effect.undo.status !== 'available'}
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
      size="sm"
      variant={redo ? (quiet ? 'ghost-hover' : 'outline') : 'danger-light'}
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
  quiet,
  onOpen,
}: {
  resource: ResourceRef;
  quiet: boolean;
  onOpen?: (ref: ResourceRef) => void;
}) {
  if (!onOpen) return null;
  return (
    <Button
      onClick={() =>
        onOpen({ id: resource.id, kind: resource.kind, title: resource.title })
      }
      size="sm"
      variant={quiet ? 'ghost-hover' : 'outline'}
    >
      {m.chat_open_resource()}
    </Button>
  );
}

const hasUndo = (effect: ResourceEffect): effect is Undoable => !!effect.undo;

/** A file the turn created, with the callout container's weight. */
function CreatedCard({
  effect,
  tool,
  handlers,
}: {
  effect: ResourceEffect;
  tool: ToolBlock;
  handlers: UndoHandlers;
}) {
  const { resource } = effect;
  const trashed = effect.operation === 'trashed';
  const kind = materialKind(resource.materialKind);
  const deck = tool.name === 'create_deck';
  const icon =
    resource.kind === 'material'
      ? materialIconName(kind ?? 'note')
      : fileIconName({
          kind: deck ? 'slides' : 'unknown',
          name: resource.title ?? '',
        });
  const meta = trashed
    ? m.chat_effect_trashed()
    : kind
      ? materialKindLabel(kind)
      : deck
        ? m.file_kind_slides()
        : undefined;
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-line-strong/45 bg-surface py-1.5 pr-1.5 pl-3 text-sm">
      <FileIcon className="size-4.5 -translate-y-px" name={icon} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'truncate font-semibold',
            trashed && 'text-fg-muted line-through'
          )}
        >
          {resource.title || resource.id}
        </p>
        {meta ? <p className="text-fg-muted text-xs">{meta}</p> : null}
      </div>
      <span className="flex shrink-0 gap-0.5">
        {hasUndo(effect) ? (
          <UndoButton effect={effect} handlers={handlers} quiet />
        ) : null}
        {trashed ? null : (
          <OpenButton
            onOpen={handlers.onOpenResource}
            quiet
            resource={resource}
          />
        )}
      </span>
    </div>
  );
}

/** An undoable edit: the tool's own row, in full text colour. */
function EditedRow({
  effect,
  handlers,
}: {
  effect: ResourceEffect;
  handlers: UndoHandlers;
}) {
  const { resource } = effect;
  const label = resource.title || resource.id;
  const undone = effect.operation === 'edit_undone';
  const text = undone
    ? m.chat_step_edit_undone({ label })
    : m.chat_step_edit_done({ label });
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 text-sm',
        undone ? 'text-fg-muted' : 'text-fg'
      )}
    >
      <ActivityIcon kind={undone ? 'undone' : 'doc'} />
      <span className="min-w-0 truncate">
        {text.slice(0, text.indexOf(label))}
        <span
          className={cn(
            undone ? 'font-medium text-fg-secondary' : 'font-semibold'
          )}
        >
          {label}
        </span>
        {text.slice(text.indexOf(label) + label.length)}
      </span>
      <span className="ml-auto flex shrink-0 gap-1.5 pl-1">
        {hasUndo(effect) ? (
          <UndoButton effect={effect} handlers={handlers} quiet={false} />
        ) : null}
        {effect.operation === 'trashed' ? null : (
          <OpenButton
            onOpen={handlers.onOpenResource}
            quiet={false}
            resource={resource}
          />
        )}
      </span>
    </div>
  );
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
        <CreatedCard effect={row.effect} handlers={handlers} tool={row.tool} />
      );
    case 'edited':
      return <EditedRow effect={row.effect} handlers={handlers} />;
  }
}

/** Rows in lists 8px apart; narration, in answer text, sits between lists 24px away. */
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
          {list.map((row) => (
            <Row
              citations={citations}
              handlers={handlers}
              key={row.id}
              row={row}
            />
          ))}
        </div>
      ))}
    </div>
  );
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

/** A turn's tool calls and thinking as trace rows. Verbose keeps every row;
 * Normal shows only the current step, then folds the steps into one row when
 * the answer starts. Receipts stay visible in both. */
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

  if (mode === 'verbose' || !answering) {
    const rows = buildTrace({ ...input, receipts: mode === 'verbose' });
    if (mode === 'verbose') {
      return rows.length ? (
        <div className="mb-4">
          <TraceList
            citations={msg.citations}
            handlers={handlers}
            rows={rows}
          />
        </div>
      ) : null;
    }
    // Normal while it works: only the step it is on, swapping in place.
    const row = currentRow(rows);
    return row ? (
      <div className="trace-enter mb-4" key={row.id}>
        <Row handlers={handlers} row={row} />
      </div>
    ) : null;
  }

  const fold = foldTrace(input);
  if (!fold.rows.length && !fold.receipts.length) return null;
  const steps =
    fold.steps === 1
      ? m.chat_trace_steps_one()
      : m.chat_trace_steps({ count: fold.steps });
  return (
    <div className="mb-4 flex flex-col gap-2">
      {fold.steps ? (
        <ExpandRow
          flat
          icon={<ActivityIcon kind="think" />}
          title={
            fold.seconds
              ? m.chat_trace_worked_for({ seconds: fold.seconds })
              : steps
          }
        >
          <TraceList
            citations={msg.citations}
            handlers={handlers}
            rows={fold.rows}
          />
        </ExpandRow>
      ) : (
        <TraceList
          citations={msg.citations}
          handlers={handlers}
          rows={fold.rows}
        />
      )}
      {fold.receipts.map((row) => (
        <Row handlers={handlers} key={row.id} row={row} />
      ))}
    </div>
  );
}
