import { m } from '@/i18n';
import { icon, type RibbonLayout, row } from './ribbonLayout';
import {
  alignCenter,
  layoutAlignMiddle,
  link,
  list,
  listNumbers,
  listTree,
  message,
  messagePlus,
  pageBreak,
  photo,
  refresh,
  ruler2,
  search,
  section,
  selectAll,
  table,
  tableOptions,
  textDirectionLtr,
  textDirectionRtl,
  trash,
} from './tablerGlyphs';

/** DOCX: Home and Insert from the mocks; the rest group the old menus' items. */
export const DOCX_RIBBON: RibbonLayout = {
  glyphs: {
    bulletList: list,
    delete: trash,
    'find-replace': search,
    'insert-comment': messagePlus,
    'insert-image': photo,
    'insert-link': link,
    'insert-page-break': pageBreak,
    'insert-section-continuous': section,
    'insert-section-next': section,
    'insert-table': table,
    'insert-toc': listTree,
    ltr: textDirectionLtr,
    numberedList: listNumbers,
    rtl: textDirectionRtl,
    'select-all': selectAll,
    'show-comments': message,
    'show-outline': listTree,
    'show-ruler': ruler2,
    'table-alignment': alignCenter,
    'table-properties': tableOptions,
    'table-vertical-align': layoutAlignMiddle,
    'update-toc': refresh,
  },
  phoneHome: [
    row('stylePicker'),
    row('bold', 'italic', 'underline', 'textColor', 'highlight'),
    row(icon('insert-link'), icon('insert-comment'), icon('insert-image')),
    row('alignment', 'lineSpacing'),
    row('lists'),
    row('clearFormatting'),
  ],
  tabs: {
    edit: [
      {
        big: ['find-replace'],
        label: m.files_office_ribbon_editing,
        lines: [['select-all'], ['delete']],
      },
    ],
    format: [
      {
        label: m.files_office_ribbon_text,
        lines: [
          ['bold', 'italic', 'underline', 'strike'],
          ['superscript', 'subscript', 'clearFormatting'],
        ],
      },
      {
        label: m.files_office_ribbon_paragraph,
        lines: [
          ['lists'],
          [
            'alignLeft',
            'alignCenter',
            'alignRight',
            'alignJustify',
            'lineSpacing',
          ],
        ],
      },
      { big: ['styleGallery'], label: m.files_office_ribbon_styles },
      { label: m.files_office_ribbon_direction, lines: [['ltr'], ['rtl']] },
    ],
    home: [
      {
        label: m.files_office_ribbon_font,
        lines: [
          ['fontFamily', 'fontSize'],
          [
            'bold',
            'italic',
            'underline',
            'strike',
            'textColor',
            'highlight',
            'clearFormatting',
          ],
        ],
      },
      {
        label: m.files_office_ribbon_paragraph,
        lines: [
          ['lists'],
          [
            'alignLeft',
            'alignCenter',
            'alignRight',
            'alignJustify',
            'lineSpacing',
          ],
        ],
      },
      { big: ['styleGallery'], label: m.files_office_ribbon_styles },
      {
        big: ['insert-image', 'insert-table'],
        label: m.files_office_ribbon_insert,
        lines: [['insert-link'], ['insert-comment']],
      },
    ],
    insert: [
      { big: ['insert-image'], label: m.files_office_ribbon_illustrations },
      { big: ['insert-table'], label: m.files_office_ribbon_tables },
      { big: ['insert-link'], label: m.files_office_ribbon_links },
      { big: ['insert-comment'], label: m.files_office_ribbon_comments },
      {
        label: m.files_office_ribbon_breaks,
        lines: [
          ['insert-page-break'],
          ['insert-section-next', 'insert-section-continuous'],
        ],
      },
      {
        big: ['insert-toc', 'update-toc'],
        label: m.files_office_ribbon_contents,
      },
    ],
    picture: [
      {
        label: m.files_office_tab_picture,
        lines: [['imageWrap', 'imageTransform'], ['imageProperties']],
      },
    ],
    table: [
      {
        label: m.files_office_ribbon_borders,
        lines: [
          ['tableBorders', 'tableBorderColor'],
          ['tableBorderWidth', 'tableCellFill'],
        ],
      },
      {
        label: m.files_office_ribbon_alignment,
        lines: [['table-vertical-align'], ['table-alignment']],
      },
      {
        label: m.files_office_ribbon_layout,
        lines: [
          ['table-header-row', 'table-distribute'],
          ['table-wrap-text', 'table-autofit'],
        ],
      },
      {
        big: ['table-properties', 'tableMore'],
        label: m.files_office_tab_table,
      },
    ],
    view: [
      {
        label: m.files_office_ribbon_show,
        lines: [['show-ruler', 'show-outline'], ['show-comments']],
      },
      { label: m.files_office_ribbon_zoom, lines: [['zoom']] },
    ],
  },
};
