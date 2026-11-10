/* Slash menus the gutter's + button opened (BlockInteractions.tsx), by their
   input node. Left without a pick or a search, such a menu takes its slash
   with it and leaves the new line empty (Epo 2026-11-10), where a typed slash
   stays as text (SlashInput.tsx). */
const opened = new WeakSet<object>();

export const markGutterSlash = (input: object) => {
  opened.add(input);
};

export const isGutterSlash = (input: object) => opened.has(input);
