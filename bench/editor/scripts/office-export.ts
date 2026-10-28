// The probe page: fetches a file and its seeded state, exports them in the
// app's own export worker (src/office-runtime/exportCheckpoint.ts), as a
// browser Download would, and reports the time and the page's worst timer
// delay. Driven by office-export.mjs.
import { exportCheckpoint } from '../../../src/office-runtime/exportCheckpoint';
import type { OfficeFormat } from '../../../src/features/files/officeProtocol';

Reflect.set(window, 'officeExportProbe', async (format: OfficeFormat, name: string) => {
  const [base, state] = await Promise.all(
    [`/bench/editor/.results/office-export/files/${name}`, `/bench/editor/.results/office-export/files/${name}.state`].map(async (url) => (await fetch(url)).arrayBuffer())
  );
  let last = performance.now();
  let worstDelay = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worstDelay = Math.max(worstDelay, now - last - 16);
    last = now;
  }, 16);
  const started = performance.now();
  try {
    const out = await exportCheckpoint(format, base, state);
    return { elapsed: performance.now() - started, outputBytes: out.length, worstDelay };
  } finally {
    clearInterval(timer);
  }
});
