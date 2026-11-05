import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTodo } from '@/api/hooks';
import { InlineErrorState } from '@/components/app/ErrorState';
import { PageBody, PagePanel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { TodoRows } from '@/features/study/assignments/TodoSection';
import { todoRows, todoSections } from '@/features/study/assignments/todoRows';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { iconUrl } from '@/lib/icon-catalog';
import { waitsForConnection } from '@/lib/online';

/** To do (canvas B3bJMWbv8DjbKegLcAHXtn, board B): each class's Dashboard To do
 * across the viewer's classes, one section per workspace whose heading opens its
 * Dashboard. Items stop at 860px, left aligned (Epo 2026-11-05). */
export default function Todo() {
  const { data, error, fetchStatus, isLoading, refetch } = useTodo({
    errorBoundary: false,
  });
  const [showDone, setShowDone] = useState(false);
  const workspaces = data?.workspaces ?? [];
  const sections = todoSections(workspaces, showDone);
  const anyDone = workspaces.some(
    (w) => todoRows(w.items, w.manages).done.length > 0
  );
  return (
    <PagePanel>
      <PageBody className="pt-2 sm:pt-6">
        <div className="flex max-w-[860px] flex-col gap-5.5">
          <header className="flex min-h-9 items-center justify-between gap-3">
            <h1 className="t-page-title">{m.nav_todo()}</h1>
            {anyDone && (
              <Button
                className="px-2.5"
                iconLeft="view"
                onClick={() => setShowDone(!showDone)}
                size="sm"
                variant="outline"
              >
                {showDone ? m.assignment_hide_done() : m.assignment_show_done()}
              </Button>
            )}
          </header>
          {waitsForConnection(fetchStatus, data) ? (
            <QueryPausedState />
          ) : isLoading ? (
            <SkeletonList count={6} rowHeight={40} />
          ) : !data && error ? (
            <InlineErrorState
              errorId={unexpectedErrorId(error)}
              message={m.todo_error()}
              onRetry={() => void refetch()}
            />
          ) : (
            sections.map(({ shown, toApprove, workspace }) => (
              <section className="flex flex-col" key={workspace.workspaceId}>
                <h2 className="mb-1.5">
                  <Link
                    className="t-subtitle inline-flex min-h-7 max-w-full items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
                    params={{ workspaceId: workspace.workspaceId }}
                    preload="intent"
                    to="/workspaces/$workspaceId"
                  >
                    <img
                      alt=""
                      className="size-6 shrink-0 rounded-[5px]"
                      height={24}
                      src={iconUrl(workspace.iconId)}
                      width={24}
                    />
                    <span className="truncate">{workspace.name}</span>
                  </Link>
                </h2>
                <TodoRows
                  manages={workspace.manages}
                  shown={shown}
                  toApprove={toApprove}
                  workspaceId={workspace.workspaceId}
                />
              </section>
            ))
          )}
        </div>
        {!!data && sections.length === 0 && (
          <p className="t-subtitle py-20 text-center font-normal text-fg-muted">
            {m.todo_empty()}
          </p>
        )}
      </PageBody>
    </PagePanel>
  );
}
