import type { IconSet } from '@betteroffice/xlsx-react';
import {
  AlignBottomIcon,
  AlignTopIcon,
  AlignVerticalCenterIcon,
  BorderAllIcon,
  BorderBottomIcon,
  BorderFullIcon,
  BorderHorizontalIcon,
  BorderInnerIcon,
  BorderLeftIcon,
  BorderNoneIcon,
  BorderRightIcon,
  BorderTopIcon,
  BorderVerticalIcon,
  CheckIcon,
  ChevronDownIcon,
  DecimalsArrowLeftIcon,
  DecimalsArrowRightIcon,
  Download01Icon,
  Image01Icon,
  MinusSignIcon,
  MoreVerticalIcon,
  PaintBrush01Icon,
  PaintBucketIcon,
  PlusSignIcon,
  PrinterIcon,
  Redo03Icon,
  RefreshCcwIcon,
  Search01Icon,
  SparklesIcon,
  TableCellsMergeIcon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBoldIcon,
  TextColorIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextWrapIcon,
  Undo03Icon,
} from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import type { ComponentProps } from 'react';
import { HugeIcon } from '@/components/ui/HugeIcon';

/**
 * Every icon xlsx-react draws, from Capy's set: the same icon as Icon.tsx and
 * docxIcons.tsx for the same command. Imported one by one so the rest of
 * Hugeicons stays out of the runtime bundle.
 */
export const XLSX_ICONS: Record<keyof IconSet, IconSvgElement> = {
  add: PlusSignIcon,
  alignCellBottom: AlignBottomIcon,
  alignCellMiddle: AlignVerticalCenterIcon,
  alignCellTop: AlignTopIcon,
  alignLeft: TextAlignLeftIcon,
  alignTextCenter: TextAlignCenterIcon,
  alignTextLeft: TextAlignLeftIcon,
  alignTextRight: TextAlignRightIcon,
  bold: TextBoldIcon,
  borderAll: BorderAllIcon,
  borderBottom: BorderBottomIcon,
  borderHorizontal: BorderHorizontalIcon,
  borderInner: BorderInnerIcon,
  borderLeft: BorderLeftIcon,
  borderNone: BorderNoneIcon,
  borderOuter: BorderFullIcon,
  borderRight: BorderRightIcon,
  borders: BorderAllIcon,
  borderTop: BorderTopIcon,
  borderVertical: BorderVerticalIcon,
  check: CheckIcon,
  chevronDown: ChevronDownIcon,
  decimalDecrease: DecimalsArrowLeftIcon,
  decimalIncrease: DecimalsArrowRightIcon,
  fillColor: PaintBucketIcon,
  formatPaint: PaintBrush01Icon,
  image: Image01Icon,
  italic: TextItalicIcon,
  merge: TableCellsMergeIcon,
  more: MoreVerticalIcon,
  print: PrinterIcon,
  proposals: SparklesIcon,
  redo: Redo03Icon,
  refresh: RefreshCcwIcon,
  remove: MinusSignIcon,
  // Save requests Capy's checkpoint; the DOCX menu draws it the same way.
  save: Download01Icon,
  search: Search01Icon,
  strikethrough: TextStrikethroughIcon,
  textColor: TextColorIcon,
  undo: Undo03Icon,
  verticalAlignCenter: AlignVerticalCenterIcon,
  wrap: TextWrapIcon,
};

/** Capy's toolbars and menus draw 16px icons; smaller requests stay smaller. */
export const xlsxIcons = Object.fromEntries(
  Object.entries(XLSX_ICONS).map(([name, icon]) => [
    name,
    ({ size = 16, style }: ComponentProps<IconSet[keyof IconSet]>) => (
      <HugeIcon icon={icon} size={Math.min(size, 16)} style={style} />
    ),
  ])
) as IconSet;
