import type { IconSet } from '@betteroffice/xlsx-react';
import {
  AlignBottomIcon,
  AlignTopIcon,
  AlignVerticalCenterIcon,
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
import { BorderIcon, type BorderIconKind } from './borderIcons';
import { officeIconSize } from './officeIconSize';

/**
 * Every icon xlsx-react draws, from Capy's set: the same icon as Icon.tsx and
 * docxIcons.tsx for the same command, with the border icons drawn by hand
 * (borderIcons.tsx). Imported one by one so the rest of Hugeicons stays out of
 * the runtime bundle.
 */
export const XLSX_ICONS: Record<
  keyof IconSet,
  IconSvgElement | { border: BorderIconKind }
> = {
  add: PlusSignIcon,
  alignCellBottom: AlignBottomIcon,
  alignCellMiddle: AlignVerticalCenterIcon,
  alignCellTop: AlignTopIcon,
  alignLeft: TextAlignLeftIcon,
  alignTextCenter: TextAlignCenterIcon,
  alignTextLeft: TextAlignLeftIcon,
  alignTextRight: TextAlignRightIcon,
  bold: TextBoldIcon,
  borderAll: { border: 'all' },
  borderBottom: { border: 'bottom' },
  borderHorizontal: { border: 'horizontal' },
  borderInner: { border: 'inner' },
  borderLeft: { border: 'left' },
  borderNone: { border: 'none' },
  borderOuter: { border: 'outer' },
  borderRight: { border: 'right' },
  borders: { border: 'all' },
  borderTop: { border: 'top' },
  borderVertical: { border: 'vertical' },
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

/** Capy's toolbars and menus draw 18px icons (officeIconSize). */
export const xlsxIcons = Object.fromEntries(
  Object.entries(XLSX_ICONS).map(([name, icon]) => [
    name,
    ({ size = 16, style }: ComponentProps<IconSet[keyof IconSet]>) =>
      'border' in icon ? (
        <BorderIcon
          kind={icon.border}
          size={officeIconSize(name, size)}
          style={style}
        />
      ) : (
        <HugeIcon icon={icon} size={officeIconSize(name, size)} style={style} />
      ),
  ])
) as IconSet;
