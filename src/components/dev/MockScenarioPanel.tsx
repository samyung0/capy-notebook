import { onlineManager } from '@tanstack/react-query';
import { HttpHandler, matchRequestUrl } from 'msw';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { qk } from '@/api/client';
import { queryClient } from '@/api/queryClient';
import { m } from '@/i18n';
import { cancelMockAuthRequests } from '@/mocks/auth';
import { worker } from '@/mocks/browser';
import { setChaosPeers } from '@/mocks/chaosPeers';
import { dialogFiles } from '@/mocks/dialogFiles';
import { errorMaterials } from '@/mocks/errorMaterials';
import { scenarioDriver } from '@/mocks/scenarioDriver';
import { resetScenarioFixtures } from '@/mocks/scenarioFixtures';
import {
  type JourneyId,
  journeyGroup,
  journeyOptions,
  journeyUnavailable,
  runJourney,
} from '@/mocks/scenarioJourneys';
import {
  getMockScenarioHandlers,
  LAST_SCENARIO,
  type MockScenarioId,
  permanentScenarios,
} from '@/mocks/scenarios';
import { router } from '@/router';
import MockDialogPreview from './MockDialogPreview';
import { type MockDialogId, mockDialogOptions } from './mockDialogOptions';

const groups = [...new Set(journeyOptions.map(({ id }) => journeyGroup(id)))];

