import { Link } from '@tanstack/react-router';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { InlineErrorState } from '@/components/app/ErrorState';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { ThumbnailPanel } from '@/components/app/ThumbnailPanel';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Dialog, DialogContent } from '@/components/ui/Dialog';
import { SkeletonList } from '@/components/ui/feedback';
import {
  recentHint,
  recentIcon,
  recentLink,
  recentThumbnail,
  useRecentItems,
} from '@/features/dashboard/RecentItemsCard';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { iconUrl } from '@/lib/icon-catalog';

const QUICK_OPEN_LIMIT = 5;

/** The phone's quick open: the five newest of Recent (the caller's opens,
 * from any device), sharing the dashboard's cached list. Links
 * carry no mode, so each opens in the mode last used on it in this browser
 * (`readDocumentMode`). */
export function RecentQuickOpen({ onClose }: { onClose: () => void }) {
  const { isLoading, items, missing, paused, workspaces } = useRecentItems();
  return (
    // A centred card on phones too, closed by tapping outside it.
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-md" compact showCloseButton={false}>
        <DialogPrimitive.Title className="t-large-card-title pb-3">
          {m.quick_open_title()}
        </DialogPrimitive.Title>
        {paused ? (
          <QueryPausedState />
        ) : isLoading ? (
          <SkeletonList count={QUICK_OPEN_LIMIT} rowHeight={52} />
        ) : missing.length ? (
          <InlineErrorState
            className="py-6"
            errorId={
              missing
                .map(([, , , error]) => unexpectedErrorId(error))
                .find(Boolean) ?? null
            }
            message={m.dashboard_recent_error()}
            onRetry={() => {
              for (const [, , refetch] of missing) void refetch();
            }}
          />
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-fg-muted">
            {m.quick_open_empty()}
          </p>
        ) : (
          <div className="-mx-1.5 flex flex-col gap-1">
            {items.slice(0, QUICK_OPEN_LIMIT).map((item) => {
              const workspace = workspaces?.find(
                (ws) => ws.id === item.workspaceId
              );
              return (
                <Link
                  className={cn(
                    BASE_BUTTON_STYLE,
                    'flex items-center gap-3 px-1.5 py-1.5 text-left hover:bg-surface-hover-bg'
                  )}
                  key={`${item.kind}-${item.id}`}
                  // Same path (another file in the open workspace) keeps the
                  // dialog, which only closes itself on a path change.
                  onClick={onClose}
                  {...recentLink(item)}
                >
                  <ThumbnailPanel
                    icon={recentIcon(item)}
                    small
                    {...recentThumbnail(item)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1 leading-tight">
                    <span className="truncate font-semibold text-fg">
                      {item.title}
                    </span>
                    {/* Like Recent Files' hint: workspace · when opened. */}
                    <span className="flex min-w-0 items-center gap-1.5 text-fg-muted text-sm">
                      {workspace && (
                        <>
                          <img
                            alt=""
                            className="size-4.5 shrink-0 -translate-y-px rounded-[4px]"
                            height={18}
                            src={iconUrl(workspace.iconId)}
                            width={18}
                          />
                          <span className="min-w-0 truncate">
                            {workspace.name}
                          </span>
                          <span aria-hidden className="shrink-0">
                            ·
                          </span>
                        </>
                      )}
                      <span className="shrink-0 whitespace-nowrap">
                        {recentHint(item)}
                      </span>
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
