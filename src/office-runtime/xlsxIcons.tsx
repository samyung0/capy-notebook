import type { IconSet } from '@betteroffice/xlsx-react';
import type { ComponentProps } from 'react';
import { officeIconSize } from './officeIconSize';
import {
  decimalDecrease,
  decimalIncrease,
  fillSwatch,
  TablerIcon,
  tableCellsMerge,
  textColorSwatch,
} from './TablerIcon';
import {
  alignCenter,
  alignLeft,
  alignRight,
  arrowBackUp,
  arrowForwardUp,
  bold,
  borderAll,
  borderBottom,
  borderHorizontal,
  borderInner,
  borderLeft,
  borderNone,
  borderOuter,
  borderRight,
  borderTop,
  borderVertical,
  brush,
  check,
  chevronDown,
  dotsVertical,
  download,
  italic,
  layoutAlignBottom,
  layoutAlignMiddle,
  layoutAlignTop,
  minus,
  photo,
  plus,
  printer,
  refresh,
  search,
  sparkles,
  strikethrough,
  textWrap,
} from './tablerGlyphs';

/**
 * Every icon xlsx-react draws, from Tabler (Q599): the same glyph as the
 * other formats for the same command, Capy's own where Tabler has no fit.
 */
export const XLSX_ICONS: Record<
  keyof IconSet,
  ComponentProps<typeof TablerIcon>['glyph']
> = {
  add: plus,
  alignCellBottom: layoutAlignBottom,
  alignCellMiddle: layoutAlignMiddle,
  alignCellTop: layoutAlignTop,
  alignLeft,
  alignTextCenter: alignCenter,
  alignTextLeft: alignLeft,
  alignTextRight: alignRight,
  bold,
  borderAll,
  borderBottom,
  borderHorizontal,
  borderInner,
  borderLeft,
  borderNone,
  borderOuter,
  borderRight,
  borders: borderAll,
  borderTop,
  borderVertical,
  check,
  chevronDown,
  decimalDecrease,
  decimalIncrease,
  fillColor: fillSwatch,
  formatPaint: brush,
  image: photo,
  italic,
  merge: tableCellsMerge,
  more: dotsVertical,
  print: printer,
  proposals: sparkles,
  redo: arrowForwardUp,
  refresh,
  remove: minus,
  save: download,
  search,
  strikethrough,
  textColor: textColorSwatch,
  undo: arrowBackUp,
  verticalAlignCenter: layoutAlignMiddle,
  wrap: textWrap,
};

/** Capy's toolbars and menus draw 18px icons (officeIconSize). */
export const xlsxIcons = Object.fromEntries(
  Object.entries(XLSX_ICONS).map(([name, glyph]) => [
    name,
    ({ size = 16, style }: ComponentProps<IconSet[keyof IconSet]>) => (
      <TablerIcon
        glyph={glyph}
        size={officeIconSize(name, size)}
        style={style}
      />
    ),
  ])
) as IconSet;
