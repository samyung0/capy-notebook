import {
  BULLET_PRESETS,
  NUMBER_PRESETS,
  PPTX_COMMAND_EDITS,
  type PptxCommandId,
  type PptxCommandState,
  presetLabel,
  SHAPE_PRESETS,
} from '@betteroffice/pptx-react';
import {
  OFFICE_HOST_COMMANDS,
  type OfficeMenu,
  type OfficeMenuEntry,
} from '@/features/files/officeMenus';
import type { OfficeLocale } from '@/features/files/officeProtocol';
import { m } from '@/i18n';
import {
  fileOutputs,
  item,
  pptxT,
  separator,
  shortcut,
  submenu,
} from './pptxMenus';

/**
 * A menu item id carries its command's value after a colon ("view.zoom:1.5"),
 * as `menu-command` sends ids only.
 */
export function splitCommand(id: string): [PptxCommandId, string | undefined] {
  const at = id.indexOf(':');
  return at < 0
    ? [id as PptxCommandId, undefined]
    : [id.slice(0, at) as PptxCommandId, id.slice(at + 1)];
}

const ZOOMS = ['0.5', '0.75', '1', '1.25', '1.5', '2'];
const BORDER_WEIGHTS = ['1', '2', '3', '4', '8'];
const LINE_SPACINGS = ['1', '1.15', '1.5', '2'];

