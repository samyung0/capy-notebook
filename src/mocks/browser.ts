import { http, passthrough } from 'msw';
import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import {
  getMockScenarioHandlers,
  LAST_SCENARIO,
  type MockScenarioId,
  permanentScenarios,
} from './scenarios';

/** The dev server's modules go straight through. Every request reaches the
 * worker's handlers, each of which parses the request's cookies before
 * matching: on a navigation that imports BlockSuite (about 3,400 modules)
 * that was about 11 s of main thread. */
const devModules = http.all(
  /^https?:\/\/[^/]+\/(?:src|node_modules|vendor|@vite|@id|@fs|@react-refresh)\//,
  () => passthrough()
);

export const worker = setupWorker(devModules, ...handlers);

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
