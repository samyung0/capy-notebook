import { NodeApi } from 'platejs';
import {
  type Ref,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FloatingBarContext } from '@/components/ui/floatingBarContext';
import { IconButton } from '@/components/ui/IconButton';
import type { MaterialElement } from '@/features/materials/document';
import { MaterialPreview } from '@/features/materials/MaterialPreview';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { MergeStore, PieceView } from './mergeStore';
import type { PieceChoice, PieceSource, PieceStatus } from './types';

const SOURCE: Record<PieceSource, () => string> = {
  changed: () => m.merge_source_changed(),
  conflict: () => m.merge_source_conflict(),
  expired: () => m.merge_source_expired(),
  refused: () => m.merge_source_refused(),
};

const STATUS: Record<
  PieceStatus,
  { label: () => string; tone: 'error' | 'info' | 'success' | 'warning' }
> = {
  conflict: { label: () => m.merge_status_conflict(), tone: 'warning' },
  'mine-deleted': { label: () => m.merge_status_mine_deleted(), tone: 'info' },
  resolved: { label: () => m.merge_status_resolved(), tone: 'success' },
  'theirs-deleted': {
    label: () => m.merge_status_theirs_deleted(),
    tone: 'error',
  },
};

type Action = PieceChoice | 'keep' | 'copy';

/** The choices a status offers (Q253): one way
 * to keep the current block per case, Copy wherever there is text. */
const CHOICES: Record<PieceStatus, { action: Action; label: () => string }[]> =
  {
    conflict: [
      { action: 'apply', label: () => m.merge_apply() },
      { action: 'keep', label: () => m.merge_keep() },
      { action: 'insert', label: () => m.merge_insert() },
      { action: 'copy', label: () => m.merge_copy() },
    ],
    'mine-deleted': [
      { action: 'delete', label: () => m.merge_delete() },
      { action: 'keep', label: () => m.merge_keep() },
    ],
    resolved: [],
    'theirs-deleted': [
      { action: 'restore', label: () => m.merge_restore() },
      { action: 'keep', label: () => m.merge_discard() },
      { action: 'copy', label: () => m.merge_copy() },
    ],
  };

/**
 * The merge view's sheet (Epo 2026-10-24, Q252): the user's edits that could
 * not sync into the note, one top-level block each, beside the live note.
 * Non-modal and over the note, since docking would re-flow a large note: a
 * bottom panel on phones, a right sheet from md. NoteEditor renders it
 * outside every editor mount, so it survives a room swap and never
 * re-renders the document. Esc and the close button close it.
 */
export default function NoteMergeView({
  onClose,
  onOpen,
  onShow,
  open,
  store,
  underStrip,
}: {
  onClose: () => void;
  /** The piece open in the list (kept by NoteEditor). */
  onOpen: (block: string | null) => void;
  /** Scrolls the note to a piece's block, else the block before it. */
  onShow: (block: string, after: string | null) => void;
  open: string | null;
  store: MergeStore;
  /** A strip shows above the note: the sheet starts below it, so its
   * Review and Discard stay in reach. */
  underStrip: boolean;
}) {
  const { canApply, pieces, stale } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot
  );
  // The workspace's floating bar sits over the sheet's end.
  const overBar = useContext(FloatingBarContext);
  return (
    <section
      aria-label={m.merge_title()}
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 flex h-[60%] flex-col rounded-t-xl border-divider border-t bg-surface shadow-lg',
        'md:inset-y-0 md:right-0 md:left-auto md:h-auto md:w-[400px] md:rounded-none md:border-t-0 md:border-l',
        underStrip && 'md:top-9'
      )}
      data-testid="merge-view"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-divider border-b pr-1.5 pl-4">
        <h2 className="min-w-0 flex-1 truncate font-semibold text-sm">
          {m.merge_title()}
        </h2>
        <IconButton
          icon="x"
          label={m.action_close()}
          onClick={onClose}
          size="sm"
        />
      </header>
      <p aria-live="polite" className="sr-only">
        {stale ? m.merge_stale() : ''}
      </p>
      {!canApply && (
        <p className="shrink-0 border-divider border-b px-4 py-2 text-fg-muted text-xs">
          {m.merge_reconnect()}
        </p>
      )}
      <ol className={cn('min-h-0 flex-1 overflow-y-auto', overBar && 'pb-28')}>
        {pieces.map((view) => (
          <PieceRow
            canApply={canApply}
            expanded={open === view.piece.block}
            key={view.piece.block}
            onToggle={() => {
              const block = view.piece.block;
              onOpen(open === block ? null : block);
              onShow(block, view.piece.after);
            }}
            stale={stale === view.piece.block}
            store={store}
            view={view}
          />
        ))}
      </ol>
    </section>
  );
}

