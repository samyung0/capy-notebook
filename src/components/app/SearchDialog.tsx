import { useNavigate } from '@tanstack/react-router';
import { VisuallyHidden } from 'radix-ui';
import { useState } from 'react';
import { useSearch } from '@/api/hooks';
import type { SearchKind, SearchResult } from '@/api/types';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { features } from '@/lib/features';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { iconUrl } from '@/lib/icon-catalog';
import { useDebounced } from '@/lib/useDebounced';
import { userColorPair } from '@/lib/userColor';

const KIND_ICON: Record<SearchKind, Parameters<typeof Icon>[0]['name']> = {
  event: 'schedule',
  file: 'files',
  flashcards: 'flashcards',
  thinking: 'write',
  workspace: 'workspaces',
};

function visibleSearchResult(result: SearchResult): boolean {
  if (result.kind === 'event') return features.schedule;
  if (result.kind === 'thinking') return features.thinking;
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
  const { data, fetchStatus, isFetching } = useSearch(debounced, {
    errorBoundary: false,
  });
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
        cardScrollContainerClassName="p-0"
        className="top-[12vh] translate-y-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector('input')?.focus();
        }}
        showCloseButton={false}
      >
        <VisuallyHidden.Root asChild>
          <DialogTitle>{m.search_placeholder()}</DialogTitle>
        </VisuallyHidden.Root>
        <div className="flex max-h-[70vh] flex-col">
          <div className="flex items-center gap-2.5 border-divider border-b px-4 py-3">
            <span className="pl-1.5">
              <Icon className="size-4.25" name="search" />
            </span>
            <Input
              onChange={(e) => setQ(e.target.value)}
              placeholder={m.search_placeholder()}
              value={q}
              variant="transparent"
              wrapperClassName="flex-1 translate-y-px"
            />
            <DialogClose asChild>
              <IconButton
                icon="x"
                label={m.action_close()}
                size="sm"
                variant="ghost-hover"
              />
            </DialogClose>
          </div>
          <div className="relative min-h-40 flex-1 overflow-auto px-2 py-2.5">
            {fetchStatus === 'paused' ? (
              <QueryPausedState />
            ) : isFetching ? (
              <SkeletonList count={5} rowHeight={48} />
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
                      <span
                        className={cn(
                          'flex size-8 shrink-0 items-center justify-center rounded-button',
                          !fileIcon &&
                            !workspaceIcon &&
                            'bg-surface-hover-bg text-fg-secondary'
                        )}
                        style={
                          !fileIcon && !workspaceIcon && c
                            ? { background: c.bg, color: c.fg }
                            : undefined
                        }
                      >
                        {workspaceIcon ? (
                          <img
                            alt=""
                            className="size-8 rounded-button"
                            height={32}
                            src={iconUrl(workspaceIcon)}
                            width={32}
                          />
                        ) : fileIcon ? (
                          <FileIcon className="size-5" name={fileIcon} />
                        ) : (
                          <Icon name={KIND_ICON[r.kind]} size={16} />
                        )}
                      </span>
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
