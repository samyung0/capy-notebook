import type { IconSet } from '@betteroffice/pptx-react';
import {
  ALargeSmallIcon,
  AlignBottomIcon,
  AlignTopIcon,
  AlignVerticalCenterIcon,
  ArrowLeft04Icon,
  ArrowRight04Icon,
  BringToFrontIcon,
  Cancel01Icon,
  CheckIcon,
  ChevronDownIcon,
  Cursor01Icon,
  Download01Icon,
  FullScreenIcon,
  GeometricShapes01Icon,
  HighlighterIcon,
  Image01Icon,
  LayerBringForwardIcon,
  LayerSendBackwardIcon,
  LayerSendToBackIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  LineStyleIcon,
  ListIndentDecreaseIcon,
  ListIndentIncreaseIcon,
  MinusSignIcon,
  MoreHorizontalIcon,
  MoreVerticalIcon,
  Note01Icon,
  PaintBucketIcon,
  PauseIcon,
  PencilEdit01Icon,
  PlayIcon,
  PlusSignIcon,
  Redo03Icon,
  RefreshIcon,
  TextAlignCenterIcon,
  TextAlignJustifyIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBoldIcon,
  TextClearIcon,
  TextColorIcon,
  TextItalicIcon,
  TextSquareIcon,
  TextUnderlineIcon,
  Undo03Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import type { ComponentProps } from 'react';
import { HugeIcon } from '@/components/ui/HugeIcon';

/**
 * Every icon pptx-react's toolbar, show and presenter window draw, from
 * Capy's set (the same icon as docxIcons.tsx for the same command, and the
 * viewer pager's arrows for the presenter's). Imported one by one so the rest of
 * Hugeicons stays out of the runtime bundle.
 */
const ICONS: Record<keyof IconSet, IconSvgElement | readonly string[]> = {
  add: PlusSignIcon,
  alignBottom: AlignBottomIcon,
  alignCenter: TextAlignCenterIcon,
  alignJustify: TextAlignJustifyIcon,
  alignLeft: TextAlignLeftIcon,
  alignMiddle: AlignVerticalCenterIcon,
  alignRight: TextAlignRightIcon,
  alignTop: AlignTopIcon,
  bold: TextBoldIcon,
  borderColor: PencilEdit01Icon,
  borderWidth: LineStyleIcon,
  bringForward: LayerBringForwardIcon,
  bringToFront: BringToFrontIcon,
  bulletedList: LeftToRightListBulletIcon,
  check: CheckIcon,
  chevronDown: ChevronDownIcon,
  clearFormatting: TextClearIcon,
  fillColor: PaintBucketIcon,
  highlight: HighlighterIcon,
  image: Image01Icon,
  indentDecrease: ListIndentDecreaseIcon,
  indentIncrease: ListIndentIncreaseIcon,
  insertImage: Image01Icon,
  italic: TextItalicIcon,
  // Capy's own drawing where Hugeicons has none, as docxIcons.tsx.
  lineSpacing: [
    'M11 6h9',
    'M11 12h9',
    'M11 18h9',
    'M6 5v14',
    'M3.5 7.5 6 5l2.5 2.5',
    'M3.5 16.5 6 19l2.5-2.5',
  ],
  more: MoreHorizontalIcon,
  newSlide: PlusSignIcon,
  notes: Note01Icon,
  numberedList: LeftToRightListNumberIcon,
  presentationExit: Cancel01Icon,
  presentationFullscreen: FullScreenIcon,
  presentationMore: MoreVerticalIcon,
  presentationNext: ArrowRight04Icon,
  presentationPrevious: ArrowLeft04Icon,
  presenterNotesSize: ALargeSmallIcon,
  presenterPause: PauseIcon,
  presenterReset: RefreshIcon,
  presenterResume: PlayIcon,
  redo: Redo03Icon,
  remove: MinusSignIcon,
  save: Download01Icon,
  select: Cursor01Icon,
  sendBackward: LayerSendBackwardIcon,
  sendToBack: LayerSendToBackIcon,
  shape: GeometricShapes01Icon,
  textBox: TextSquareIcon,
  textColor: TextColorIcon,
  underline: TextUnderlineIcon,
  undo: Undo03Icon,
};

/** Capy's toolbars and menus draw 16px icons; smaller requests (chevrons) stay smaller. */
export const pptxIcons = Object.fromEntries(
  Object.entries(ICONS).map(([name, icon]) => [
    name,
    ({ size = 16, style }: ComponentProps<IconSet[keyof IconSet]>) => (
      <HugeIcon icon={icon} size={Math.min(size, 16)} style={style} />
    ),
  ])
) as IconSet;
