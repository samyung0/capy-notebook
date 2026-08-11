import { onlineManager } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { queryClient } from '@/api/queryClient';
import { worker } from '@/mocks/browser';
import {
  getMockScenarioHandlers,
  type MockScenarioId,
  mockScenarioOptions,
} from '@/mocks/scenarios';

const MOCKS_ENABLED =
  import.meta.env.DEV && import.meta.env.VITE_USE_MSW !== 'false';

type Probe = 'chunk' | 'error' | null;

export default function MockScenarioPanel() {
  const [selected, setSelected] = useState<MockScenarioId>('none');
  const [active, setActive] = useState<MockScenarioId>('none');
  const [probe, setProbe] = useState<Probe>(null);

  useEffect(
    () => () => {
      onlineManager.setOnline(true);
      worker.resetHandlers();
    },
    []
  );

  if (!MOCKS_ENABLED) return null;
  if (probe === 'error') throw new Error('Mock root-boundary probe');
  if (probe === 'chunk') {
    throw new TypeError(
      'Failed to fetch dynamically imported module: /mock/chunk.js'
    );
  }

  const apply = (scenario: MockScenarioId) => {
    worker.resetHandlers();
    onlineManager.setOnline(scenario !== 'offline');
    const handlers = getMockScenarioHandlers(scenario);
    if (handlers.length > 0) worker.use(...handlers);
    setActive(scenario);
    void queryClient.invalidateQueries();
  };

  return (
    <details
      className="fixed right-3 bottom-3 z-100 w-64 rounded-card border border-line bg-surface p-2 text-fg text-xs shadow-lg"
      data-testid="mock-scenario-panel"
    >
      <summary className="cursor-pointer font-semibold">
        Error scenarios
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
        <div className="flex gap-2">
          <button
            className="h-8 flex-1 rounded-button bg-action px-2 font-semibold text-action-fg"
            onClick={() => apply(selected)}
            type="button"
          >
            Apply scenario
          </button>
          <button
            className="h-8 rounded-button border border-line px-2 font-semibold"
            onClick={() => {
              setSelected('none');
              apply('none');
            }}
            type="button"
          >
            Clear
          </button>
        </div>
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
  );
}
