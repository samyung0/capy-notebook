import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import type {
  MemberProfile,
  MemberProgress,
  MembersProgress,
  SummaryTopic,
} from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const navigate = vi.hoisted(() => vi.fn());
const dialog = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  profile: undefined as MemberProfile | undefined,
  profileError: null as unknown,
  progress: undefined as MembersProgress | undefined,
}));
vi.mock('@tanstack/react-router', () => ({
  Navigate: () => null,
  useNavigate: () => navigate,
}));
vi.mock('@/api/hooks', () => ({
  useMemberProfile: () => ({
    data: state.profile,
    error: state.profileError,
    isError: !!state.profileError,
    isPending: false,
    refetch: vi.fn(),
  }),
  useMembersProgress: () => ({
    data: state.progress,
    error: null,
    isError: false,
    isPending: false,
    refetch: vi.fn(),
  }),
  useWorkspace: () => ({
    data: { id: 'ws', kind: 'class', name: 'Biology 101', role: 'owner' },
  }),
}));
// Manage's own page: its test is MembersRoster.test.tsx.
vi.mock('./MembersRoster', () => ({
  MembersRoster: ({ header }: { header: ReactNode }) => (
    <div data-roster>{header}</div>
  ),
}));
vi.mock('../assignments/LazyNewAssignmentDialog', () => ({
  NewAssignmentDialog: (props: object) => {
    dialog(props);
    return <div data-new-assignment />;
  },
}));
// No portals: menus show their trigger, the chip's hint renders in place.
const pass = ({ children }: { children?: ReactNode }) => children;
vi.mock('@/components/ui/Menu', () => ({
  Menu: ({ trigger }: { trigger: ReactNode }) => trigger,
}));
vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: pass,
  TooltipContent: pass,
  TooltipTrigger: ({
    children,
    onClick,
  }: {
    children?: ReactNode;
    onClick?: (event: React.MouseEvent) => void;
  }) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

const { createRoot } = await import('react-dom/client');
const { MembersPage } = await import('./MembersPage');

const topic = (
  label: SummaryTopic['label'],
  right: number,
  asked: number
): SummaryTopic => ({
  asked,
  group: 'topic',
  label,
  name: 'Osmosis',
  partial: 0,
  right,
  topicId: 't1',
  unattempted: 0,
  wrong: asked - right,
});

const member = (
  userId: string,
  name: string,
  extra: Partial<MemberProgress> = {}
): MemberProgress => ({
  assigned: 4,
  done: 3,
  missing: 0,
  name,
  overall: 0.8,
  practiceWeek: 0,
  storageFull: false,
  topics: [topic('familiar', 7, 10)],
  userId,
  ...extra,
});

const host = document.createElement('div');
document.body.append(host);
const show = async (search: { manage?: true; member?: string } = {}) => {
  const root = createRoot(host);
  await act(async () =>
    root.render(<MembersPage search={search} workspaceId="ws" />)
  );
  return root;
};
const press = (element?: Element | null) =>
  act(async () => {
    element?.dispatchEvent(new window.Event('click', { bubbles: true }));
  });
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

beforeEach(() => {
  navigate.mockReset();
  dialog.mockReset();
  state.profileError = null;
  state.progress = {
    members: [
      member('ann', 'Ann', {
        missing: 2,
        practiceWeek: 12,
        topics: [topic('needs_practice', 2, 6)],
      }),
      member('ben', 'Ben', { storageFull: true }),
    ],
    topics: [{ group: 'topic', name: 'Osmosis', questions: 10, topicId: 't1' }],
  };
});

it('lays out a table where it fits and a plain list on phones', async () => {
  const root = await show();
  const [table, phones] = [...host.querySelectorAll('ul')];
  // The container query picks one: the table from @4xl, the list below it.
  expect(table.parentElement?.className).toContain('@4xl:block');
  expect(phones.className).toContain('@4xl:hidden');
  expect(host.textContent).toContain(m.members_col_practice());
  expect(table.textContent).toContain(m.practice_questions({ count: 12 }));
  expect(table.textContent).toContain('Osmosis');
  // Labels and practice wait for the profile on a phone.
  expect(phones.textContent).not.toContain('Osmosis');
  expect(phones.textContent).not.toContain(m.practice_questions({ count: 12 }));
  expect(phones.textContent).toContain(m.members_missing({ count: 2 }));
  await act(async () => root.unmount());
});

// Epo 2026-11-11: the marks are Overview; sharing, invitations and roles are
// Manage, under the same heading.
it("gives a class's staff Overview and Manage", async () => {
  const root = await show();
  const tabs = [...host.querySelectorAll('[role="tab"]')];
  expect(tabs.map((tab) => tab.textContent)).toEqual([
    m.members_tab_overview(),
    m.members_tab_manage(),
  ]);
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  await press(tabs[1]);
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      search: { manage: true, show: undefined, study: 'members' },
    })
  );
  act(() => root.unmount());

  const managing = await show({ manage: true });
  const roster = host.querySelector('[data-roster]');
  expect(roster?.textContent).toContain(m.study_panel_members());
  expect(roster?.querySelector('[aria-selected="true"]')?.textContent).toBe(
    m.members_tab_manage()
  );
  act(() => managing.unmount());
});

it('marks a member whose storage is full, with its hint', async () => {
  const root = await show();
  const [table, phones] = [...host.querySelectorAll('ul')];
  for (const list of [table, phones]) {
    const [ann, ben] = [...list.querySelectorAll('li')];
    expect(ann.textContent).not.toContain(m.members_storage_full());
    expect(ben.textContent).toContain(m.members_storage_full());
    expect(ben.textContent).toContain(m.members_storage_full_hint());
  }
  // A tap on the chip leaves the row where it is.
  await press(button(m.members_storage_full()));
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("opens a member's profile from their row", async () => {
  const root = await show();
  const ann = host.querySelector('ul li');
  await press(ann);
  expect(navigate).toHaveBeenLastCalledWith({
    search: { member: 'ann', show: undefined, study: 'members' },
    to: '.',
  });
  await act(async () => root.unmount());
});

const profile = (): MemberProfile => ({
  activity: [],
  assigned: 0,
  assignments: [],
  done: 0,
  joinedAt: '2026-09-02T10:00:00Z',
  missed: [],
  missing: 0,
  name: 'Ann',
  storageFull: false,
  topics: [
    topic('needs_practice', 1, 4),
    { ...topic('mastered', 9, 10), topicId: 't2' },
  ],
  userId: 'ann',
});

it('assigns practice to the member alone, on their weakest topic', async () => {
  state.profile = profile();
  const root = await show({ member: 'ann' });
  expect(host.textContent).toContain(
    m.member_needs_practice_on({ topic: 'Osmosis' })
  );
  await press(button(m.member_assign_practice()));
  expect(host.querySelector('[data-new-assignment]')).not.toBeNull();
  expect(dialog).toHaveBeenLastCalledWith(
    expect.objectContaining({
      presetAssignee: 'ann',
      presetTopicId: 't1',
      workspaceId: 'ws',
    })
  );
  await act(async () => root.unmount());
});

it('says a removed member is not found, with nothing to retry', async () => {
  state.profileError = new ApiError(404, 'Not Found');
  const root = await show({ member: 'gone' });
  expect(host.textContent).toContain(m.member_profile_not_found());
  expect(button(m.action_retry())).toBeUndefined();
  await act(async () => root.unmount());
});
