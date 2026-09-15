import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { getMockScenarioHandlers, storedMockScenario } from './scenarios';

export const worker = setupWorker(...handlers);

export async function startMockServer() {
  worker.use(...getMockScenarioHandlers(storedMockScenario()));
  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: true,
  });
}
