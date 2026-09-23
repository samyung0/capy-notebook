import { onlineManager } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { qk } from '@/api/client';
import { queryClient, showErrorToast } from '@/api/queryClient';
import { worker } from '@/mocks/browser';
import { setChaosPeers } from '@/mocks/chaosPeers';
import {
  getMockScenarioHandlers,
  type MockScenarioId,
  mockScenarioOptions,
  storedMockScenario,
  storeMockScenario,
} from '@/mocks/scenarios';
import { toastErrors } from '@/mocks/toastErrors';
import { router } from '@/router';
import MockDialogPreview from './MockDialogPreview';
import { type MockDialogId, mockDialogOptions } from './mockDialogOptions';

const MOCKS_ENABLED =
  import.meta.env.DEV && import.meta.env.VITE_USE_MSW !== 'false';

type Probe = 'chunk' | 'error' | null;

// errorKind reads navigator.onLine, so the offline toast shadows it for one call.
function spawnToast({ error, kind }: (typeof toastErrors)[number]) {
  if (kind !== 'offline') return showErrorToast(error());
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => false,
  });
  try {
    showErrorToast(error());
  } finally {
    Reflect.deleteProperty(navigator, 'onLine');
  }
}

export default function MockScenarioPanel() {
  const [selected, setSelected] = useState<MockScenarioId>(storedMockScenario);
  const [active, setActive] = useState<MockScenarioId>(storedMockScenario);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [probe, setProbe] = useState<Probe>(null);
  const [dialog, setDialog] = useState<MockDialogId | null>(null);
  const [dialogVersion, setDialogVersion] = useState(0);
  const [fresh, setFresh] = useState(true);
  const [applying, setApplying] = useState(false);
  const option = mockScenarioOptions.find(({ id }) => id === selected);

  useEffect(() => {
    onlineManager.setOnline(active !== 'offline');
    queryClient.setQueryData(qk.eventStream, {
      status:
        active === 'connection-reconnecting' ? 'disconnected' : 'connected',
    });
  }, [active]);

  useEffect(() => {
    worker.use(...getMockScenarioHandlers(storedMockScenario()));
    setChaosPeers(storedMockScenario() === 'collab-chaos');
    return () => {
      onlineManager.setOnline(true);
      setChaosPeers(false);
      worker.resetHandlers();
      queryClient.setQueryData(qk.eventStream, { status: 'connected' });
    };
  }, []);

  if (!MOCKS_ENABLED) return null;
  if (probe === 'error') throw new Error('Mock root-boundary probe');
  if (probe === 'chunk') {
    throw new TypeError(
      'Failed to fetch dynamically imported module: /mock/chunk.js'
    );
  }

  const apply = async (scenario: MockScenarioId) => {
    setApplying(true);
    await queryClient.cancelQueries();
    worker.resetHandlers();
    const handlers = getMockScenarioHandlers(scenario);
    if (handlers.length > 0) worker.use(...handlers);
    onlineManager.setOnline(scenario !== 'offline');
    setChaosPeers(scenario === 'collab-chaos');
    setActive(scenario);
    storeMockScenario(scenario);
    try {
      if (scenario !== 'offline') {
        if (fresh) await queryClient.resetQueries();
        else await queryClient.invalidateQueries();
        await router.invalidate();
      }
      queryClient.setQueryData(qk.eventStream, {
        status:
          scenario === 'connection-reconnecting' ? 'disconnected' : 'connected',
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      {dialog && (
        <MockDialogPreview
          dialog={dialog}
          key={dialogVersion}
          onClose={() => setDialog(null)}
        />
      )}
      <details
        className="fixed right-3 bottom-3 z-100 max-h-[85dvh] w-80 max-w-[calc(100vw-24px)] overflow-y-auto rounded-card border border-line bg-surface p-2 text-fg text-xs shadow-lg"
        data-testid="mock-scenario-panel"
        ref={detailsRef}
      >
        <summary className="cursor-pointer font-semibold">
          User scenarios
          {active === 'none' ? '' : ` · ${active}`}
        </summary>
        <div className="mt-2 grid gap-2">
          <label className="grid gap-1" htmlFor="mock-error-scenario">
            <span>Scenario</span>
            <select
              className="h-8 rounded-button border border-line bg-page px-2"
              id="mock-error-scenario"
              onChange={(event) =>
                setSelected(event.target.value as MockScenarioId)
              }
              value={selected}
            >
              {mockScenarioOptions.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.label}
                </option>
              ))}
            </select>
          </label>
          {option && 'hint' in option && <p>{option.hint}</p>}
          {selected.startsWith('chat-openui-') && (
            <p>
              Saved previews are also in Biology 101 → Chat → History. Clear the
              scenario to return to the default overview response.
            </p>
          )}
          {selected.startsWith('auth-') && (
            <p>
              Use the auth links below. Any valid email, password and nonempty
              code work unless the selected step fails. Apply code errors after
              reaching the code step.
            </p>
          )}
          <label className="flex items-center gap-2">
            <input
              checked={fresh}
              onChange={(event) => setFresh(event.target.checked)}
              type="checkbox"
            />
            Clear cached responses when applying
          </label>
          <div className="flex gap-2">
            <button
              className="h-8 flex-1 rounded-button bg-action px-2 font-semibold text-action-fg"
              disabled={applying}
              onClick={() => void apply(selected)}
              type="button"
            >
              Apply scenario
            </button>
            <button
              className="h-8 rounded-button border border-line px-2 font-semibold"
              onClick={() => {
                setSelected('none');
                void apply('none');
              }}
              type="button"
            >
              Clear
            </button>
          </div>
          <fieldset className="grid grid-cols-2 gap-1 border-line border-t pt-2">
            <legend className="px-1 font-semibold">Open page</legend>
            {[
              ['/sign-in', 'Sign in'],
              ['/sign-up', 'Sign up'],
              ['/forgot-password', 'Reset password'],
              ['/sso-callback', 'SSO callback'],
              ['/workspace-invites/mock-preview', 'Invitation'],
              ['/', 'Dashboard'],
              ['/workspaces/ws_bio', 'Biology 101'],
            ].map(([path, label]) => (
              <button
                className="h-8 rounded-button border border-line px-2 text-left"
                key={path}
                onClick={() => {
                  router.history.push(path);
                  detailsRef.current?.removeAttribute('open');
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </fieldset>
          <fieldset className="grid gap-1 border-line border-t pt-2">
            <legend className="px-1 font-semibold">Open dummy dialog</legend>
            {mockDialogOptions.map(({ id, label }) => (
              <button
                className="min-h-8 rounded-button border border-line px-2 text-left"
                key={id}
                onClick={() => {
                  detailsRef.current?.removeAttribute('open');
                  setDialog(id);
                  setDialogVersion((version) => version + 1);
                }}
                type="button"
              >
                {label}
              </button>
            ))}
            {dialog && (
              <button
                className="h-8 rounded-button border border-line px-2 text-left"
                onClick={() => setDialog(null)}
                type="button"
              >
                Close preview
              </button>
            )}
          </fieldset>
          <fieldset className="grid grid-cols-2 gap-1 border-line border-t pt-2">
            <legend className="px-1 font-semibold">Error toasts</legend>
            {toastErrors.map((probe) => (
              <button
                className="h-8 rounded-button border border-line px-2 text-left"
                key={probe.label}
                onClick={() => spawnToast(probe)}
                type="button"
              >
                {probe.label}
              </button>
            ))}
          </fieldset>
          <fieldset className="grid gap-1 border-line border-t pt-2">
            <legend className="px-1 font-semibold">Boundary probes</legend>
            <button
              className="h-8 rounded-button border border-line px-2 text-left"
              onClick={() => setProbe('error')}
              type="button"
            >
              Throw regular error
            </button>
            <button
              className="h-8 rounded-button border border-line px-2 text-left"
              onClick={() => setProbe('chunk')}
              type="button"
            >
              Throw chunk-load error
            </button>
          </fieldset>
        </div>
      </details>
    </>
  );
}
