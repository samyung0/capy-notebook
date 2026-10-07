/* The public pages' header behaviour without React: the server-rendered
   theme button (PublicHeader.tsx) and the ⋮ menu (PublicActionMenu.tsx). The
   theme script in summary.html and share.html applies the stored theme before
   first paint; this keeps it in the same keys ThemeProvider reads. */

export function bindPublicChrome() {
  placePublicMenu();
  document.addEventListener('click', (event) => {
    if (!(event.target as Element).closest?.('[data-public-theme-toggle]'))
      return;
    const root = document.documentElement;
    const dark = !root.classList.contains('dark');
    const theme = dark ? 'mocha' : 'latte';
    root.dataset.theme = theme;
    root.classList.toggle('dark', dark);
    try {
      localStorage.setItem('capy.theme', theme);
    } catch {
      // Private windows may refuse storage; the switch still holds for the page.
    }
  });
}

/** Browsers without CSS anchor positioning open the ⋮ popover centred; place
 * it under its button instead. */
export function placePublicMenu() {
  if (CSS.supports('anchor-name: --a')) return;
  for (const menu of document.querySelectorAll<HTMLElement>(
    '[data-public-menu]'
  ))
    menu.addEventListener('beforetoggle', (event) => {
      if ((event as ToggleEvent).newState !== 'open') return;
      const button = document.querySelector(`[popovertarget="${menu.id}"]`);
      if (!button) return;
      const rect = button.getBoundingClientRect();
      menu.style.top = `${rect.bottom}px`;
      menu.style.right = `${window.innerWidth - rect.right}px`;
    });
}
