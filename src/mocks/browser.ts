import { http, passthrough } from 'msw';
import { setupWorker } from 'msw/browser';
import { claimSourceCache } from '@/lib/sourceCache';
import { user } from './db';
import { handlers } from './handlers';
import {
  getMockScenarioHandlers,
  LAST_SCENARIO,
  type MockScenarioId,
  permanentScenarios,
} from './scenarios';

/** The dev server's modules, and a build's own chunks (`/assets/`), go straight
 * through. Every request reaches the worker's handlers, each of which parses
 * the request's cookies before matching: on a navigation that imports
 * BlockSuite (about 3,400 modules) that was about 11 s of main thread, and a
 * build's canvas chunks took 2.5 s at 4x CPU. */
const devModules = http.all(
  /^https?:\/\/[^/]+\/(?:src|node_modules|vendor|assets|@vite|@id|@fs|@react-refresh)\//,
  () => passthrough()
);

export const worker = setupWorker(devModules, ...handlers);

/** The MSW benches' own worker script, defined only in their build
 * (bench/editor/scripts/vite.cap.config.ts): it sends the build's chunks to
 * the network before MSW's worker sees them. */
declare const __CAPY_BENCH_MSW_WORKER__: string;

/** For a spec's `worker.use`, from the app's own instance of the module. */
export { HttpResponse, http } from 'msw';

export async function startMockServer() {
  const saved = sessionStorage.getItem(LAST_SCENARIO);
  // Restore persistent faults without replaying navigation, edits or submissions.
  if (saved && permanentScenarios.includes(saved))
    worker.use(...getMockScenarioHandlers(saved as MockScenarioId));
  await worker.start({
    onUnhandledRequest: 'bypass',
    quiet: true,
    // `typeof` reads an undefined constant safely: no other build defines it.
    ...(typeof __CAPY_BENCH_MSW_WORKER__ === 'string' && {
      serviceWorker: { url: __CAPY_BENCH_MSW_WORKER__ },
    }),
  });
  // No sign-in here to claim the device's store (AuthProvider).
  await claimSourceCache(user.id);
}