export default function MockScenarioPanel() {
  const [active, setActive] = useState<string | null>(() =>
    sessionStorage.getItem(LAST_SCENARIO)
  );
  const [status, setStatus] = useState<'idle' | 'running' | 'ready' | 'failed'>(
    'idle'
  );
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<MockDialogId | null>(null);
  const [dialogVersion, setDialogVersion] = useState(0);
  const details = useRef<HTMLDetailsElement>(null);
  const controller = useRef<AbortController | null>(null);
  const previous = useRef<Promise<void>>(Promise.resolve());
  const openDialog = (id: MockDialogId) => {
    setDialog(id);
    setDialogVersion((value) => value + 1);
  };

  useEffect(
    () => () => {
      controller.current?.abort();
      cancelMockAuthRequests();
      setChaosPeers(false);
      onlineManager.setOnline(true);
    },
    []
  );

  const launch = (id: string | null) => {
    controller.current?.abort();
    cancelMockAuthRequests();
    const current = new AbortController();
    controller.current = current;
    setStatus('running');
    setMessage(null);
    setActive(id);
    setDialog(null);
    details.current?.removeAttribute('open');
    if (id) sessionStorage.setItem(LAST_SCENARIO, id);
    else sessionStorage.removeItem(LAST_SCENARIO);
    const task = previous.current
      .catch(() => {})
      .then(async () => {
        current.signal.throwIfAborted();
        worker.resetHandlers();
        setChaosPeers(false);
        onlineManager.setOnline(true);
        toast.dismiss();
        queryClient.setQueryData(qk.eventStream, { status: 'connected' });
        // Stop the previous fixture's stream before its conversation is removed.
        if (router.state.location.pathname === '/workspaces/ws_scenarios')
          document
            .querySelector<HTMLButtonElement>(
              `button[aria-label="${m.chat_stop()}"]`
            )
            ?.click();
        // Leave the previous fixture before dropping its room or clearing drafts.
        await router.navigate({
          ignoreBlocker:
            router.state.location.pathname === '/workspaces/ws_scenarios',
          to: '/workspaces',
        });
        const ui = scenarioDriver(current.signal);
        await ui.wait(
          () =>
            !document.querySelector(
              'textarea[aria-label], iframe[src*="office-runtime"], [contenteditable="true"]'
            ),
          'previous editor closed'
        );
        await ui.wait(
          () => queryClient.isMutating() === 0,
          'previous submission settled'
        );
        await resetScenarioFixtures(!!id);
        current.signal.throwIfAborted();
        await queryClient.cancelQueries();
        queryClient.removeQueries();
        if (!id) {
          await router.invalidate();
          return;
        }
        if (id.startsWith('file:') || id.startsWith('material:')) {
          const [kind, fixture] = id.split(':');
          await router.navigate({
            to: `/workspaces/ws_bio?${kind}=${encodeURIComponent(fixture)}`,
          });
          if (fixture === 'mock-preview-text') {
            await ui.click(m.material_mode(), '[role="combobox"]');
            await ui.click(m.material_mode_edit(), '[role="option"]');
          }
          return;
        }
        if (id.startsWith('dialog:')) {
          await router.navigate({
            params: { workspaceId: 'ws_scenarios' },
            to: '/workspaces/$workspaceId',
          });
          openDialog(id.slice(7) as MockDialogId);
          return;
        }
        if (id === 'page-not-found') {
          router.history.push('/scenario-page-does-not-exist');
          return;
        }
        const unavailable = journeyUnavailable(id);
        if (unavailable) throw new Error(unavailable);
        let matchedRequests = 0;
        const expected = getMockScenarioHandlers(id as MockScenarioId).filter(
          (handler): handler is HttpHandler => handler instanceof HttpHandler
        );
        const observed = ({ request }: { request: Request }) => {
          if (
            expected.some(
              (handler) =>
                handler.info.method === request.method &&
                typeof handler.info.path !== 'function' &&
                matchRequestUrl(
                  new URL(request.url),
                  handler.info.path,
                  location.origin
                ).matches
            )
          )
            matchedRequests++;
        };
        worker.events.on('request:match', observed);
        try {
          const note = await runJourney(
            id as JourneyId,
            current.signal,
            openDialog
          );
          if (note) setMessage(note);
          // Let the owning query/mutation commit its response before retiring a
          // temporary fault. Nothing refetches or remounts the resulting page.
          await ui.wait(
            () =>
              matchedRequests > 0 ||
              expected.length === 0 ||
              id === 'workspace-timeout' ||
              id === 'auth-busy',
            'scenario request'
          );
          if (
            ![
              'offline',
              'workspace-timeout',
              'auth-busy',
              'import-job-pending',
            ].includes(id)
          ) {
            await ui.wait(
              () =>
                queryClient.isFetching() === 0 &&
                queryClient.isMutating() === 0,
              'application request settled'
            );
          }
          if (!note && !['invite-success', 'collab-chaos'].includes(id)) {
            await ui.wait(
              () =>
                document.querySelector(
                  '[role="alert"], [data-sonner-toast], [data-error-surface]'
                ),
              'application error rendered'
            );
          }
          if (!permanentScenarios.includes(id) && id !== 'import-job-pending')
            worker.resetHandlers();
        } finally {
          worker.events.removeListener('request:match', observed);
        }
      });
    previous.current = task.then(
      () => {
        if (controller.current === current) setStatus(id ? 'ready' : 'idle');
      },
      (error: unknown) => {
        if (current.signal.aborted || controller.current !== current) return;
        worker.resetHandlers();
        setStatus('failed');
        setMessage(error instanceof Error ? error.message : String(error));
        details.current?.setAttribute('open', '');
      }
    );
  };

  return createPortal(
    <>
      {dialog && (
        <MockDialogPreview
          dialog={dialog}
          key={dialogVersion}
          onClose={() => setDialog(null)}
        />
      )}
      <details
        className="pointer-events-auto fixed right-3 bottom-3 z-10000 max-h-[85dvh] w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-card border border-line bg-surface p-2 text-fg text-xs shadow-lg"
        data-active-scenario={active ?? ''}
        data-scenario-status={status}
        data-testid="mock-scenario-panel"
        ref={details}
      >
        <summary className="cursor-pointer font-semibold">
          User scenarios{status === 'running' ? ' · Opening…' : ''}
        </summary>
        <div className="mt-2 grid gap-2">
          <p>
            One click opens the real application and runs the steps that reach
            the selected state.
          </p>
          {active && (
            <p>
              {journeyOptions.find((option) => option.id === active)?.label ??
                active}
            </p>
          )}
          {message && (
            <p role={status === 'failed' ? 'alert' : 'status'}>{message}</p>
          )}
          <div className="flex gap-2">
            <button
              className="h-8 flex-1 rounded-button border border-line px-2"
              disabled={!active}
              onClick={() => launch(active)}
              type="button"
            >
              Run again
            </button>
            <button
              className="h-8 flex-1 rounded-button border border-line px-2"
              onClick={() => launch(null)}
              type="button"
            >
              Reset
            </button>
          </div>
          <fieldset className="grid gap-1 border-line border-t pt-2">
            <legend className="px-1 font-semibold">
              Workspace files and materials
            </legend>
            {[
              ...dialogFiles.map(({ id, name }) => ({
                id: `file:${id}`,
                label: name,
              })),
              ...errorMaterials.map(({ id, title }) => ({
                id: `material:${id}`,
                label: title,
              })),
            ].map(({ id, label }) => (
              <button
                className="min-h-8 rounded-button border border-line px-2 text-left"
                key={id}
                onClick={() => launch(id)}
                type="button"
              >
                {label}
              </button>
            ))}
          </fieldset>
          {groups.map((group) => (
            <fieldset
              className="grid gap-1 border-line border-t pt-2"
              key={group}
            >
              <legend className="px-1 font-semibold">{group}</legend>
              {journeyOptions
                .filter(({ id }) => journeyGroup(id) === group)
                .map(({ id, label }) => (
                  <button
                    className="min-h-8 rounded-button border border-line px-2 text-left disabled:opacity-50"
                    data-scenario={id}
                    disabled={!!journeyUnavailable(id)}
                    key={id}
                    onClick={() => launch(id)}
                    title={journeyUnavailable(id)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
            </fieldset>
          ))}
          <fieldset className="grid gap-1 border-line border-t pt-2">
            <legend className="px-1 font-semibold">Product dialogs</legend>
            {mockDialogOptions.map(({ id, label }) => (
              <button
                className="min-h-8 rounded-button border border-line px-2 text-left"
                key={id}
                onClick={() => launch(`dialog:${id}`)}
                type="button"
              >
                {label}
              </button>
            ))}
            <button
              className="min-h-8 rounded-button border border-line px-2 text-left"
              onClick={() => launch('page-not-found')}
              type="button"
            >
              Page not found
            </button>
          </fieldset>
        </div>
      </details>
    </>,
    document.body
  );
}
