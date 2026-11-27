type MathLive = typeof import('mathlive');

export interface LoadedMathLive {
  mathlive: MathLive;
  /** mathlive-static.css (served by vite-mathlive.ts), which read-only
   * formulas draw with. */
  sheet: CSSStyleSheet;
}

let module: Promise<MathLive> | undefined;
let loaded: LoadedMathLive | undefined;
let loading: Promise<LoadedMathLive> | undefined;

/** The MathLive module alone, which an editing field needs: it never waits
 * on the stylesheet. A failure is not kept. */
export function loadMathLiveModule(): Promise<MathLive> {
  module ??= import('mathlive').catch((error: unknown) => {
    module = undefined;
    throw error;
  });
  return module;
}

/** MathLive with its static stylesheet once both loaded, so a formula draws in
 * the frame it mounts (a preview after editing ends included). */
export const loadedMathLive = () => loaded;

/** MathLive and its static stylesheet, which read-only formulas draw with.
 * The document adopts the stylesheet too: its fonts are declared there (a
 * shadow root's are not used), so each face loads once a formula uses it, and
 * an editing field then leaves its fonts to those declarations. A failure is
 * not kept: the next formula tries again. */
export function loadMathLive(): Promise<LoadedMathLive> {
  loading ??= Promise.all([loadMathLiveModule(), staticSheet()]).then(
    ([mathlive, sheet]) => {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      loaded = { mathlive, sheet };
      return loaded;
    },
    (error: unknown) => {
      loading = undefined;
      throw error;
    }
  );
  return loading;
}

async function staticSheet() {
  const response = await fetch('/mathlive/mathlive-static.css');
  // A missing file comes back as the app's page with a 200 (the Worker's
  // single-page fallback), which a stylesheet would silently drop.
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  if (!response.ok || type !== 'text/css')
    throw new Error(
      `MathLive stylesheet: HTTP ${response.status}, ${type ?? 'no type'}`
    );
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(await response.text());
  return sheet;
}
