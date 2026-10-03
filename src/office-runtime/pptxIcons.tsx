import type { IconSet } from '@betteroffice/pptx-react';
import {
  BringToFrontIcon,
  CheckIcon,
  ChevronDownIcon,
  Cursor01Icon,
  Download01Icon,
  GeometricShapes01Icon,
  Image01Icon,
  LayerBringForwardIcon,
  LayerSendBackwardIcon,
  LayerSendToBackIcon,
  LineStyleIcon,
  MinusSignIcon,
  MoreHorizontalIcon,
  Note01Icon,
  PaintBucketIcon,
  PencilEdit01Icon,
  PlusSignIcon,
  Redo03Icon,
  TextAlignCenterIcon,
  TextAlignJustifyIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBoldIcon,
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
 * Every icon pptx-react's toolbar draws, from Capy's set (the same icon as
 * docxIcons.tsx for the same command). Imported one by one so the rest of
 * Hugeicons stays out of the runtime bundle.
 */
const ICONS: Record<keyof IconSet, IconSvgElement> = {
  add: PlusSignIcon,
  alignCenter: TextAlignCenterIcon,
  alignJustify: TextAlignJustifyIcon,
  alignLeft: TextAlignLeftIcon,
  alignRight: TextAlignRightIcon,
  bold: TextBoldIcon,
  borderColor: PencilEdit01Icon,
  borderWidth: LineStyleIcon,
  bringForward: LayerBringForwardIcon,
  bringToFront: BringToFrontIcon,
  check: CheckIcon,
  chevronDown: ChevronDownIcon,
  fillColor: PaintBucketIcon,
  image: Image01Icon,
  insertImage: Image01Icon,
  italic: TextItalicIcon,
  more: MoreHorizontalIcon,
  newSlide: PlusSignIcon,
  notes: Note01Icon,
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
