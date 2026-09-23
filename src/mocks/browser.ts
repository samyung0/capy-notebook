import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import {
  getMockScenarioHandlers,
  LAST_SCENARIO,
  type MockScenarioId,
  permanentScenarios,
} from './scenarios';

export const worker = setupWorker(...handlers);

export async function startMockServer() {
  const saved = sessionStorage.getItem(LAST_SCENARIO);
  // Restore persistent faults without replaying navigation, edits or submissions.
  if (saved && permanentScenarios.includes(saved))
    worker.use(...getMockScenarioHandlers(saved as MockScenarioId));
  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: true,
  });
}
