/**
 * The Tabler glyphs Capy's own header draws and TablerIcon needs (tablerGlyphs.ts
 * says where they come from). Their own module, so the app holds these and the
 * frame's editors the rest.
 */
export const arrowBackUp = [
  'M9 14l-4 -4l4 -4',
  'M5 10h11a4 4 0 1 1 0 8h-1',
] as const;
export const arrowForwardUp = [
  'M15 14l4 -4l-4 -4',
  'M19 10h-11a4 4 0 1 0 0 8h1',
] as const;
export const chevronDown = ['M6 9l6 6l6 -6'] as const;
export const chevronUp = ['M6 15l6 -6l6 6'] as const;
