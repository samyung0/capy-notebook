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
// Idle callbacks run when a test says so.
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

type MountOptions = {
  fitPadding?: number[];
  onChange?: () => void;
  saved?: string;
};
const toImage = vi.hoisted(() => vi.fn(() => Promise.reject(new Error('x'))));
const putAway = vi.hoisted(() => vi.fn());
const fit = vi.hoisted(() => vi.fn());
const mountDrawingBoard = vi.hoisted(() =>
  vi.fn((_host: unknown, _options: MountOptions): unknown => undefined)
);
vi.mock('@/features/blocksuite/drawingBoard', () => ({ mountDrawingBoard }));
const handle = {
  fit,
  putAway,
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
};
mountDrawingBoard.mockImplementation(() => handle);
const userToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/userToast', () => ({ userToast }));
const deleteLocalDrawingDraft = vi.hoisted(() =>
  vi.fn(() => Promise.resolve())
);
const localDrawingDraft = vi.hoisted(() =>
  vi.fn(
    (_key: string): Promise<{ doc: string } | undefined> =>
      Promise.resolve(undefined)
  )
);
const saveLocalDrawingDraft = vi.hoisted(() =>
  vi.fn((_draft: unknown) => Promise.resolve())
);
vi.mock('@/lib/localDb', () => ({
  deleteLocalDrawingDraft,
  localDrawingDraft,
  saveLocalDrawingDraft,
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

it('a board mounted ahead is out of sight and takes no time-limit Done until shown', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as never);
  const onDone = vi.fn();
  const screen = (hidden: boolean) => (
    <DrawingBoardScreen
      draft="quiz:qz_2:p"
      hidden={hidden}
      onClose={() => undefined}
      onDone={onDone}
      pinned={PINNED}
      withImage={false}
    />
  );
  await act(async () => root.render(screen(true)));
  // Earlier tests leave their boards: this one is the last.
  const last = () => [...document.querySelectorAll('.answer-board')].at(-1);
  const board = last() as HTMLElement;
  expect(board.hasAttribute('inert')).toBe(true);
  await act(async () => finishOpenDrawing());
  expect(onDone).not.toHaveBeenCalled();

  // Draw shows the same board: it doesn't mount again.
  await act(async () => root.render(screen(false)));
  expect(last()).toBe(board);
  expect(board.hasAttribute('inert')).toBe(false);
  await act(async () => finishOpenDrawing());
  expect(onDone).toHaveBeenCalledOnce();

  // Put away again, it keeps no selection and takes no more keys.
  putAway.mockClear();
  await act(async () => root.render(screen(true)));
  expect(putAway).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

const runIdle = () =>
  act(async () => {
    for (const [id, run] of [...idle]) {
      idle.delete(id);
      run();
    }
  });

function practice(onDone = vi.fn(), onClose = vi.fn()) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as never);
  const screen = (hidden: boolean) => (
    <DrawingBoardScreen
      draft="quiz:qz_3:p"
      hidden={hidden}
      onClose={onClose}
      onDone={onDone}
      pinned={PINNED}
      saved="SAVED"
      withImage={false}
    />
  );
  return {
    hide: () => act(async () => root.render(screen(true))),
    show: () => act(async () => root.render(screen(false))),
    unmount: () => act(async () => root.unmount()),
  };
}

it('a board ahead mounts in idle time or on Draw, and Draw fits it to the screen as it is then', async () => {
  mountDrawingBoard.mockClear();
  const ahead = practice();
  await ahead.hide();
  expect(mountDrawingBoard).not.toHaveBeenCalled();
  await runIdle();
  expect(mountDrawingBoard).toHaveBeenCalledOnce();
  // A tablet turned to a phone's width before Draw.
  fit.mockClear();
  Object.assign(window, { innerWidth: 600 });
  await ahead.show();
  expect(mountDrawingBoard).toHaveBeenCalledOnce();
  expect(fit).toHaveBeenCalledWith([72, 12, 96, 12]);
  await ahead.unmount();
  Object.assign(window, { innerWidth: 1280 });

  // Draw before the idle time mounts at once, and only once.
  mountDrawingBoard.mockClear();
  const early = practice();
  await early.hide();
  await early.show();
  expect(mountDrawingBoard).toHaveBeenCalledOnce();
  await runIdle();
  expect(mountDrawingBoard).toHaveBeenCalledOnce();
  await early.unmount();
});

it('a board ahead keeps no draft and leaves the device draft and the answer alone', async () => {
  saveLocalDrawingDraft.mockClear();
  deleteLocalDrawingDraft.mockClear();
  localDrawingDraft.mockResolvedValueOnce({ doc: 'DRAFT' });
  // BlockSuite settling a note card's height writes to the board as it mounts.
  mountDrawingBoard.mockImplementationOnce((_host, options) => {
    options.onChange?.();
    return handle;
  });
  const onDone = vi.fn();
  const ahead = practice(onDone);
  await ahead.hide();
  await runIdle();
  expect(mountDrawingBoard.mock.lastCall?.[1].saved).toBe('DRAFT');
  await ahead.unmount();
  expect(saveLocalDrawingDraft).not.toHaveBeenCalled();
  expect(deleteLocalDrawingDraft).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

it('the last strokes go to the device at once on Done, and on teardown', async () => {
  saveLocalDrawingDraft.mockClear();
  const onDone = vi.fn();
  const board = practice(onDone);
  await board.show();
  const stroke = () => mountDrawingBoard.mock.lastCall?.[1].onChange?.();
  // A stroke, then Done well within the draft's 800 ms.
  await act(async () => stroke());
  await act(async () => finishOpenDrawing());
  expect(saveLocalDrawingDraft).toHaveBeenCalledWith(
    expect.objectContaining({ doc: 'AA==', key: 'quiz:qz_3:p' })
  );
  expect(saveLocalDrawingDraft.mock.invocationCallOrder[0]).toBeLessThan(
    onDone.mock.invocationCallOrder[0]
  );

  await act(async () => stroke());
  await board.unmount();
  expect(saveLocalDrawingDraft).toHaveBeenCalledTimes(2);
});

it('a hidden mount that fails says nothing until Draw, and each Draw tries again', async () => {
  userToast.mockClear();
  mountDrawingBoard.mockClear();
  const fail = () => {
    throw new Error('no board');
  };
  mountDrawingBoard.mockImplementationOnce(fail).mockImplementationOnce(fail);
  const onClose = vi.fn();
  const onDone = vi.fn();
  const board = practice(onDone, onClose);
  await board.hide();
  await runIdle();
  expect(mountDrawingBoard).toHaveBeenCalledOnce();
  expect(userToast).not.toHaveBeenCalled();

  // Draw tries again; failing then, it says so and closes.
  await board.show();
  expect(mountDrawingBoard).toHaveBeenCalledTimes(2);
  expect(userToast).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();

  // The next Draw opens it.
  await board.hide();
  await board.show();
  expect(mountDrawingBoard).toHaveBeenCalledTimes(3);
  await act(async () => finishOpenDrawing());
  expect(onDone).toHaveBeenCalledOnce();
  expect(userToast).toHaveBeenCalledOnce();
  await board.unmount();
});
