/**
 * Stands in for @betteroffice/fonts-cjk (33 MB of CJK faces), which Capy does
 * not ship: the bundled font loader finds no CJK assets, and officeFonts never
 * requests those faces, so CJK text keeps the browser's fonts.
 */
export const CJK_FONT_ASSET_URLS = undefined;
