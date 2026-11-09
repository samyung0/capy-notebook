import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';

/* Fix 4 (Epo 2026-11-07): a drawing part or sample field showing mounts its
   board ahead, one per page. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
// Idle callbacks run when the test says so.
const idle = new Map<number, () => void>();
let idleId = 0;
Object.assign(window, {
  cancelIdleCallback: (id: number) => idle.delete(id),
  requestIdleCallback: (run: () => void) => {
    idle.set(++idleId, run);
    return idleId;
  },
});
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

vi.mock('./DrawingBoardScreen', () => ({
  default: ({ hidden }: { hidden: boolean }) => (
    <i data-board={hidden ? 'hidden' : 'shown'} />
  ),
}));
const link = vi.hoisted(() => ({
  resolve: (_url: { url: string }) => undefined as void,
}));
vi.mock('@/features/materials/resolvedAssetLinks', () => ({
  assetLink: () =>
    new Promise((resolve) => {
      link.resolve = resolve;
    }),
}));

const { createRoot } = await import('react-dom/client');
const { useBoardAhead } = await import('./boardPrefetch');
const { DrawingAnswer } = await import('./DrawingAnswer');
const { DrawnSampleField } = await import('./DrawnSample');

const PINNED = { body: null, marks: '', short: '1', summary: '', title: '1' };

/** Runs the idle callbacks, then lets the module load settle. */
const runIdle = () =>
  act(async () => {
    for (const [id, run] of [...idle]) {
      idle.delete(id);
      run();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function Part({ ahead, id }: { ahead: boolean; id: string }) {
  const held = useBoardAhead(ahead);
  return <i data-held={String(held)} data-part={id} />;
}

const held = () =>
  [...document.querySelectorAll('[data-held="true"]')].map((part) =>
    part.getAttribute('data-part')
  );

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  return createRoot(host as never);
}

it('one part of several holds the board, and the next part takes it once that one leaves', async () => {
  const first = mount();
  const second = mount();
  await act(async () => {
    first.render(<Part ahead id="a" />);
    second.render(<Part ahead id="b" />);
  });
  expect(held()).toEqual([]);
  await runIdle();
  expect(held()).toEqual(['a']);

  // The page moves on: the next question's part takes it.
  await act(async () => first.unmount());
  const third = mount();
  await act(async () => third.render(<Part ahead id="c" />));
  await runIdle();
  expect(held()).toEqual(['c']);
  await act(async () => {
    second.unmount();
    third.unmount();
  });
});

it('a part in review or disabled mounts no board ahead; one taking an answer does', async () => {
  const root = mount();
  const answer = (props: { disabled: boolean; review: boolean }) => (
    <DrawingAnswer
      onChange={() => undefined}
      partId="p"
      pinned={PINNED}
      value={null}
      {...props}
    />
  );
  await act(async () => root.render(answer({ disabled: false, review: true })));
  await runIdle();
  expect(document.querySelector('[data-board]')).toBeNull();
  await act(async () => root.render(answer({ disabled: true, review: false })));
  await runIdle();
  expect(document.querySelector('[data-board]')).toBeNull();

  await act(async () =>
    root.render(answer({ disabled: false, review: false }))
  );
  await runIdle();
  expect(
    document.querySelector('[data-board]')?.getAttribute('data-board')
  ).toBe('hidden');
  await act(async () => root.unmount());
});

it('a sample field holds the board only once its sample board is fetched', async () => {
  const gzipped = await new Response(
    new Blob([new Uint8Array([1, 2, 3])])
      .stream()
      .pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(gzipped))
  );
  const root = mount();
  await act(async () =>
    root.render(
      <DrawnSampleField
        onChange={() => undefined}
        pinned={PINNED}
        sample={{ board: 'asset_board', image: 'asset_image' }}
        upload={() => Promise.reject(new Error('no upload'))}
      />
    )
  );
  await runIdle();
  expect(document.querySelector('[data-board]')).toBeNull();

  await act(async () => link.resolve({ url: 'https://assets.invalid/board' }));
  // Fetched and inflated, the sample shows (unreadable here) and the board waits
  // for idle time.
  for (let i = 0; i < 50 && idle.size === 0; i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  await runIdle();
  expect(
    document.querySelector('[data-board]')?.getAttribute('data-board')
  ).toBe('hidden');
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
