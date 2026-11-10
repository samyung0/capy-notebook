/* BlockSuite's icons, with the app's Hugeicons in place of AFFiNE's (Epo
   2026-11-10). Every `@blocksuite/icons/lit` import in the vendored code and in
   ours resolves here (vite.config.ts alias), so one table swaps an icon wherever
   BlockSuite draws it, the note's bars and menus and the board's alike, with no
   edit to the vendored files. A name not listed keeps AFFiNE's drawing: glyphs
   with no Hugeicons counterpart (connector ends, line and shape styles, list
   markers, file types, the heading 4 to 6 marks) and whatever nothing here shows. */

import {
  ArrowDown02Icon,
  ArrowLeft02Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  CheckIcon,
  CheckListIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ClipboardPasteIcon,
  Comment01Icon,
  Copy01Icon,
  Copy02Icon,
  Delete02Icon,
  DistributeHorizontalCenterIcon,
  DistributeVerticalCenterIcon,
  Download01Icon,
  GroupItemsIcon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  HeadingIcon,
  AlignBottomIcon as HiAlignBottom,
  AlignHorizontalCenterIcon as HiAlignHorizontalCenter,
  AlignLeftIcon as HiAlignLeft,
  AlignRightIcon as HiAlignRight,
  AlignTopIcon as HiAlignTop,
  AlignVerticalCenterIcon as HiAlignVerticalCenter,
  ColorPickerIcon as HiColorPicker,
  HighlighterIcon,
  MoreHorizontalIcon as HiMoreHorizontal,
  MoreVerticalIcon as HiMoreVertical,
  SmileIcon as HiSmile,
  TableIcon as HiTable,
  TextAlignCenterIcon as HiTextAlignCenter,
  TextAlignLeftIcon as HiTextAlignLeft,
  TextAlignRightIcon as HiTextAlignRight,
  Image01Icon,
  InformationCircleIcon,
  InsertColumnLeftIcon,
  InsertColumnRightIcon,
  InsertRowDownIcon,
  InsertRowUpIcon,
  LayerBringToFrontIcon,
  LayerSendToBackIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link04Icon,
  MinusSignIcon,
  PaintBoardIcon,
  PencilEdit01Icon,
  PlusSignIcon,
  QuoteDownIcon,
  RefreshIcon,
  Search01Icon,
  SolidLine01Icon,
  SourceCodeIcon,
  SourceCodeSquareIcon,
  SquareLock02Icon,
  SquareUnlock02Icon,
  SubtitleIcon,
  TextBoldIcon,
  TextColorIcon,
  TextFontIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
  UngroupItemsIcon,
  Unlink04Icon,
} from '@hugeicons/core-free-icons';
import { html } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { iconBody } from './chromeIcons';

// AFFiNE's own set, for every name not replaced below. The app does not depend on
// the package, so it is reached through the vendored components package's link to
// it, by a path the alias does not match.
export * from '../../../vendor/blocksuite/affine/components/node_modules/@blocksuite/icons/dist/lit';

type Props = { height?: string; style?: string; width?: string };

/** A Hugeicons icon behind AFFiNE's icon signature: sized by `width` and
 * `height` (1em by default, so the bar's icon size applies). */
function hi(icon: unknown) {
  const body = unsafeSVG(iconBody(icon));
  return ({ width = '1em', height = '1em', style = '' }: Props = {}) =>
    html`<svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width=${width}
      height=${height}
      fill="none"
      style=${`user-select:none;flex-shrink:0;${style}`}
    >
      ${body}
    </svg>`;
}

// Text and blocks.
export const TextIcon = hi(TextFontIcon);
export const FontIcon = hi(TextFontIcon);
export const HeadingsIcon = hi(HeadingIcon);
export const Heading1Icon = hi(Heading01Icon);
export const Heading2Icon = hi(Heading02Icon);
export const Heading3Icon = hi(Heading03Icon);
export const BulletedListIcon = hi(LeftToRightListBulletIcon);
export const NumberedListIcon = hi(LeftToRightListNumberIcon);
export const CheckBoxCheckLinearIcon = hi(CheckListIcon);
export const CodeBlockIcon = hi(SourceCodeSquareIcon);
export const QuoteIcon = hi(QuoteDownIcon);
export const DividerIcon = hi(SolidLine01Icon);
export const TableIcon = hi(HiTable);
export const ImageIcon = hi(Image01Icon);

