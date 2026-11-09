/**
 * The Tabler Icons the Office editors draw, one export per glyph so a bundle
 * holds only those it uses: @tabler/icons 3.50.0 outline (MIT,
 * THIRD-PARTY-NOTICES.md), each a list of stroked paths on a 24 unit grid (a
 * leading ! also fills the path: the layer-order glyphs' top layer).
 * Copied from the package's SVGs, not imported: it has nothing else the
 * runtime needs.
 */
export {
  arrowBackUp,
  arrowForwardUp,
  chevronDown,
  chevronUp,
} from './tablerHeaderGlyphs';

export const adjustmentsHorizontal = [
  'M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  'M4 6l8 0',
  'M16 6l4 0',
  'M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  'M4 12l2 0',
  'M10 12l10 0',
  'M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  'M4 18l11 0',
  'M19 18l1 0',
] as const;
export const alertTriangle = [
  'M12 9v4',
  'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0',
  'M12 16h.01',
] as const;
export const alignBoxCenterMiddle = [
  'M3 19v-14a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2',
  'M11 15h2',
  'M9 12h6',
  'M10 9h4',
] as const;
export const alignCenter = ['M4 6l16 0', 'M8 12l8 0', 'M6 18l12 0'] as const;
export const alignJustified = [
  'M4 6l16 0',
  'M4 12l16 0',
  'M4 18l12 0',
] as const;
export const alignLeft = ['M4 6l16 0', 'M4 12l10 0', 'M4 18l14 0'] as const;
export const alignRight = ['M4 6l16 0', 'M10 12l10 0', 'M6 18l14 0'] as const;
export const arrowBarToDown = [
  'M4 20l16 0',
  'M12 14l0 -10',
  'M12 14l4 -4',
  'M12 14l-4 -4',
] as const;
export const arrowBarToUp = [
  'M12 10l0 10',
  'M12 10l4 4',
  'M12 10l-4 4',
  'M4 4l16 0',
] as const;
export const arrowDown = ['M12 5l0 14', 'M18 13l-6 6', 'M6 13l6 6'] as const;
export const arrowLeft = ['M5 12l14 0', 'M5 12l6 6', 'M5 12l6 -6'] as const;
export const arrowRight = ['M5 12l14 0', 'M13 18l6 -6', 'M13 6l6 6'] as const;
export const arrowUp = ['M12 5l0 14', 'M18 11l-6 -6', 'M6 11l6 -6'] as const;
export const arrowsHorizontal = [
  'M7 8l-4 4l4 4',
  'M17 8l4 4l-4 4',
  'M3 12l18 0',
] as const;
export const arrowsMove = [
  'M18 9l3 3l-3 3',
  'M15 12h6',
  'M6 9l-3 3l3 3',
  'M3 12h6',
  'M9 18l3 3l3 -3',
  'M12 15v6',
  'M15 6l-3 -3l-3 3',
  'M12 3v6',
] as const;
export const arrowsVertical = [
  'M8 7l4 -4l4 4',
  'M8 17l4 4l4 -4',
  'M12 3l0 18',
] as const;
export const ballpen = [
  'M14 6l7 7l-4 4',
  'M5.828 18.172a2.828 2.828 0 0 0 4 0l10.586 -10.586a2 2 0 0 0 0 -2.829l-1.171 -1.171a2 2 0 0 0 -2.829 0l-10.586 10.586a2.828 2.828 0 0 0 0 4',
  'M4 20l1.768 -1.768',
] as const;
export const bold = [
  'M7 5h6a3.5 3.5 0 0 1 0 7h-6l0 -7',
  'M13 12h1a3.5 3.5 0 0 1 0 7h-7v-7',
] as const;
export const borderAll = [
  'M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12',
  'M4 12l16 0',
  'M12 4l0 16',
] as const;
export const borderBottom = [
  'M20 20l-16 0',
  'M4 4l0 .01',
  'M8 4l0 .01',
  'M12 4l0 .01',
  'M16 4l0 .01',
  'M20 4l0 .01',
  'M4 8l0 .01',
  'M12 8l0 .01',
  'M20 8l0 .01',
  'M4 12l0 .01',
  'M8 12l0 .01',
  'M12 12l0 .01',
  'M16 12l0 .01',
  'M20 12l0 .01',
  'M4 16l0 .01',
  'M12 16l0 .01',
  'M20 16l0 .01',
] as const;
export const borderHorizontal = [
  'M4 12l16 0',
  'M4 4l0 .01',
  'M8 4l0 .01',
  'M12 4l0 .01',
  'M16 4l0 .01',
  'M20 4l0 .01',
  'M4 8l0 .01',
  'M12 8l0 .01',
  'M20 8l0 .01',
  'M4 16l0 .01',
  'M12 16l0 .01',
  'M20 16l0 .01',
  'M4 20l0 .01',
  'M8 20l0 .01',
  'M12 20l0 .01',
  'M16 20l0 .01',
  'M20 20l0 .01',
] as const;
export const borderInner = [
  'M4 12l16 0',
  'M12 4l0 16',
  'M4 4l0 .01',
  'M8 4l0 .01',
  'M16 4l0 .01',
  'M20 4l0 .01',
  'M4 8l0 .01',
  'M20 8l0 .01',
  'M4 16l0 .01',
  'M20 16l0 .01',
  'M4 20l0 .01',
  'M8 20l0 .01',
  'M16 20l0 .01',
  'M20 20l0 .01',
] as const;
export const borderLeft = [
  'M4 20l0 -16',
  'M8 4l0 .01',
  'M12 4l0 .01',
  'M16 4l0 .01',
  'M20 4l0 .01',
  'M12 8l0 .01',
  'M20 8l0 .01',
  'M8 12l0 .01',
  'M12 12l0 .01',
  'M16 12l0 .01',
  'M20 12l0 .01',
  'M12 16l0 .01',
  'M20 16l0 .01',
  'M8 20l0 .01',
  'M12 20l0 .01',
  'M16 20l0 .01',
  'M20 20l0 .01',
] as const;
export const borderNone = [
  'M4 4l0 .01',
  'M8 4l0 .01',
  'M12 4l0 .01',
  'M16 4l0 .01',
  'M20 4l0 .01',
  'M4 8l0 .01',
  'M12 8l0 .01',
  'M20 8l0 .01',
  'M4 12l0 .01',
  'M8 12l0 .01',
  'M12 12l0 .01',
  'M16 12l0 .01',
  'M20 12l0 .01',
  'M4 16l0 .01',
  'M12 16l0 .01',
  'M20 16l0 .01',
  'M4 20l0 .01',
  'M8 20l0 .01',
  'M12 20l0 .01',
  'M16 20l0 .01',
  'M20 20l0 .01',
] as const;
export const borderOuter = [
  'M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12',
  'M12 8l0 .01',
  'M8 12l0 .01',
  'M12 12l0 .01',
  'M16 12l0 .01',
  'M12 16l0 .01',
] as const;
export const borderRight = [
  'M20 4l0 16',
  'M4 4l0 .01',
  'M8 4l0 .01',
  'M12 4l0 .01',
  'M16 4l0 .01',
  'M4 8l0 .01',
  'M12 8l0 .01',
  'M4 12l0 .01',
  'M8 12l0 .01',
  'M12 12l0 .01',
  'M16 12l0 .01',
  'M4 16l0 .01',
  'M12 16l0 .01',
  'M4 20l0 .01',
  'M8 20l0 .01',
  'M12 20l0 .01',
  'M16 20l0 .01',
] as const;
export const borderStyle2 = [
  'M4 18v.01',
  'M8 18v.01',
  'M12 18v.01',
  'M16 18v.01',
  'M20 18v.01',
  'M18 12h2',
  'M11 12h2',
  'M4 12h2',
  'M4 6h16',
] as const;
export const borderTop = [
  'M4 4l16 0',
  'M4 8l0 .01',
  'M12 8l0 .01',
  'M20 8l0 .01',
  'M4 12l0 .01',
  'M8 12l0 .01',
  'M12 12l0 .01',
  'M16 12l0 .01',
  'M20 12l0 .01',
  'M4 16l0 .01',
  'M12 16l0 .01',
  'M20 16l0 .01',
  'M4 20l0 .01',
  'M8 20l0 .01',
  'M12 20l0 .01',
  'M16 20l0 .01',
  'M20 20l0 .01',
] as const;
export const borderVertical = [
  'M12 4l0 16',
  'M4 4l0 .01',
  'M8 4l0 .01',
  'M16 4l0 .01',
  'M20 4l0 .01',
  'M4 8l0 .01',
  'M20 8l0 .01',
  'M4 12l0 .01',
  'M8 12l0 .01',
  'M16 12l0 .01',
  'M20 12l0 .01',
  'M4 16l0 .01',
  'M20 16l0 .01',
  'M4 20l0 .01',
  'M8 20l0 .01',
  'M16 20l0 .01',
  'M20 20l0 .01',
] as const;
export const boxPadding = [
  'M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12',
  'M8 16v.01',
  'M8 12v.01',
  'M8 8v.01',
  'M16 16v.01',
  'M16 12v.01',
  'M16 8v.01',
  'M12 8v.01',
  'M12 16v.01',
] as const;
export const brush = [
  'M3 21v-4a4 4 0 1 1 4 4h-4',
  'M21 3a16 16 0 0 0 -12.8 10.2',
  'M21 3a16 16 0 0 1 -10.2 12.8',
  'M10.6 9a9 9 0 0 1 4.4 4.4',
] as const;
export const bucket = [
  'M4 7a8 4 0 1 0 16 0a8 4 0 1 0 -16 0',
  'M4 7c0 .664 .088 1.324 .263 1.965l2.737 10.035c.5 1.5 2.239 2 5 2s4.5 -.5 5 -2c.333 -1 1.246 -4.345 2.737 -10.035a7.45 7.45 0 0 0 .263 -1.965',
] as const;
export const calendar = [
  'M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12',
  'M16 3v4',
  'M8 3v4',
  'M4 11h16',
  'M11 15h1',
  'M12 15v3',
] as const;
export const check = ['M5 12l5 5l10 -10'] as const;
export const checks = ['M7 12l5 5l10 -10', 'M2 12l5 5m5 -5l5 -5'] as const;
export const chevronLeft = ['M15 6l-6 6l6 6'] as const;
export const chevronRight = ['M9 6l6 6l-6 6'] as const;
export const circleCheck = [
  'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0',
  'M9 12l2 2l4 -4',
] as const;
export const clearFormatting = [
  'M17 15l4 4m0 -4l-4 4',
  'M7 6v-1h11v1',
  'M7 19l4 0',
  'M13 5l-4 14',
] as const;
export const clipboard = [
  'M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2',
  'M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2',
] as const;
export const clock = [
  'M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0',
  'M12 7v5l3 3',
] as const;
export const columnInsertLeft = [
  'M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1',
  'M5 12l4 0',
  'M7 10l0 4',
] as const;
export const columnInsertRight = [
  'M6 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1',
  'M15 12l4 0',
  'M17 10l0 4',
] as const;
export const columnRemove = [
  'M6 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1',
  'M16 10l4 4',
  'M16 14l4 -4',
] as const;
export const copy = [
  'M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666',
  'M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1',
] as const;
export const currencyDollar = [
  'M16.7 8a3 3 0 0 0 -2.7 -2h-4a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-4a3 3 0 0 1 -2.7 -2',
  'M12 3v3m0 12v3',
] as const;
export const dots = [
  'M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
] as const;
export const dotsVertical = [
  'M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
] as const;
export const download = [
  'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2',
  'M7 11l5 5l5 -5',
  'M12 4l0 12',
] as const;
export const dropletOff = [
  'M18.963 14.938a6.54 6.54 0 0 0 -.899 -4.06l-4.89 -7.26c-.42 -.626 -1.287 -.804 -1.936 -.398a1.376 1.376 0 0 0 -.41 .397l-1.282 1.9m-1.625 2.415l-1.986 2.946c-1.695 2.837 -1.035 6.44 1.567 8.545c2.602 2.105 6.395 2.105 8.996 0a6.83 6.83 0 0 0 1.376 -1.499',
  'M3 3l18 18',
] as const;
export const eraser = [
  'M19 20h-10.5l-4.21 -4.3a1 1 0 0 1 0 -1.41l10 -10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3',
  'M18 13.3l-6.3 -6.3',
] as const;
export const file = [
  'M14 3v4a1 1 0 0 0 1 1h4',
  'M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2',
] as const;
export const flipHorizontal = [
  'M12 3l0 18',
  'M16 7l0 10l5 0l-5 -10',
  'M8 7l0 10l-5 0l5 -10',
] as const;
export const flipVertical = [
  'M3 12l18 0',
  'M7 16l10 0l-10 5l0 -5',
  'M7 8l10 0l-10 -5l0 5',
] as const;
export const floatLeft = [
  'M4 6a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
  'M14 7l6 0',
  'M14 11l6 0',
  'M4 15l16 0',
  'M4 19l16 0',
] as const;
export const floatRight = [
  'M14 6a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
  'M4 7l6 0',
  'M4 11l6 0',
  'M4 15l16 0',
  'M4 19l16 0',
] as const;
export const gripVertical = [
  'M8 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M8 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M8 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M14 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M14 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M14 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
] as const;
export const highlight = [
  'M3 19h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4',
  'M12.5 5.5l4 4',
  'M4.5 13.5l4 4',
  'M21 15v4h-8l4 -4l4 0',
] as const;
export const indentDecrease = [
  'M20 6l-7 0',
  'M20 12l-9 0',
  'M20 18l-7 0',
  'M8 8l-4 4l4 4',
] as const;
export const indentIncrease = [
  'M20 6l-11 0',
  'M20 12l-7 0',
  'M20 18l-11 0',
  'M4 8l4 4l-4 4',
] as const;
export const infoCircle = [
  'M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0',
  'M12 9h.01',
  'M11 12h1v4h1',
] as const;
export const italic = ['M11 5l6 0', 'M7 19l6 0', 'M14 5l-4 14'] as const;
export const layoutAlignBottom = [
  'M4 20l16 0',
  'M9 6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2l0 -8',
] as const;
export const layoutAlignCenter = [
  'M12 4l0 5',
  'M12 15l0 5',
  'M6 11a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -2',
] as const;
export const layoutAlignLeft = [
  'M4 4l0 16',
  'M8 11a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -2',
] as const;
export const layoutAlignMiddle = [
  'M4 12l5 0',
  'M15 12l5 0',
  'M9 8a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2l0 -8',
] as const;
export const layoutAlignRight = [
  'M20 4l0 16',
  'M4 11a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -2',
] as const;
export const layoutAlignTop = [
  'M4 4l16 0',
  'M9 10a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2l0 -8',
] as const;
export const layoutDistributeHorizontal = [
  'M4 4l16 0',
  'M4 20l16 0',
  'M6 11a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -2',
] as const;
export const layoutDistributeVertical = [
  'M4 4l0 16',
  'M20 4l0 16',
  'M9 8a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2l0 -8',
] as const;
export const letterCase = [
  'M14 15.5a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0',
  'M3 19v-10.5a3.5 3.5 0 0 1 7 0v10.5',
  'M3 13h7',
  'M21 12v7',
] as const;
export const letterT = ['M6 4l12 0', 'M12 4l0 16'] as const;
export const lineHeight = [
  'M3 8l3 -3l3 3',
  'M3 16l3 3l3 -3',
  'M6 5l0 14',
  'M13 6l7 0',
  'M13 12l7 0',
  'M13 18l7 0',
] as const;
export const link = [
  'M9 15l6 -6',
  'M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464',
  'M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463',
] as const;
export const list = [
  'M9 6l11 0',
  'M9 12l11 0',
  'M9 18l11 0',
  'M5 6l0 .01',
  'M5 12l0 .01',
  'M5 18l0 .01',
] as const;
export const listNumbers = [
  'M11 6h9',
  'M11 12h9',
  'M12 18h8',
  'M4 16a2 2 0 1 1 4 0c0 .591 -.5 1 -1 1.5l-3 2.5h4',
  'M6 10v-6l-2 2',
] as const;
export const listTree = [
  'M9 6h11',
  'M12 12h8',
  'M15 18h5',
  'M5 6v.01',
  'M8 12v.01',
  'M11 18v.01',
] as const;
export const maximize = [
  'M4 8v-2a2 2 0 0 1 2 -2h2',
  'M4 16v2a2 2 0 0 0 2 2h2',
  'M16 4h2a2 2 0 0 1 2 2v2',
  'M16 20h2a2 2 0 0 0 2 -2v-2',
] as const;
export const menu2 = ['M4 6l16 0', 'M4 12l16 0', 'M4 18l16 0'] as const;
export const message = [
  'M8 9h8',
  'M8 13h6',
  'M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12',
] as const;
export const messageCheck = [
  'M8 9h8',
  'M8 13h6',
  'M10.99 19.206l-2.99 1.794v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6',
  'M15 19l2 2l4 -4',
] as const;
export const messagePlus = [
  'M8 9h8',
  'M8 13h6',
  'M12.01 18.594l-4.01 2.406v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v5.5',
  'M16 19h6',
  'M19 16v6',
] as const;
export const minus = ['M5 12l14 0'] as const;
export const notes = [
  'M5 5a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -14',
  'M9 7l6 0',
  'M9 11l6 0',
  'M9 15l4 0',
] as const;
export const number = [
  'M4 17v-10l7 10v-10',
  'M15 17h5',
  'M15 10a2.5 3 0 1 0 5 0a2.5 3 0 1 0 -5 0',
] as const;
export const pageBreak = [
  'M14 3v4a1 1 0 0 0 1 1h4',
  'M19 18v1a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-1',
  'M3 14h3m4.5 0h3m4.5 0h3',
  'M5 10v-5a2 2 0 0 1 2 -2h7l5 5v2',
] as const;
export const pencil = [
  'M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4',
  'M13.5 6.5l4 4',
] as const;
export const percentage = [
  'M16 17a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M6 7a1 1 0 1 0 2 0a1 1 0 1 0 -2 0',
  'M6 18l12 -12',
] as const;
export const photo = [
  'M15 8h.01',
  'M3 6a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v12a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-12',
  'M3 16l5 -5c.928 -.893 2.072 -.893 3 0l5 5',
  'M14 14l1 -1c.928 -.893 2.072 -.893 3 0l3 3',
] as const;
export const pin = [
  'M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4',
  'M9 15l-4.5 4.5',
  'M14.5 4l5.5 5.5',
] as const;
export const playerPause = [
  'M6 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12',
  'M14 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12',
] as const;
export const playerPlay = ['M7 4v16l13 -8l-13 -8'] as const;
export const plus = ['M12 5l0 14', 'M5 12l14 0'] as const;
export const pointer = [
  'M7.904 17.563a1.2 1.2 0 0 0 2.228 .308l2.09 -3.093l4.907 4.907a1.067 1.067 0 0 0 1.509 0l1.047 -1.047a1.067 1.067 0 0 0 0 -1.509l-4.907 -4.907l3.113 -2.09a1.2 1.2 0 0 0 -.309 -2.228l-13.582 -3.904l3.904 13.563',
] as const;
export const presentation = [
  'M3 4l18 0',
  'M4 4v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-10',
  'M12 16l0 4',
  'M9 20l6 0',
  'M8 12l3 -3l2 2l3 -3',
] as const;
export const printer = [
  'M17 17h2a2 2 0 0 0 2 -2v-4a2 2 0 0 0 -2 -2h-14a2 2 0 0 0 -2 2v4a2 2 0 0 0 2 2h2',
  'M17 9v-4a2 2 0 0 0 -2 -2h-6a2 2 0 0 0 -2 2v4',
  'M7 15a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2l0 -4',
] as const;
export const refresh = [
  'M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4',
  'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4',
] as const;
export const reload = [
  'M19.933 13.041a8 8 0 1 1 -9.925 -8.788c3.899 -1 7.935 1.007 9.425 4.747',
  'M20 4v5h-5',
] as const;
export const rotate = ['M19.95 11a8 8 0 1 0 -.5 4m.5 5v-5h-5'] as const;
export const rotateClockwise = ['M4.05 11a8 8 0 1 1 .5 4m-.5 5v-5h5'] as const;
export const rowInsertBottom = [
  'M20 6v4a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1',
  'M12 15l0 4',
  'M14 17l-4 0',
] as const;
export const rowInsertTop = [
  'M4 18v-4a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1',
  'M12 9v-4',
  'M10 7l4 0',
] as const;
export const rowRemove = [
  'M20 6v4a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1',
  'M10 16l4 4',
  'M10 20l4 -4',
] as const;
export const rubberStamp = [
  'M21 17.85h-18c0 -4.05 1.421 -4.05 3.79 -4.05c5.21 0 1.21 -4.59 1.21 -6.8a4 4 0 1 1 8 0c0 2.21 -4 6.8 1.21 6.8c2.369 0 3.79 0 3.79 4.05',
  'M5 21h14',
] as const;
export const ruler2 = [
  'M17 3l4 4l-14 14l-4 -4l14 -14',
  'M16 7l-1.5 -1.5',
  'M13 10l-1.5 -1.5',
  'M10 13l-1.5 -1.5',
  'M7 16l-1.5 -1.5',
] as const;
export const scissors = [
  'M3 7a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  'M3 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  'M8.6 8.6l10.4 10.4',
  'M8.6 15.4l10.4 -10.4',
] as const;
export const search = [
  'M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0',
  'M21 21l-6 -6',
] as const;
export const section = [
  'M20 20h.01',
  'M4 20h.01',
  'M8 20h.01',
  'M12 20h.01',
  'M16 20h.01',
  'M20 4h.01',
  'M4 4h.01',
  'M8 4h.01',
  'M12 4h.01',
  'M16 4l0 .01',
  'M4 9a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1l0 -6',
] as const;
export const selectAll = [
  'M8 9a1 1 0 0 1 1 -1h6a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1l0 -6',
  'M12 20v.01',
  'M16 20v.01',
  'M8 20v.01',
  'M4 20v.01',
  'M4 16v.01',
  'M4 12v.01',
  'M4 8v.01',
  'M4 4v.01',
  'M8 4v.01',
  'M12 4v.01',
  'M16 4v.01',
  'M20 4v.01',
  'M20 8v.01',
  'M20 12v.01',
  'M20 16v.01',
  'M20 20v.01',
] as const;
export const settings = [
  'M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065',
  'M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0',
] as const;
export const snowflake = [
  'M10 4l2 1l2 -1',
  'M12 2v6.5l3 1.72',
  'M17.928 6.268l.134 2.232l1.866 1.232',
  'M20.66 7l-5.629 3.25l.01 3.458',
  'M19.928 14.268l-1.866 1.232l-.134 2.232',
  'M20.66 17l-5.629 -3.25l-2.99 1.738',
  'M14 20l-2 -1l-2 1',
  'M12 22v-6.5l-3 -1.72',
  'M6.072 17.732l-.134 -2.232l-1.866 -1.232',
  'M3.34 17l5.629 -3.25l-.01 -3.458',
  'M4.072 9.732l1.866 -1.232l.134 -2.232',
  'M3.34 7l5.629 3.25l2.99 -1.738',
] as const;
export const sparkles = [
  'M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6',
] as const;
export const squareLetterT = [
  'M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14',
  'M10 8h4',
  'M12 8v8',
] as const;
export const stack2 = [
  'M12 4l-8 4l8 4l8 -4l-8 -4',
  'M4 12l8 4l8 -4',
  'M4 16l8 4l8 -4',
] as const;
export const stackBack = [
  'M4 8l8 4l8 -4l-8 -4l-8 4',
  '!M12 16l-4 -2l-4 2l8 4l8 -4l-4 -2l-4 2',
  'M8 10l-4 2l4 2m8 0l4 -2l-4 -2',
] as const;
export const stackBackward = [
  'M14 12l6 -3l-8 -4l-8 4l6 3',
  '!M10 12l-6 3l8 4l8 -4l-6 -3l-2 1l-2 -1',
] as const;
export const stackForward = [
  '!M12 5l-8 4l8 4l8 -4l-8 -4',
  'M10 12l-6 3l8 4l8 -4l-6 -3',
] as const;
export const stackFront = [
  '!M12 4l-8 4l8 4l8 -4l-8 -4',
  'M8 14l-4 2l8 4l8 -4l-4 -2',
  'M8 10l-4 2l8 4l8 -4l-4 -2',
] as const;
export const strikethrough = [
  'M5 12l14 0',
  'M16 6.5a4 2 0 0 0 -4 -1.5h-1a3.5 3.5 0 0 0 0 7h2a3.5 3.5 0 0 1 0 7h-1.5a4 2 0 0 1 -4 -1.5',
] as const;
export const subscript = [
  'M5 7l8 10m-8 0l8 -10',
  'M21 20h-4l3.5 -4a1.73 1.73 0 0 0 -3.5 -2',
] as const;
export const superscript = [
  'M5 7l8 10m-8 0l8 -10',
  'M21 11h-4l3.5 -4a1.73 1.73 0 0 0 -3.5 -2',
] as const;
export const table = [
  'M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14',
  'M3 10h18',
  'M10 3v18',
] as const;
export const tableOptions = [
  'M12 21h-7a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v7',
  'M3 10h18',
  'M10 3v18',
  'M17.001 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  'M19.001 15.5v1.5',
  'M19.001 21v1.5',
  'M22.032 17.25l-1.299 .75',
  'M17.27 20l-1.3 .75',
  'M15.97 17.25l1.3 .75',
  'M20.733 20l1.3 .75',
] as const;
export const tablePlus = [
  'M12.5 21h-7.5a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v7.5',
  'M3 10h18',
  'M10 3v18',
  'M16 19h6',
  'M19 16v6',
] as const;
export const textColor = [
  'M9 15v-7a3 3 0 0 1 6 0v7',
  'M9 11h6',
  'M5 19h14',
] as const;
export const textDecrease = [
  'M4 19v-10.5a3.5 3.5 0 1 1 7 0v10.5',
  'M4 13h7',
  'M21 12h-6',
] as const;
export const textDirectionLtr = [
  'M5 19h14',
  'M17 21l2 -2l-2 -2',
  'M16 4h-6.5a3.5 3.5 0 0 0 0 7h.5',
  'M14 15v-11',
  'M10 15v-11',
] as const;
export const textDirectionRtl = [
  'M16 4h-6.5a3.5 3.5 0 0 0 0 7h.5',
  'M14 15v-11',
  'M10 15v-11',
  'M5 19h14',
  'M7 21l-2 -2l2 -2',
] as const;
export const textIncrease = [
  'M4 19v-10.5a3.5 3.5 0 1 1 7 0v10.5',
  'M4 13h7',
  'M18 9v6',
  'M21 12h-6',
] as const;
export const textSize = [
  'M3 7v-2h13v2',
  'M10 5v14',
  'M12 19h-4',
  'M15 13v-1h6v1',
  'M18 12v7',
  'M17 19h2',
] as const;
export const textWrap = [
  'M4 6l16 0',
  'M4 18l5 0',
  'M4 12h13a3 3 0 0 1 0 6h-4l2 -2m0 4l-2 -2',
] as const;
export const textWrapDisabled = [
  'M4 6l10 0',
  'M4 18l10 0',
  'M4 12h17l-3 -3m0 6l3 -3',
] as const;
export const trash = [
  'M4 7l16 0',
  'M10 11l0 6',
  'M14 11l0 6',
  'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12',
  'M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3',
] as const;
export const triangleSquareCircle = [
  'M12 3l-4 7h8l-4 -7',
  'M14 17a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  'M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4',
] as const;
export const underline = ['M7 5v5a5 5 0 0 0 10 0v-5', 'M5 19h14'] as const;
export const unlink = [
  'M17 22v-2',
  'M9 15l6 -6',
  'M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464',
  'M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463',
  'M20 17h2',
  'M2 7h2',
  'M7 2v2',
] as const;
export const upload = [
  'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2',
  'M7 9l5 -5l5 5',
  'M12 4l0 12',
] as const;
export const world = [
  'M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0',
  'M3.6 9h16.8',
  'M3.6 15h16.8',
  'M11.5 3a17 17 0 0 0 0 18',
  'M12.5 3a17 17 0 0 1 0 18',
] as const;
export const x = ['M18 6l-12 12', 'M6 6l12 12'] as const;
export const zoomIn = [
  'M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0',
  'M7 10l6 0',
  'M10 7l0 6',
  'M21 21l-6 -6',
] as const;
