import { parseHTML } from 'linkedom';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { Assignment } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const start = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const setDone = vi.hoisted(() => vi.fn());
vi.mock('@/api/hooks', () => ({
  // A running attempt with nine minutes of its time limit left.
  useAssignmentAttempt: () => ({
    data: {
      deadlineAt: '2026-11-25T10:09:00Z',
      now: '2026-11-25T10:00:00Z',
    },
  }),
  useMe: () => ({ data: undefined }),
  usePaperFileLinks: () => ({ data: undefined }),
  useRemoveHandInFile: () => ({ isPending: false, mutate: vi.fn() }),
  useSetAssignmentDone: () => ({ isPending: false, mutate: setDone }),
  useStartAssignment: () => ({ isPending: false, mutate: start }),
  useWorkspace: () => ({ data: undefined }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
  useNavigate: () => navigate,
  useParams: () => ({ workspaceId: 'ws' }),
}));
vi.mock('@/components/ui/userToast', () => ({ userToast: vi.fn() }));
// Hand in's confirmation: its words and its button; the mode choice's body.
vi.mock('@/components/ui/Dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/Dialog')>()),
  ConfirmDialog: ({
    body,
    confirmLabel,
    onClose,
    onConfirm,
  }: {
    body: string;
    confirmLabel: string;
    onClose: () => void;
    onConfirm: () => void;
  }) => (
    <div role="dialog">
      <p>{body}</p>
      <button
        onClick={() => {
          onConfirm();
          onClose();
        }}
        type="button"
      >
        {confirmLabel}
      </button>
    </div>
  ),
  SimpleDialog: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
}));
// Your work's uploads, as the page holds them.
const uploads = vi.hoisted(() => ({ uploading: [] as string[] }));
vi.mock('./useAddSubmissionFiles', () => ({
  useAddSubmissionFiles: () => ({
    add: vi.fn(),
    ready: true,
    uploading: uploads.uploading,
  }),
}));

const { createRoot } = await import('react-dom/client');
const { MemberAssignment } = await import('./MemberAssignment');

const assignment = {
  attempts: 1,
  files: [],
  id: 'as1',
  kind: 'marked',
  marks: 12,
  postedAt: '2026-11-20T09:00:00Z',
  questions: 6,
  timeLimitMin: 15,
  title: 'Cells test',
  workspaceId: 'ws1',
} as unknown as Assignment;

// The page waits for Start with the assignment's facts (Epo 2026-11-25), and
// one answered online only starts straight away.
it('shows its facts and starts on Start, an online-only one straight away', async () => {
  start.mockReset();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<MemberAssignment assignment={assignment} />)
  );
  expect(start).not.toHaveBeenCalled();
  expect(host.textContent).toContain(m.study_panel_assignments());
  expect(host.textContent).toContain('Cells test');
  expect(host.textContent).toContain(m.assignment_submission_online());
  expect(host.textContent).toContain(m.todo_fact_time());
  const button = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === m.assignment_start()
  );
  await act(async () => button?.click());
  expect(start).toHaveBeenCalledWith(
    { id: 'as1', upload: false },
    expect.anything()
  );
  act(() => root.unmount());
});

it('asks for the submission mode only while both are open', async () => {
  start.mockReset();
  const both = { ...assignment, allowUploads: true } as Assignment;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemberAssignment assignment={both} />));
  expect(host.textContent).toContain(m.assignment_submission_both());
  const button = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === m.assignment_start()
  );
  await act(async () => button?.click());
  expect(document.body.textContent).toContain(m.assignment_how_answer());
  expect(start).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it('opens the attempt it started once the assignment reads it, though the start never called back', async () => {
  navigate.mockReset();
  start.mockReset();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<MemberAssignment assignment={assignment} />)
  );
  const button = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === m.assignment_start()
  );
  await act(async () => button?.click());
  expect(navigate).not.toHaveBeenCalled();
  const started = {
    ...assignment,
    mine: { runningAttemptId: 'at1' },
  } as Assignment;
  await act(async () => root.render(<MemberAssignment assignment={started} />));
  // Its own page (Epo 2026-11-25), after this one in history.
  expect(navigate).toHaveBeenCalledWith({
    params: { attemptId: 'at1' },
    to: '/attempts/$attemptId',
  });
  act(() => root.unmount());
});

