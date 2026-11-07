import { parseHTML } from 'linkedom';
import type { ReactNode } from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { getLocale, m } from '@/i18n';

/* W1 (Epo 2026-11-07): Done on a board wider than the marking image can read
   asks first, and Done anyway goes on to the image. */

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const toImage = vi.hoisted(() => vi.fn(() => Promise.reject(new Error('x'))));
vi.mock('@/features/blocksuite/drawingBoard', () => ({
  mountDrawingBoard: () => ({
    save: () => ({ bytes: 100, doc: 'AA==' }),
    snapshot: () => 'AA==',
    stats: () => ({
      blocks: [],
      bytes: 100,
      canvas: ['brush'],
      marks: 0,
      span: 2400,
    }),
    toImage,
    unmount() {},
  }),
}));
vi.mock('@/components/ui/userToast', () => ({ userToast() {} }));
const deleteLocalDrawingDraft = vi.hoisted(() =>
  vi.fn(() => Promise.resolve())
);
vi.mock('@/lib/localDb', () => ({
  deleteLocalDrawingDraft,
  localDrawingDraft: () => Promise.resolve(undefined),
  saveLocalDrawingDraft: () => Promise.resolve(),
}));
vi.mock('@/components/ui/Dialog', () => ({
  SimpleDialog: ({
    children,
    footer,
    open,
    title,
  }: {
    children: ReactNode;
    footer: ReactNode;
    open: boolean;
    title: string;
  }) =>
    open && (
      <div role="alertdialog">
        <b>{title}</b>
        {children}
        {footer}
      </div>
    ),
}));

const { createRoot } = await import('react-dom/client');
const { default: DrawingBoardScreen } = await import('./DrawingBoardScreen');
const { finishOpenDrawing } = await import('./drawingValue');

const PINNED = { body: null, marks: '', short: '1', summary: '', title: '1' };

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent === label
  ) as HTMLButtonElement;

it('asks before Done on a wide board, and Done anyway makes the image', async () => {
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <DrawingBoardScreen
        onClose={() => undefined}
        onDone={() => undefined}
        pinned={{ body: null, marks: '', short: '1', summary: '', title: '1' }}
      />
    )
  );
  await act(async () => button(m.drawing_board_done()).click());
  expect(document.querySelector('[role="alertdialog"] b')?.textContent).toBe(
    m.drawing_wide_title()
  );
  expect(toImage).not.toHaveBeenCalled();

  await act(async () => button(m.drawing_wide_done_anyway()).click());
  expect(toImage).toHaveBeenCalledOnce();
});

it('a time limit pressing Done during a Done waits for its upload', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as never);
  let release: (id: string) => void = () => undefined;
  const store = vi.fn(
    (_value: unknown) =>
      new Promise<string | null>((resolve) => {
        release = resolve;
      })
  );
  const onDone = vi.fn();
  await act(async () =>
    root.render(
      <DrawingBoardScreen
        draft="assignment:at_1:p"
        onClose={() => undefined}
        onDone={onDone}
        pinned={PINNED}
        store={store}
        withImage={false}
      />
    )
  );
  let first: Promise<void> = Promise.resolve();
  await act(async () => {
    first = finishOpenDrawing();
  });
  let submitted = false;
  const timeLimit = finishOpenDrawing().then(() => {
    submitted = true;
  });
  await act(async () => undefined);
  expect(store).toHaveBeenCalledOnce();
  expect(submitted).toBe(false);
  // Marked by hand: no marking image is made (Q693).
  expect(store.mock.calls[0][0]).toEqual({ board: 'AA==', image: '' });

  await act(async () => {
    release('dr_1');
    await Promise.all([first, timeLimit]);
  });
  expect(submitted).toBe(true);
  expect(onDone).toHaveBeenCalledWith({
    board: 'AA==',
    drawing: 'dr_1',
    image: '',
  });
  // Stored, its draft goes.
  expect(deleteLocalDrawingDraft).toHaveBeenCalledWith('assignment:at_1:p');
  await act(async () => root.unmount());
});

it('keeps a practice drawing on the device after Done, until Check', async () => {
  deleteLocalDrawingDraft.mockClear();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as never);
  const onDone = vi.fn();
  await act(async () =>
    root.render(
      <DrawingBoardScreen
        draft="quiz:qz_1:p"
        onClose={() => undefined}
        onDone={onDone}
        pinned={PINNED}
        withImage={false}
      />
    )
  );
  await act(async () => finishOpenDrawing());
  expect(onDone).toHaveBeenCalledOnce();
  expect(deleteLocalDrawingDraft).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
