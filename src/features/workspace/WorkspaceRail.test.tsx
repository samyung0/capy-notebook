import { parseHTML } from 'linkedom';
import { act, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { getLocale, m } from '@/i18n';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock('@/api/hooks', () => ({
  useUnreadNotificationCount: () => ({ data: undefined }),
}));
vi.mock('@/components/app/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('@/features/study/assignments/useAssignmentCount', () => ({
  useAssignmentCount: () => undefined,
}));
vi.mock('@/features/study/members/membersAttention', () => ({
  useMembersNeedAction: () => false,
}));

// As FileBanner.test: the locale first, then the document react-dom/client reads.
getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });
const { createRoot } = await import('react-dom/client');
const { WorkspaceRail } = await import('./WorkspaceRail');

const item = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (button) => button.textContent === label
  ) as HTMLButtonElement;

// Q907: rail items preload their page on hover and keyboard focus.
it('preloads a section under the pointer and on focus', async () => {
  const onPreload = vi.fn();
  const root = createRoot(document.getElementById('root') as never);
  await act(async () =>
    root.render(
      <WorkspaceRail
        accountItems={[]}
        active="dashboard"
        onPreload={onPreload}
        onSelect={() => undefined}
        workspace={{ id: 'ws', kind: 'personal', name: 'Bio', role: 'owner' }}
      />
    )
  );
  // React draws pointerenter from the pointer moving over the element.
  await act(async () => {
    item(m.workspace_tab_study()).dispatchEvent(
      new window.Event('pointerover', { bubbles: true })
    );
  });
  expect(onPreload).toHaveBeenLastCalledWith('study');
  await act(async () => {
    item(m.workspace_section_canvas()).dispatchEvent(
      new window.Event('focusin', { bubbles: true })
    );
  });
  expect(onPreload).toHaveBeenLastCalledWith('canvas');
  await act(async () => root.unmount());
});
