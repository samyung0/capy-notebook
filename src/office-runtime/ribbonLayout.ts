import { m } from '@/i18n';
import type { Glyph } from './TablerIcon';

/**
 * One slot of a ribbon group: a control the editor's toolbar names, else the
 * menu entry with that id (an item is a button, a submenu or whole menu a
 * dropdown). A control the editor hid falls back to the entry of its name.
 */
export type RibbonCell =
  | string
  | {
      id: string;
      /** The dropdown shows its ticked item in a box, as a font box. */
      box?: boolean;
      /** The dropdown's first items as tiles, as PowerPoint's layouts. */
      gallery?: boolean;
      /** Icon only, the label in its tooltip. */
      icon?: boolean;
      /** The ribbon's shorter name, where the menu's reads long. */
      label?: () => string;
      /** Over a dropdown's label: the item the upper half runs (PowerPoint's New slide). */
      split?: string;
    };

export interface RibbonGroup {
  /** Tall labelled buttons, left of the lines. */
  big?: readonly RibbonCell[];
  label: () => string;
  /** One or two lines of small controls. */
  lines?: readonly (readonly RibbonCell[])[];
}

/** Each tab's groups by tab id; `phoneHome` is Home's one row below md. */
export interface RibbonLayout {
  /** The glyph of a menu entry; label-only commands have none. */
  glyphs: Readonly<Record<string, Glyph>>;
  phoneHome: readonly RibbonGroup[];
  tabs: Record<string, readonly RibbonGroup[]>;
}

export const icon = (id: string): RibbonCell => ({ icon: true, id });

/** Same order and row as today's phone toolbar (2026-10-29 option B rows). */
export const row = (...cells: readonly RibbonCell[]): RibbonGroup => ({
  label: m.files_office_tab_home,
  lines: [cells],
});