function PieceRow({
  canApply,
  expanded,
  onToggle,
  stale,
  store,
  view,
}: {
  canApply: boolean;
  expanded: boolean;
  onToggle: () => void;
  stale: boolean;
  store: MergeStore;
  view: PieceView;
}) {
  const { current, piece, status } = view;
  // Text only while collapsed: static renders happen on expand.
  const excerpt = useMemo(
    () => NodeApi.string((piece.mine ?? current ?? EMPTY) as never),
    [piece.mine, current]
  );
  const yours = useRef<HTMLDivElement>(null);
  const chip = STATUS[status];
  const act = (action: Action) => {
    if (action === 'keep') store.dismiss(piece.block);
    else if (action === 'copy') void copyBlock(excerpt, yours.current);
    else store.apply(piece.block, action, current);
  };
  return (
    <li
      className="border-divider border-b"
      data-merge-piece={piece.block}
      data-status={status}
    >
      <button
        aria-expanded={expanded}
        className="flex w-full flex-col items-start gap-1.5 px-4 py-3 text-left hover:bg-surface-hover-bg"
        onClick={onToggle}
        type="button"
      >
        <span className="flex flex-wrap items-center gap-2">
          <Badge size="sm" tone={chip.tone}>
            {chip.label()}
          </Badge>
          <span className="text-fg-muted text-xs">
            {SOURCE[piece.source]()}
          </span>
        </span>
        <span className="line-clamp-2 text-sm">
          {excerpt || m.merge_empty_block()}
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-3 px-4 pb-4">
          {stale && <p className="text-xs">{m.merge_stale()}</p>}
          <Version
            block={piece.mine}
            deleted={m.merge_yours_deleted()}
            label={m.merge_yours()}
            ref={yours}
          />
          <Version
            block={current ?? null}
            deleted={m.merge_current_deleted()}
            label={m.merge_current()}
          />
          {CHOICES[status].length > 0 && (
            <div className="flex flex-wrap gap-2">
              {CHOICES[status].map(({ action, label }) => (
                <Button
                  disabled={action !== 'keep' && action !== 'copy' && !canApply}
                  key={action}
                  onClick={() => act(action)}
                  size="sm"
                  variant="outline"
                >
                  {label()}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

const EMPTY = { children: [{ text: '' }] };

function Version({
  block,
  deleted,
  label,
  ref,
}: {
  block: MaterialElement | null;
  deleted: string;
  label: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const value = useMemo(() => (block ? [block] : null), [block]);
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-fg-muted text-xs">{label}</span>
      <div
        className="max-h-[40vh] overflow-auto rounded-md border border-line"
        ref={ref}
      >
        {value ? (
          <MaterialPreview
            className="min-h-0 px-3 pt-2 pb-2 sm:px-3"
            content={{ schemaVersion: 1, value }}
            value={value}
          />
        ) : (
          <p className="px-3 py-2 text-fg-muted text-sm">{deleted}</p>
        )}
      </div>
    </div>
  );
}

/** The block as text, and as its static render's markup, which a paste
 * reads through the HTML deserializer. */
async function copyBlock(text: string, rendered: HTMLElement | null) {
  const html = rendered?.innerHTML ?? '';
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    }),
  ]);
}
