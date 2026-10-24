import { useNavigate } from '@tanstack/react-router';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useState } from 'react';
import { searchQueryQMax } from '@/api/gen/validators';
import { useSearch } from '@/api/hooks';
import type { SearchKind, SearchResult } from '@/api/types';
import { InlineErrorState } from '@/components/app/ErrorState';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { ThumbnailPanel } from '@/components/app/ThumbnailPanel';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/Dialog';
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
import { userColorPair } from '@/lib/userColor';

const KIND_ICON: Record<SearchKind, Parameters<typeof Icon>[0]['name']> = {
  event: 'schedule',
  file: 'files',
  flashcards: 'flashcards',
  workspace: 'workspaces',
};

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
          <div className="relative min-h-40 flex-1 overflow-auto px-2 py-2.5 max-sm:pb-[calc(--spacing(2.5)+max(env(safe-area-inset-bottom),var(--keyboard-inset,0px)))]">
            {waitsForConnection(fetchStatus, data) ? (
              <QueryPausedState />
            ) : isFetching ? (
              <SkeletonList className="px-1" count={5} rowHeight={48} />
            ) : query && !data && isError ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <InlineErrorState
                  className="-translate-y-1/2"
                  errorId={unexpectedErrorId(error)}
                  message={m.search_error()}
                  onRetry={() => void refetch()}
                />
              </div>
            ) : query ? (
              results?.length ? (
                results.map((r) => {
                  const workspaceIcon = r.kind === 'workspace' && r.iconId;
                  const fileIcon =
                    r.kind === 'file' && r.fileKind
                      ? fileIconName({ kind: r.fileKind, name: r.title })
                      : r.kind === 'flashcards'
                        ? materialIconName('flashcards')
                        : undefined;
                  const c = r.color ? userColorPair(r.color) : null;
                  return (
                    <button
                      className={cn(
                        BASE_BUTTON_STYLE,
                        'flex w-full items-center gap-3 px-2 py-2.5 text-left hover:bg-surface-hover-bg'
                      )}
                      key={`${r.kind}-${r.id}`}
                      onClick={() => {
                        setOpen(false);
                        navigate({ to: r.href });
                      }}
                      type="button"
                    >
                      {fileIcon ? (
                        <ThumbnailPanel
                          fileKind={r.fileKind}
                          icon={fileIcon}
                          preview={r.preview}
                          small
                          thumbnailUrl={r.thumbnailUrl}
                        />
                      ) : (
                        <span
                          className={cn(
                            'flex size-10 shrink-0 items-center justify-center rounded-button',
                            !workspaceIcon &&
                              'bg-surface-hover-bg text-fg-secondary'
                          )}
                          style={
                            !workspaceIcon && c
                              ? { background: c.bg, color: c.fg }
                              : undefined
                          }
                        >
                          {workspaceIcon ? (
                            <img
                              alt=""
                              className="size-10 rounded-button"
                              height={40}
                              src={iconUrl(workspaceIcon)}
                              width={40}
                            />
                          ) : (
                            <Icon name={KIND_ICON[r.kind]} size={16} />
                          )}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-fg text-sm">
                          {r.title}
                        </span>
                        {r.subtitle && (
                          <span className="block truncate text-fg-muted text-xs">
                            {r.subtitle}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-center">
                  <span className="-translate-y-1/2">
                    No matches for "{query}".
                  </span>
                </div>
              )
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-center">
                <span className="-translate-y-1/2">
                  {m.search_result_placeholder()}
                </span>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
