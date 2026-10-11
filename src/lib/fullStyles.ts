/* The site Worker inlines only the CSS rules a public page's HTML uses and
   preloads each full stylesheet (`link[data-full-css]`, workers/site/
   usedCss.ts). Apply them before React or an island adds elements whose
   classes the inlined rules may not cover. Same rules, same order, so nothing
   already painted changes. */

export function applyFullStyles(): Promise<void> {
  return Promise.all(
    [...document.querySelectorAll<HTMLLinkElement>('link[data-full-css]')].map(
      (preload) =>
        new Promise<boolean>((resolve) => {
          const sheet = document.createElement('link');
          sheet.rel = 'stylesheet';
          sheet.href = preload.href;
          if (preload.crossOrigin !== null)
            sheet.crossOrigin = preload.crossOrigin;
          // A failed stylesheet leaves the inlined rules, which still cover
          // the server's HTML.
          sheet.addEventListener('load', () => resolve(true), { once: true });
          sheet.addEventListener('error', () => resolve(false), { once: true });
          preload.replaceWith(sheet);
        })
    )
  ).then((loaded) => {
    // A streamed note repeats rules in the body for its later blocks
    // (workers/site/handler.ts streamPage). Once the full stylesheets hold
    // them all, the copies go: they would come after them in the cascade.
    if (loaded.every(Boolean))
      for (const style of document.querySelectorAll('style[data-css-subset]'))
        style.remove();
  });
}