// Coming back to a running attempt (Epo 2026-11-25): its clock and Continue.
it('shows a running attempt its time left and Continue', async () => {
  navigate.mockReset();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const running = {
    ...assignment,
    mine: { runningAttemptId: 'at2' },
  } as Assignment;
  await act(async () => root.render(<MemberAssignment assignment={running} />));
  expect(navigate).not.toHaveBeenCalled();
  expect(host.querySelector('[role="timer"]')?.textContent).toContain(
    m.assignment_time_left({ time: '9:00' })
  );
  expect(host.textContent).toContain(m.assignment_continue());
  expect(host.textContent).not.toContain(m.assignment_start());
  act(() => root.unmount());
});

// Hand in asks first and is final (Epo 2026-11-25): no Undo once handed in.
it("hands in an unmarked assignment's work after asking, and shows it handed in (S3)", async () => {
  const file = {
    id: 'f1',
    kind: 'pdf',
    name: 'Osmosis write-up.pdf',
    sizeBytes: 1_800_000,
    status: 'ready',
  };
  const lab = {
    allowUploads: true,
    files: [],
    id: 'as2',
    kind: 'unmarked',
    mine: { done: false, handIn: [file] },
    postedAt: '2026-11-08T09:00:00Z',
    title: 'Osmosis lab write-up',
    workspaceId: 'ws1',
  } as unknown as Assignment;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemberAssignment assignment={lab} />));
  expect(host.textContent).toContain(m.assignment_your_work());
  expect(host.textContent).toContain('Osmosis write-up.pdf');
  expect(host.textContent).toContain(m.assignment_paper_add());
  const handIn = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === m.assignment_hand_in()
  );
  await act(async () => handIn?.click());
  expect(document.body.textContent).toContain(
    m.assignment_hand_in_confirm_one()
  );
  const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
    (item) => item.textContent === m.assignment_hand_in()
  ) as HTMLButtonElement | undefined;
  await act(async () => confirm?.click());
  expect(setDone).toHaveBeenCalledWith({ done: true, id: 'as2' });

  const handedIn = {
    ...lab,
    mine: { done: true, doneAt: '2026-11-12T10:00:00Z', handIn: [file] },
  } as unknown as Assignment;
  await act(async () =>
    root.render(<MemberAssignment assignment={handedIn} />)
  );
  expect(
    [...host.querySelectorAll('button')].some((item) =>
      [m.assignment_hand_in(), m.assignment_paper_add()].includes(
        item.textContent ?? ''
      )
    )
  ).toBe(false);
  act(() => root.unmount());
});

// Hand in waits while a file of the work uploads, as Submit does.
it('holds Hand in while a file uploads', async () => {
  uploads.uploading = ['page.jpg'];
  const lab = {
    allowUploads: true,
    files: [],
    id: 'as3',
    kind: 'unmarked',
    mine: {
      done: false,
      handIn: [
        { id: 'f1', kind: 'pdf', name: 'a.pdf', sizeBytes: 1, status: 'ready' },
      ],
    },
    postedAt: '2026-11-08T09:00:00Z',
    title: 'Lab',
    workspaceId: 'ws1',
  } as unknown as Assignment;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<MemberAssignment assignment={lab} />));
  const handIn = [...host.querySelectorAll('button')].find(
    (item) => item.textContent === m.assignment_hand_in()
  );
  expect(handIn?.hasAttribute('disabled')).toBe(true);
  expect(host.textContent).toContain(
    m.assignment_paper_uploading({ name: 'page.jpg' })
  );
  uploads.uploading = [];
  act(() => root.unmount());
});
