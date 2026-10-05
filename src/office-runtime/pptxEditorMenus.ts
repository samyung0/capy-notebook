import {
  PPTX_COMMAND_EDITS,
  type PptxCommandId,
  type PptxCommandState,
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
          ],
          'bold'
        ),
        submenu(
          'align',
          t('toolbar.groups.alignment'),
          [
            toggle('format.alignLeft', t('toolbar.align.left')),
            toggle('format.alignCenter', t('toolbar.align.center')),
            toggle('format.alignRight', t('toolbar.align.right')),
            toggle('format.alignJustify', t('toolbar.align.justify')),
          ],
          'alignLeft'
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
      ],
      label: m.files_office_pptx_menu_arrange(),
    },
  ];
}
