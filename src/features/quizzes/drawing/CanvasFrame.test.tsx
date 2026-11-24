import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getLocale, m } from '@/i18n';

/* A canvas's board as the quiz shows it (Epo 2026-11-23): a shared page
   fetches it through its own asset route, and a board open full screen keeps
   what it opened from while a co-editor's Done changes the block. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

vi.mock('./DrawingBoardScreen', () => ({
  default: ({ hidden, saved }: { hidden?: boolean; saved?: string }) => (
    <i data-board={hidden ? 'hidden' : 'shown'} data-saved={saved} />
  ),
}));

const { createRoot } = await import('react-dom/client');
const { rememberBoardAsset } = await import('@/features/blocksuite/boardAsset');
const { AssetUrlContext } = await import('@/features/materials/MediaAssetView');
const { CanvasAnswer } = await import('./CanvasAnswer');
const { CanvasField } = await import('./CanvasField');

const PINNED = { body: null, marks: '', short: '1', summary: '', title: '1' };

let unmount = () => {};
afterEach(() => {
  act(() => unmount());
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as never);
  unmount = () => root.unmount();
  await act(async () => root.render(node));
  return {
    host,
    rerender: (next: ReactNode) => act(async () => root.render(next)),
  };
}

/** Lets fetches, inflating and lazy code settle until `done` holds. */
async function until(done: () => boolean) {
  for (let i = 0; i < 50 && !done(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
}

const button = (host: Element, name: string) =>
  [...host.querySelectorAll('button')].find(
    (item) => item.textContent === name
  );

it("a shared page fetches a canvas part's board through its asset route, and says when it cannot", async () => {
  const gzipped = await new Response(
    new Blob([new Uint8Array([1, 2, 3])])
      .stream()
      .pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith('asset_here')
      ? new Response(gzipped)
      : new Response(null, { status: 404 })
  );
  vi.stubGlobal('fetch', fetcher);
  const page = (board: string) => (
    <AssetUrlContext.Provider value={(id) => `/p/quizzes/tok/assets/${id}`}>
      <CanvasAnswer
        canvas={{ board, image: 'asset_picture', type: 'canvas' }}
        canvasName="q:part:p"
        disabled={false}
        onChange={() => undefined}
        partId="p"
        pinned={PINNED}
        review={false}
        value={null}
      />
    </AssetUrlContext.Provider>
  );
  const { host, rerender } = await render(page('asset_here'));
  const answer = () => button(host, m.question_canvas_answer());
  await until(() => answer()?.disabled === false);
  expect(fetcher).toHaveBeenCalledWith('/p/quizzes/tok/assets/asset_here');
  expect(answer()?.disabled).toBe(false);

  await rerender(page('asset_lost'));
  const unsupported = m.material_unsupported_block();
  await until(() => host.textContent?.includes(unsupported) ?? false);
  expect(host.textContent).toContain(unsupported);
  expect(answer()).toBeUndefined();
});

it("an open canvas board keeps the canvas it opened from when a co-editor's Done replaces it", async () => {
  rememberBoardAsset('asset_mine', 'MINE');
  rememberBoardAsset('asset_theirs', 'THEIRS');
  const field = (board: string) => (
    <CanvasField
      block={{ board, image: `${board}_picture`, type: 'canvas' }}
      hint={m.question_canvas_hint_teacher()}
      onChange={() => undefined}
      pinned={PINNED}
      upload={() => Promise.reject(new Error('no upload'))}
    />
  );
  const { host, rerender } = await render(field('asset_mine'));
  const edit = () => button(host, m.question_canvas_edit());
  await until(() => edit()?.disabled === false);
  await act(async () => edit()?.click());
  const board = () => host.querySelector('[data-board]');
  await until(() => board() !== null);
  expect(board()?.getAttribute('data-saved')).toBe('MINE');

  await rerender(field('asset_theirs'));
  await until(() => board()?.getAttribute('data-saved') !== 'MINE');
  expect(board()?.getAttribute('data-board')).toBe('shown');
  expect(board()?.getAttribute('data-saved')).toBe('MINE');
});