/** Edit mode, after Google Slides' menus; state from PptxEditor's onCommandState. */
export function editorMenus(
  state: PptxCommandState,
  locale: OfficeLocale
): OfficeMenu[] {
  const t = pptxT(locale);
  const command = (
    id: PptxCommandId,
    label: string,
    extra: Partial<Extract<OfficeMenuEntry, { kind: 'item' }>> = {}
  ) =>
    item(id, label, {
      ...extra,
      disabled: !state.enabled[id] || undefined,
      edits: PPTX_COMMAND_EDITS[id],
    });
  const toggle = (id: PptxCommandId, label: string, keys?: string) =>
    command(id, label, {
      checked: state.checked.includes(id),
      shortcut: keys && shortcut(keys),
    });
  const valued = (
    id: PptxCommandId,
    value: string,
    label: string,
    current?: string | null
  ) =>
    item(`${id}:${value}`, label, {
      checked: current === undefined ? undefined : value === current,
      disabled: !state.enabled[id] || undefined,
      edits: PPTX_COMMAND_EDITS[id],
    });
  const layouts = state.slideLayouts.map((layout) =>
    valued('slide.newWithLayout', layout.value, layout.label)
  );
  const newSlides = [
    command('slide.new', t('toolbar.newSlide'), { icon: 'plus' }),
    ...(layouts.length
      ? [submenu('new-slide-layout', t('toolbar.newSlideWithLayout'), layouts)]
      : []),
  ];
  return [
    {
      id: 'file',
      items: [
        // Capy saves (the checkpoint), as Ctrl/Cmd+S does in the frame.
        item(OFFICE_HOST_COMMANDS.save, t('toolbar.save'), {
          edits: true,
          icon: 'cloudSync',
          shortcut: shortcut('Mod+S'),
        }),
        separator,
        ...fileOutputs(),
      ],
      label: m.files_office_pptx_menu_file(),
    },
    {
      id: 'edit',
      items: [
        command('edit.undo', t('toolbar.undo'), {
          icon: 'undo',
          shortcut: shortcut('Mod+Z'),
        }),
        command('edit.redo', t('toolbar.redo'), {
          icon: 'redo',
          shortcut: shortcut('Shift+Mod+Z'),
        }),
        separator,
        command('edit.selectAll', m.files_office_pptx_select_all(), {
          shortcut: shortcut('Mod+A'),
        }),
        command('edit.delete', m.files_office_pptx_delete(), { icon: 'trash' }),
      ],
      label: m.files_office_pptx_menu_edit(),
    },
    {
      id: 'view',
      items: [
        command('view.present', t('toolbar.present'), { icon: 'presentation' }),
        submenu(
          'zoom',
          t('toolbar.groups.zoom'),
          [
            valued('view.zoom', 'fit', t('toolbar.fit'), state.zoom),
            ...ZOOMS.map((zoom) =>
              valued('view.zoom', zoom, `${Number(zoom) * 100}%`, state.zoom)
            ),
          ],
          'zoomIn'
        ),
        separator,
        toggle('view.speakerNotes', t('notes.showSpeakerNotes')),
      ],
      label: m.files_office_pptx_menu_view(),
    },
    {
      id: 'insert',
      items: [
        command('insert.textBox', t('toolbar.textBoxTool'), { icon: 'text' }),
        // Capy opens the picker: a click in its menu gives the frame no user
        // activation to open one.
        command('insert.image', m.files_office_pptx_image(), {
          icon: 'image',
          pick: 'image',
        }),
        submenu(
          'shape',
          t('toolbar.shapeTool'),
          SHAPE_PRESETS.map((preset) =>
            valued('insert.shape', preset.geometry, t(preset.labelKey))
          ),
          'shape'
        ),
        separator,
        ...newSlides,
      ],
      label: m.files_office_pptx_menu_insert(),
    },
    {
      id: 'format',
      items: [
        submenu(
          'text',
          m.files_office_pptx_text(),
          [
            toggle('format.bold', t('toolbar.bold'), 'Mod+B'),
            toggle('format.italic', t('toolbar.italic'), 'Mod+I'),
            toggle('format.underline', t('toolbar.underline'), 'Mod+U'),
            toggle(
              'format.strikethrough',
              t('toolbar.strikethrough'),
              'Shift+Mod+X'
            ),
            toggle('format.superscript', t('toolbar.superscript'), 'Mod+.'),
            toggle('format.subscript', t('toolbar.subscript'), 'Mod+,'),
            separator,
            submenu('size', m.files_office_pptx_size(), [
              command(
                'format.increaseFontSize',
                t('toolbar.increaseFontSize'),
                {
                  shortcut: shortcut('Shift+Mod+.'),
                }
              ),
              command(
                'format.decreaseFontSize',
                t('toolbar.decreaseFontSize'),
                {
                  shortcut: shortcut('Shift+Mod+,'),
                }
              ),
            ]),
          ],
          'bold'
        ),
        submenu(
          'align',
          m.files_office_pptx_align_indent(),
          [
            toggle('format.alignLeft', t('toolbar.align.left')),
            toggle('format.alignCenter', t('toolbar.align.center')),
            toggle('format.alignRight', t('toolbar.align.right')),
            toggle('format.alignJustify', t('toolbar.align.justify')),
            separator,
            toggle('format.alignTop', t('toolbar.align.top')),
            toggle('format.alignMiddle', t('toolbar.align.middle')),
            toggle('format.alignBottom', t('toolbar.align.bottom')),
            separator,
            command('format.increaseIndent', t('toolbar.increaseIndent'), {
              icon: 'indentIncrease',
              shortcut: shortcut('Mod+]'),
            }),
            command('format.decreaseIndent', t('toolbar.decreaseIndent'), {
              icon: 'indentDecrease',
              shortcut: shortcut('Mod+['),
            }),
          ],
          'alignLeft'
        ),
        submenu('spacing', t('toolbar.lineSpacing.label'), [
          ...LINE_SPACINGS.map((value) =>
            valued(
              'format.lineSpacing',
              value,
              value === '1'
                ? t('toolbar.lineSpacing.single')
                : value === '2'
                  ? t('toolbar.lineSpacing.double')
                  : value,
              state.lineSpacing
            )
          ),
          separator,
          command(
            'format.spaceBefore',
            t(
              state.checked.includes('format.spaceBefore')
                ? 'toolbar.lineSpacing.removeSpaceBefore'
                : 'toolbar.lineSpacing.addSpaceBefore'
            )
          ),
          command(
            'format.spaceAfter',
            t(
              state.checked.includes('format.spaceAfter')
                ? 'toolbar.lineSpacing.removeSpaceAfter'
                : 'toolbar.lineSpacing.addSpaceAfter'
            )
          ),
        ]),
        submenu(
          'lists',
          m.files_office_pptx_bullets_numbering(),
          [
            submenu(
              'numbered',
              t('toolbar.numberedList'),
              NUMBER_PRESETS.map((preset) =>
                valued(
                  'format.numberedList',
                  preset.id,
                  presetLabel(preset.id),
                  state.checked.includes('format.numberedList')
                    ? state.listStyle
                    : null
                )
              ),
              'listOrdered'
            ),
            submenu(
              'bulleted',
              t('toolbar.bulletedList'),
              BULLET_PRESETS.map((preset) =>
                valued(
                  'format.bulletedList',
                  preset.id,
                  presetLabel(preset.id),
                  state.checked.includes('format.bulletedList')
                    ? state.listStyle
                    : null
                )
              ),
              'list'
            ),
          ],
          'list'
        ),
        submenu('borders', m.files_office_pptx_borders(), [
          submenu('border-weight', t('toolbar.borderWidth'), [
            valued(
              'format.borderWeight',
              '',
              t('toolbar.noBorder'),
              state.borderWeight
            ),
            ...BORDER_WEIGHTS.map((width) =>
              valued(
                'format.borderWeight',
                width,
                t('toolbar.borderWidthValue', { width }),
                state.borderWeight
              )
            ),
          ]),
        ]),
        separator,
        command('format.clearFormatting', t('toolbar.clearFormatting'), {
          shortcut: shortcut('Mod+\\'),
        }),
      ],
      label: m.files_office_pptx_menu_format(),
    },
    {
      id: 'slide',
      items: [
        ...newSlides,
        command('slide.delete', t('toolbar.deleteSlide'), { icon: 'trash' }),
        submenu('move-slide', m.files_office_pptx_move_slide(), [
          command('slide.moveUp', m.files_office_pptx_move_up(), {
            icon: 'arrowUp',
          }),
          command('slide.moveDown', m.files_office_pptx_move_down(), {
            icon: 'arrowDown',
          }),
          command('slide.moveToStart', m.files_office_pptx_move_start()),
          command('slide.moveToEnd', m.files_office_pptx_move_end()),
        ]),
      ],
      label: m.files_office_pptx_menu_slide(),
    },
    {
      id: 'arrange',
      items: [
        submenu('order', m.files_office_pptx_order(), [
          command('arrange.bringToFront', t('toolbar.bringToFront')),
          command('arrange.bringForward', t('toolbar.bringForward')),
          command('arrange.sendBackward', t('toolbar.sendBackward')),
          command('arrange.sendToBack', t('toolbar.sendToBack')),
        ]),
        submenu('align-objects', m.files_office_pptx_align(), [
          valued('arrange.align', 'left', m.files_office_pptx_align_left()),
          valued('arrange.align', 'center', m.files_office_pptx_align_center()),
          valued('arrange.align', 'right', m.files_office_pptx_align_right()),
          separator,
          valued('arrange.align', 'top', m.files_office_pptx_align_top()),
          valued('arrange.align', 'middle', m.files_office_pptx_align_middle()),
          valued('arrange.align', 'bottom', m.files_office_pptx_align_bottom()),
        ]),
        submenu('distribute', m.files_office_pptx_distribute(), [
          valued(
            'arrange.distribute',
            'horizontal',
            m.files_office_pptx_horizontally()
          ),
          valued(
            'arrange.distribute',
            'vertical',
            m.files_office_pptx_vertically()
          ),
        ]),
        submenu('center-on-page', m.files_office_pptx_center_on_page(), [
          valued(
            'arrange.centerOnPage',
            'horizontal',
            m.files_office_pptx_horizontally()
          ),
          valued(
            'arrange.centerOnPage',
            'vertical',
            m.files_office_pptx_vertically()
          ),
        ]),
      ],
      label: m.files_office_pptx_menu_arrange(),
    },
  ];
}
