import { useNavigate, useRouterState } from '@tanstack/react-router';

/** The Theme drawer's place in the URL: `?theme=open` on any signed-in page
 * (the auth shell's search), so a menu item or the onboarding dialog opens it
 * in place without a reload, and Back closes it. */
export const parseThemeSearch = (
  search: Record<string, unknown>
): { theme?: 'open' } => (search.theme === 'open' ? { theme: 'open' } : {});

/** Whether the drawer is open, and a setter that opens it as a new history
 * entry and closes it in place. */
export function useThemeDrawer() {
  const navigate = useNavigate();
  // Router state, not useSearch: the dev scenario panel renders this outside
  // the route tree.
  const open = useRouterState({
    select: (state) => state.location.search.theme === 'open',
  });
  const setOpen = (next: boolean) =>
    void navigate({
      replace: !next,
      search: (prev) => ({ ...prev, theme: next ? 'open' : undefined }),
      to: '.',
    });
  return { open, setOpen };
}
