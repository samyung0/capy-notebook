import type { IconSet } from '@betteroffice/pptx-react';
import type { ComponentProps } from 'react';
import { officeIconSize } from './officeIconSize';
import {
  borderColorSwatch,
  fillSwatch,
  highlightSwatch,
  TablerIcon,
  textColorSwatch,
} from './TablerIcon';
import {
  alignCenter,
  alignJustified,
  alignLeft,
  alignRight,
  arrowBackUp,
  arrowForwardUp,
  arrowLeft,
  arrowRight,
  bold,
  borderStyle2,
  check,
  chevronDown,
  clearFormatting,
  dots,
  dotsVertical,
  download,
  indentDecrease,
  indentIncrease,
  italic,
  layoutAlignBottom,
  layoutAlignMiddle,
  layoutAlignTop,
  lineHeight,
  list,
  listNumbers,
  maximize,
  minus,
  notes,
  photo,
  playerPause,
  playerPlay,
  plus,
  pointer,
  reload,
  squareLetterT,
  stackBack,
  stackBackward,
  stackForward,
  stackFront,
  textSize,
  triangleSquareCircle,
  underline,
  x,
} from './tablerGlyphs';

/**
 * Every icon pptx-react draws, from Tabler (Q599): the same glyph as the
 * other formats for the same command, Capy's own where Tabler has no fit.
 */
const ICONS: Record<keyof IconSet, ComponentProps<typeof TablerIcon>['glyph']> =
  {
    add: plus,
    alignBottom: layoutAlignBottom,
    alignCenter,
    alignJustify: alignJustified,
    alignLeft,
    alignMiddle: layoutAlignMiddle,
    alignRight,
    alignTop: layoutAlignTop,
    bold,
    borderColor: borderColorSwatch,
    borderWidth: borderStyle2,
    bringForward: stackForward,
    bringToFront: stackFront,
    bulletedList: list,
    check,
    chevronDown,
    clearFormatting,
    fillColor: fillSwatch,
    highlight: highlightSwatch,
    image: photo,
    indentDecrease,
    indentIncrease,
    insertImage: photo,
    italic,
    lineSpacing: lineHeight,
    more: dots,
    newSlide: plus,
    notes,
    numberedList: listNumbers,
    presentationExit: x,
    presentationFullscreen: maximize,
    presentationMore: dotsVertical,
    presentationNext: arrowRight,
    presentationPrevious: arrowLeft,
    presenterNotesSize: textSize,
    presenterPause: playerPause,
    presenterReset: reload,
    presenterResume: playerPlay,
    redo: arrowForwardUp,
    remove: minus,
    save: download,
    select: pointer,
    sendBackward: stackBackward,
    sendToBack: stackBack,
    shape: triangleSquareCircle,
    textBox: squareLetterT,
    textColor: textColorSwatch,
    underline,
    undo: arrowBackUp,
  };

/** Capy's toolbars and menus draw 18px icons (officeIconSize). */
export const pptxIcons = Object.fromEntries(
  Object.entries(ICONS).map(([name, glyph]) => [
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
