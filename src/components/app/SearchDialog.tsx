import { useNavigate } from '@tanstack/react-router';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useState } from 'react';
import { searchQueryQMax } from '@/api/gen/validators';
import { useSearch } from '@/api/hooks';
import type { MaterialKind, SearchKind, SearchResult } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { features } from '@/lib/features';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';
import { waitsForConnection } from '@/lib/online';
import { useDebounced } from '@/lib/useDebounced';

/** A material hit's kind is its material kind; these draw a plain icon. */
const KIND_ICON = {
  event: 'schedule',
  file: 'files',
  workspace: 'workspaces',
} satisfies Partial<Record<SearchKind, Parameters<typeof Icon>[0]['name']>>;

const isMaterial = (kind: SearchKind): kind is MaterialKind =>
  !(kind in KIND_ICON);

function visibleSearchResult(result: SearchResult): boolean {
  if (result.kind === 'event') return features.schedule;
  return true;
}

export function SearchDialog({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 400);
  const { data, error, fetchStatus, isError, isFetching, refetch } = useSearch(
    debounced,
    {
      errorBoundary: false,
    }
  );
  const navigate = useNavigate();
  const query = debounced.trim();
  const results = data?.filter(visibleSearchResult);

  return (
    <Dialog
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (isOpen) setQ('');
      }}
      open={open}
    >
      <DialogContent
        cardScrollContainerClassName="p-0 max-sm:pb-0 sm:p-0"
        className="top-[12vh] translate-y-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector('input')?.focus();
        }}
        showCloseButton={false}
      >
        {/* Its own header, not DialogTitle's: phones show close and a title
            above the field, wider screens only the field with close beside. */}
        <div className="flex shrink-0 items-start gap-1 pt-3 pr-4 pb-1 pl-1.5 sm:contents">
          <DialogClose asChild>
            <IconButton
              className="-translate-y-px sm:hidden"
              icon="x"
              label={m.action_close()}
              size="sm"
              variant="ghost-hover"
            />
          </DialogClose>
          <DialogPrimitive.Title className="t-large-card-title py-2 text-lg leading-tight sm:sr-only">
            {m.nav_search()}
          </DialogPrimitive.Title>
        </div>
        <div className="flex min-h-0 flex-1 flex-col sm:max-h-[70vh] sm:flex-none">
          <div className="flex items-center gap-2.5 border-divider border-b px-4 py-3">
            <span className="pl-1.5">
              <Icon className="size-4.25" name="search" />
            </span>
            <Input
              maxLength={searchQueryQMax}
              onChange={(e) => setQ(e.target.value)}
              placeholder={m.search_placeholder()}
              value={q}
              variant="transparent"
              wrapperClassName="flex-1 translate-y-px"
            />
            <DialogClose asChild>
              <IconButton
                className="max-sm:hidden"
                icon="x"
                label={m.action_close()}
                size="sm"
                variant="ghost-hover"
              />
            </DialogClose>
          </div>
          <div className="relative min-h-40 flex-1 overflow-auto px-2 py-2 max-sm:pb-[calc(--spacing(2)+max(env(safe-area-inset-bottom),var(--keyboard-inset,0px)))]">
            {waitsForConnection(fetchStatus, data) ? (
              <QueryPausedState />
            ) : isFetching ? (
              <SkeletonList className="px-1" count={6} rowHeight={40} />
            ) : query && !data && isError ? (
              <CenteredState>
                <InlineErrorState
                  errorId={unexpectedErrorId(error)}
                  message={m.search_error()}
                  onRetry={() => void refetch()}
                />
              </CenteredState>
            ) : query ? (
              results?.length ? (
                groupByKind(results).map(([kind, rows]) => (
                  // One section per kind, under its name (Epo 2026-11-13).
                  <section
                    aria-label={GROUP_LABEL[kind]()}
                    className="not-first:mt-2 border-divider not-first:border-t not-first:pt-2"
                    key={kind}
                  >
                    <h3 className="t-meta px-2 py-1 font-semibold text-fg-muted">
                      {GROUP_LABEL[kind]()}
                    </h3>
                    {rows.map((r) => (
                      <ResultRow
                        key={`${r.kind}-${r.id}`}
                        onOpen={() => {
                          setOpen(false);
                          navigate({ to: r.href });
                        }}
                        result={r}
                      />
                    ))}
                  </section>
                ))
              ) : (
                <CenteredState>{m.common_no_matches()}</CenteredState>
              )
            ) : (
              <CenteredState>{m.search_result_placeholder()}</CenteredState>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The results' kinds in the order the server sends them, each with its rows. */
function groupByKind(results: SearchResult[]) {
  const groups = new Map<SearchKind, SearchResult[]>();
  for (const r of results)
    groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
  return [...groups];
}

const GROUP_LABEL: Record<SearchKind, () => string> = {
  canvas: m.search_group_canvases,
  diagram: m.search_group_diagrams,
  event: m.nav_schedule,
  file: m.nav_files,
  flashcards: m.search_group_flashcards,
  mindmap: m.search_group_mindmaps,
  note: m.search_group_notes,
  quiz: m.search_group_quizzes,
  workspace: m.nav_workspaces,
};

/** The prompt, no matches and the error, in the middle of the results' area. */
function CenteredState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-35 items-center justify-center text-center">
      {children}
    </div>
  );
}

/** One line per hit: the kind's icon, the name, then where it lives. */
function ResultRow({
  onOpen,
  result: r,
}: {
  onOpen: () => void;
  result: SearchResult;
}) {
  return (
    <button
      className={cn(
        BASE_BUTTON_STYLE,
        'flex h-10 w-full items-center justify-start gap-3 px-2 text-left hover:bg-surface-hover-bg'
      )}
      onClick={onOpen}
      type="button"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {r.kind === 'workspace' && r.iconId ? (
          <img
            alt=""
            className="size-5 rounded-[4px]"
            height={20}
            src={iconUrl(r.iconId)}
            width={20}
          />
        ) : r.kind === 'file' && r.fileKind ? (
          <FileIcon
            className="size-5"
            name={fileIconName({ kind: r.fileKind, name: r.title })}
          />
        ) : isMaterial(r.kind) ? (
          <FileIcon className="size-5" name={materialIconName(r.kind)} />
        ) : (
          <Icon
            className="text-fg-secondary"
            name={KIND_ICON[r.kind]}
            size={18}
          />
        )}
      </span>
      <span className="min-w-0 truncate font-medium text-fg text-sm">
        {r.title}
      </span>
      {r.subtitle && (
        <span className="ml-auto min-w-0 max-w-[45%] shrink-0 truncate pl-2 text-fg-muted text-xs">
          {r.subtitle}
        </span>
      )}
    </button>
  );
}
