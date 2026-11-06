import { m } from '@/i18n';
import { icon, type RibbonLayout, row } from './ribbonLayout';
import { tableCellsMerge } from './TablerIcon';
import {
  alignCenter,
  alignLeft,
  alignRight,
  calendar,
  clock,
  columnInsertLeft,
  columnInsertRight,
  columnRemove,
  currencyDollar,
  eraser,
  layoutAlignBottom,
  layoutAlignMiddle,
  layoutAlignTop,
  number,
  percentage,
  rowInsertBottom,
  rowInsertTop,
  rowRemove,
  selectAll,
  snowflake,
  tablePlus,
  textWrap,
  textWrapDisabled,
} from './tablerGlyphs';

const XLSX_VALIGN = [
  icon('valign:top'),
  icon('valign:middle'),
  icon('valign:bottom'),
];
const XLSX_ALIGN = [
  icon('align:left'),
  icon('align:center'),
  icon('align:right'),
];

/** XLSX: Home and Format from the mocks; the rest group the old menus' items. */
export const XLSX_RIBBON: RibbonLayout = {
  glyphs: {
    'align:center': alignCenter,
    'align:left': alignLeft,
    'align:right': alignRight,
    alignment: alignLeft,
    clearFormatting: eraser,
    delete: rowRemove,
    deleteColumns: columnRemove,
    deleteRows: rowRemove,
    deleteValues: eraser,
    freeze: snowflake,
    insert: rowInsertBottom,
    insertColumnLeft: columnInsertLeft,
    insertColumnRight: columnInsertRight,
    insertRowAbove: rowInsertTop,
    insertRowBelow: rowInsertBottom,
    insertSheet: tablePlus,
    merge: tableCellsMerge,
    'merge:all': tableCellsMerge,
    number,
    'numberFormat:currency': currencyDollar,
    'numberFormat:date': calendar,
    'numberFormat:percent': percentage,
    'numberFormat:time': clock,
    selectAll,
    'valign:bottom': layoutAlignBottom,
    'valign:middle': layoutAlignMiddle,
    'valign:top': layoutAlignTop,
    'wrap:overflow': textWrapDisabled,
    'wrap:wrap': textWrap,
    wrapping: textWrap,
  },
  phoneHome: [
    row('paintFormat'),
    row(
      icon('numberFormat:currency'),
      icon('numberFormat:percent'),
      'decreaseDecimal',
      'increaseDecimal',
      icon('number')
    ),
    row('bold', 'italic', 'strikethrough', 'textColor'),
    row('fillColor', 'borders', icon('merge')),
    row(icon('alignment'), icon('wrapping')),
  ],
  tabs: {
    edit: [
      { big: ['selectAll'], label: m.files_office_ribbon_editing },
      {
        label: m.files_office_ribbon_delete,
        lines: [['deleteValues', 'deleteRows'], ['deleteColumns']],
      },
    ],
    format: [
      {
        label: m.files_office_ribbon_number,
        lines: [
          [{ box: true, id: 'number' }],
          [
            icon('numberFormat:currency'),
            icon('numberFormat:percent'),
            icon('numberFormat:date'),
            icon('numberFormat:time'),
          ],
        ],
      },
      {
        label: m.files_office_ribbon_text,
        lines: [['bold', 'italic', 'strikethrough'], ['clearFormatting']],
      },
      {
        label: m.files_office_ribbon_alignment,
        lines: [XLSX_VALIGN, XLSX_ALIGN],
      },
      {
        label: m.files_office_ribbon_wrapping,
        lines: [['wrap:overflow', 'wrap:wrap'], ['wrap:clip']],
      },
      {
        label: m.files_office_ribbon_merge,
        lines: [
          ['merge:all', 'merge:horizontal'],
          ['merge:vertical', 'merge:unmerge'],
        ],
      },
    ],
    home: [
      { big: ['paintFormatBig'], label: m.files_office_ribbon_clipboard },
      {
        label: m.files_office_ribbon_font,
        lines: [
          ['fontFamily', 'fontSize'],
          [
            'bold',
            'italic',
            'strikethrough',
            'textColor',
            'fillColor',
            'borders',
          ],
        ],
      },
      {
        label: m.files_office_ribbon_alignment,
        lines: [
          [
            ...XLSX_VALIGN,
            { id: 'wrapping', label: m.files_office_ribbon_wrap_text },
          ],
          [...XLSX_ALIGN, 'merge'],
        ],
      },
      {
        label: m.files_office_ribbon_number,
        lines: [
          [{ box: true, id: 'number' }],
          [
            icon('numberFormat:currency'),
            icon('numberFormat:percent'),
            'decreaseDecimal',
            'increaseDecimal',
          ],
        ],
      },
      { big: ['insert', 'delete'], label: m.files_office_ribbon_cells },
      {
        label: m.files_office_ribbon_editing,
        lines: [['clearFormatting'], ['freeze']],
      },
    ],
    insert: [
      {
        label: m.files_office_ribbon_rows,
        lines: [['insertRowAbove'], ['insertRowBelow']],
      },
      {
        label: m.files_office_ribbon_columns,
        lines: [['insertColumnLeft'], ['insertColumnRight']],
      },
      { big: ['insertSheet'], label: m.files_office_ribbon_sheets },
    ],
    view: [
      { big: ['freeze'], label: m.files_office_ribbon_window },
      { label: m.files_office_ribbon_zoom, lines: [['zoom']] },
    ],
  },
};
