/** Fixture identity for the editor performance harness (bench/editor).
 *
 * The near-limit document itself is the shared load-test note built by
 * `noteContent/loadTest.ts` — a ~2MB, feature-mixed document sized against the
 * real material limits — so the harness measures the same worst case the rest
 * of the app is load-tested against instead of a second, private generator.
 * Only the tiny baseline note lives here, because a one-paragraph document has
 * nothing to share.
 *
 * Kept free of runtime imports: the perf specs also import this module for the
 * ids, and the Playwright project cannot resolve the `@/` alias. Type-only
 * imports are erased by both Vite and Playwright's transpiler.
 */

export const PERF_WORKSPACE_ID = 'ws_bio';

/** Seeded by `VITE_LOAD_TEST_SEED`. */
export const PERF_LARGE_NOTE = {
  id: 'mat_note_bio_load_test',
  readyText: 'Load test — near 2MB feature soup',
  title: 'Load test — near 2MB feature soup',
} as const;

/** The common-subset note (`noteContent/commonSubset.ts`), at the load-test
 * note's size. Seeded with it, and only for a page whose session holds
 * `PERF_COMMON_SEED_KEY` (the bench's comparison cases set it before the app
 * loads, to the size as a fraction of the load-test note's: 1 but in a local
 * smoke run), so the budgeted cases boot exactly as before. */
export const PERF_COMMON_NOTE = {
  id: 'mat_note_perf_common',
  // Short: a title that wraps sends End to its first line's end.
  readyText: 'Common subset note',
  title: 'Common subset note',
} as const;

export const PERF_COMMON_SEED_KEY = 'capy.perf.commonSubset';

export const PERF_SMALL_NOTE = {
  id: 'mat_perf_small',
  readyText: 'Baseline note for typing latency.',
  title: 'Perf probe — baseline note',
} as const;

interface PerfNode {
  children?: PerfNode[];
  id?: string;
  text?: string;
  type?: string;
  [key: string]: unknown;
}

export interface PerfDocument {
  schemaVersion: 1;
  value: PerfNode[];
}

export function buildSmallPerfDocument(): PerfDocument {
  return {
    schemaVersion: 1,
    value: [
      {
        children: [{ text: PERF_SMALL_NOTE.readyText }],
        id: 'perf_1',
        type: 'p',
      },
    ],
  };
}