// Marks.
export const BoldIcon = hi(TextBoldIcon);
export const ItalicIcon = hi(TextItalicIcon);
export const UnderLineIcon = hi(TextUnderlineIcon);
export const StrikeThroughIcon = hi(TextStrikethroughIcon);
export const CodeIcon = hi(SourceCodeIcon);
export const LinkIcon = hi(Link04Icon);
export const UnlinkIcon = hi(Unlink04Icon);
export const TextAlignLeftIcon = hi(HiTextAlignLeft);
export const TextAlignCenterIcon = hi(HiTextAlignCenter);
export const TextAlignRightIcon = hi(HiTextAlignRight);
export const TextBackgroundDuotoneIcon = hi(TextColorIcon);
export const HighLightDuotoneIcon = hi(HighlighterIcon);

// Actions.
export const CopyIcon = hi(Copy01Icon);
export const PasteIcon = hi(ClipboardPasteIcon);
export const DuplicateIcon = hi(Copy02Icon);
export const DeleteIcon = hi(Delete02Icon);
export const EditIcon = hi(PencilEdit01Icon);
export const DownloadIcon = hi(Download01Icon);
export const CaptionIcon = hi(SubtitleIcon);
export const CommentIcon = hi(Comment01Icon);
export const SearchIcon = hi(Search01Icon);
export const ResetIcon = hi(RefreshIcon);
export const CloseIcon = hi(Cancel01Icon);
export const DoneIcon = hi(CheckIcon);
export const PlusIcon = hi(PlusSignIcon);
export const MinusIcon = hi(MinusSignIcon);
export const MoreHorizontalIcon = hi(HiMoreHorizontal);
export const MoreVerticalIcon = hi(HiMoreVertical);
export const InformationIcon = hi(InformationCircleIcon);
export const PaletteIcon = hi(PaintBoardIcon);
export const ColorPickerIcon = hi(HiColorPicker);
export const SmileIcon = hi(HiSmile);

// Arrows.
export const ArrowDownSmallIcon = hi(ChevronDownIcon);
export const ArrowUpSmallIcon = hi(ChevronUpIcon);
export const ArrowLeftSmallIcon = hi(ChevronLeftIcon);
export const ArrowRightSmallIcon = hi(ChevronRightIcon);
export const ArrowDownBigIcon = hi(ArrowDown02Icon);
export const ArrowUpBigIcon = hi(ArrowUp02Icon);
export const ArrowLeftBigIcon = hi(ArrowLeft02Icon);
export const ArrowRightBigIcon = hi(ArrowRight02Icon);
export const ToggleDownIcon = hi(ChevronDownIcon);
export const ToggleRightIcon = hi(ChevronRightIcon);

// Tables.
export const InsertAboveIcon = hi(InsertRowUpIcon);
export const InsertBelowIcon = hi(InsertRowDownIcon);
export const InsertLeftIcon = hi(InsertColumnLeftIcon);
export const InsertRightIcon = hi(InsertColumnRightIcon);

// The board's selection bars.
export const AlignLeftIcon = hi(HiAlignLeft);
export const AlignRightIcon = hi(HiAlignRight);
export const AlignTopIcon = hi(HiAlignTop);
export const AlignBottomIcon = hi(HiAlignBottom);
export const AlignHorizontalCenterIcon = hi(HiAlignHorizontalCenter);
export const AlignVerticalCenterIcon = hi(HiAlignVerticalCenter);
export const DistributeHorizontalIcon = hi(DistributeHorizontalCenterIcon);
export const DistributeVerticalIcon = hi(DistributeVerticalCenterIcon);
export const ArrowUpBigTopIcon = hi(LayerBringToFrontIcon);
export const ArrowDownBigBottomIcon = hi(LayerSendToBackIcon);
export const GroupingIcon = hi(GroupItemsIcon);
export const GroupIcon = hi(GroupItemsIcon);
export const UngroupIcon = hi(UngroupItemsIcon);
export const LockIcon = hi(SquareLock02Icon);
export const UnlockIcon = hi(SquareUnlock02Icon);
