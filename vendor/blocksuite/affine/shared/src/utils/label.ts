// Capy (local change 37, Epo 2026-11-10): BlockSuite's labels, tooltips and menu
// names are English literals spread over its packages. The few places that draw
// them pass each through `tr`, and the app sets the translator once
// (src/features/blocksuite/chromeLabels.ts); a label it does not know stays as written.
let translate = (label: string) => label;

export function setLabelTranslator(next: (label: string) => string) {
  translate = next;
}

export function tr<T extends string | undefined | null>(label: T): T {
  return (typeof label === 'string' ? translate(label) : label) as T;
}
