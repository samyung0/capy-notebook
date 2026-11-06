import { m } from '@/i18n';
import { icon, type RibbonCell, type RibbonLayout, row } from './ribbonLayout';
import {
  alignBoxCenterMiddle,
  alignCenter,
  alignJustified,
  alignLeft,
  alignRight,
  arrowBarToDown,
  arrowBarToUp,
  arrowDown,
  arrowUp,
  layoutAlignBottom,
  layoutAlignCenter,
  layoutAlignLeft,
  layoutAlignMiddle,
  layoutAlignRight,
  layoutAlignTop,
  layoutDistributeHorizontal,
  layoutDistributeVertical,
  lineHeight,
  notes,
  photo,
  plus,
  presentation,
  selectAll,
  squareLetterT,
  stack2,
  stackBack,
  stackBackward,
  stackForward,
  stackFront,
  strikethrough,
  subscript,
  superscript,
  textDecrease,
  textIncrease,
  trash,
  triangleSquareCircle,
  zoomIn,
} from './tablerGlyphs';

const NEW_SLIDE: RibbonCell = { id: 'new-slide-layout', split: 'slide.new' };

/** PPTX: Home and Slide from the mocks; the rest group the old menus' items. */
export const PPTX_RIBBON: RibbonLayout = {
  glyphs: {
    'align-objects': layoutAlignLeft,
    'arrange.align:bottom': layoutAlignBottom,
    'arrange.align:center': layoutAlignCenter,
    'arrange.align:left': layoutAlignLeft,
    'arrange.align:middle': layoutAlignMiddle,
    'arrange.align:right': layoutAlignRight,
    'arrange.align:top': layoutAlignTop,
    'arrange.bringForward': stackForward,
    'arrange.bringToFront': stackFront,
    'arrange.centerOnPage:horizontal': alignBoxCenterMiddle,
    'arrange.centerOnPage:vertical': alignBoxCenterMiddle,
    'arrange.distribute:horizontal': layoutDistributeHorizontal,
    'arrange.distribute:vertical': layoutDistributeVertical,
    'arrange.sendBackward': stackBackward,
    'arrange.sendToBack': stackBack,
    'border-weight': lineHeight,
    distribute: layoutDistributeVertical,
    'edit.delete': trash,
    'edit.selectAll': selectAll,
    'format.alignBottom': layoutAlignBottom,
    'format.alignCenter': alignCenter,
    'format.alignJustify': alignJustified,
    'format.alignLeft': alignLeft,
    'format.alignMiddle': layoutAlignMiddle,
    'format.alignRight': alignRight,
    'format.alignTop': layoutAlignTop,
    'format.decreaseFontSize': textDecrease,
    'format.increaseFontSize': textIncrease,
    'format.strikethrough': strikethrough,
    'format.subscript': subscript,
    'format.superscript': superscript,
    'insert.image': photo,
    'insert.textBox': squareLetterT,
    'new-slide-layout': plus,
    order: stack2,
    present: presentation,
    shape: triangleSquareCircle,
    'slide.delete': trash,
    'slide.moveDown': arrowDown,
    'slide.moveToEnd': arrowBarToDown,
    'slide.moveToStart': arrowBarToUp,
    'slide.moveUp': arrowUp,
    'slide.new': plus,
    spacing: lineHeight,
    'view.speakerNotes': notes,
    zoom: zoomIn,
  },
  phoneHome: [
    row(NEW_SLIDE),
    row('select', icon('insert.textBox'), icon('insert.image'), icon('shape')),
    row('bold', 'italic', 'underline', 'textColor', 'highlight'),
    row('align', 'lineSpacing'),
    row('bulletedList', 'numberedList', 'decreaseIndent', 'increaseIndent'),
    row('clearFormatting'),
    row('fill', 'shapeBorderColor', 'shapeBorderWidth', 'shapeAdjustment'),
  ],
  tabs: {
    arrange: [
      {
        label: m.files_office_ribbon_order,
        lines: [
          ['arrange.bringToFront', 'arrange.bringForward'],
          ['arrange.sendToBack', 'arrange.sendBackward'],
        ],
      },
      {
        label: m.files_office_ribbon_alignment,
        lines: [
          [
            icon('arrange.align:left'),
            icon('arrange.align:center'),
            icon('arrange.align:right'),
          ],
          [
            icon('arrange.align:top'),
            icon('arrange.align:middle'),
            icon('arrange.align:bottom'),
          ],
        ],
      },
      {
        label: m.files_office_ribbon_distribute,
        lines: [
          ['arrange.distribute:horizontal'],
          ['arrange.distribute:vertical'],
        ],
      },
      {
        label: m.files_office_ribbon_center_on_page,
        lines: [
          ['arrange.centerOnPage:horizontal'],
          ['arrange.centerOnPage:vertical'],
        ],
      },
    ],
    edit: [
      {
        label: m.files_office_ribbon_editing,
        lines: [['edit.selectAll'], ['edit.delete']],
      },
    ],
    format: [
      {
        label: m.files_office_ribbon_text,
        lines: [
          ['bold', 'italic', 'underline', icon('format.strikethrough')],
          [
            icon('format.superscript'),
            icon('format.subscript'),
            icon('format.decreaseFontSize'),
            icon('format.increaseFontSize'),
          ],
        ],
      },
      {
        label: m.files_office_ribbon_alignment,
        lines: [
          [
            icon('format.alignLeft'),
            icon('format.alignCenter'),
            icon('format.alignRight'),
            icon('format.alignJustify'),
          ],
          [
            icon('format.alignTop'),
            icon('format.alignMiddle'),
            icon('format.alignBottom'),
          ],
        ],
      },
      {
        label: m.files_office_ribbon_paragraph,
        lines: [
          ['bulletedList', 'numberedList', 'decreaseIndent', 'increaseIndent'],
          ['spacing', 'clearFormatting'],
        ],
      },
      { big: ['border-weight'], label: m.files_office_ribbon_borders },
    ],
    home: [
      {
        big: [NEW_SLIDE],
        label: m.files_office_ribbon_slides,
        lines: [
          [{ id: 'slide.delete', label: m.files_office_ribbon_delete }],
          [],
        ],
      },
      {
        label: m.files_office_ribbon_font,
        lines: [
          ['fontFamily', 'fontSize'],
          [
            'bold',
            'italic',
            'underline',
            icon('format.strikethrough'),
            'textColor',
            'highlight',
          ],
        ],
      },
      {
        label: m.files_office_ribbon_paragraph,
        lines: [
          ['bulletedList', 'numberedList', 'decreaseIndent', 'increaseIndent'],
          ['align', 'lineSpacing', 'clearFormatting'],
        ],
      },
      {
        label: m.files_office_ribbon_drawing,
        lines: [
          ['insert.textBox', 'insert.image', 'shape'],
          ['fill', 'shapeBorderColor', 'shapeBorderWidth', 'shapeAdjustment'],
        ],
      },
      {
        big: ['order'],
        label: m.files_office_ribbon_arrange,
        lines: [['align-objects'], ['distribute']],
      },
    ],
    insert: [
      {
        label: m.files_office_ribbon_tools,
        lines: [
          ['select', 'insert.textBox'],
          ['insert.image', 'shape'],
        ],
      },
      { big: [NEW_SLIDE], label: m.files_office_ribbon_slides },
    ],
    slide: [
      { big: [NEW_SLIDE], label: m.files_office_ribbon_new },
      {
        big: [{ gallery: true, id: 'new-slide-layout' }],
        label: m.files_office_ribbon_layouts,
      },
      { big: ['slide.delete'], label: m.files_office_ribbon_delete },
      {
        label: m.files_office_ribbon_move_slide,
        lines: [
          ['slide.moveUp', 'slide.moveToStart'],
          ['slide.moveDown', 'slide.moveToEnd'],
        ],
      },
    ],
    view: [
      { big: ['present'], label: m.files_office_ribbon_present },
      { label: m.files_office_ribbon_zoom, lines: [['zoom']] },
      { label: m.files_office_ribbon_show, lines: [['view.speakerNotes']] },
    ],
  },
};
