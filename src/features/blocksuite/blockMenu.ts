import { updateBlockType } from '@blocksuite/affine/blocks/note';
import {
  menu,
  popMenu,
  sideSubMenuMiddleware,
} from '@blocksuite/affine/components/context-menu';
import { textConversionConfigs } from '@blocksuite/affine/rich-text';
import {
  copySelectedModelsCommand,
  deleteSelectedModelsCommand,
  draftSelectedModelsCommand,
  duplicateSelectedModelsCommand,
  getSelectedModelsCommand,
} from '@blocksuite/affine/shared/commands';
import { tr } from '@blocksuite/affine/shared/utils';
import type { BlockComponent, BlockStdScope } from '@blocksuite/affine/std';
import {
  Copy01Icon,
  Copy02Icon,
  Delete02Icon,
  RepeatIcon,
} from '@hugeicons/core-free-icons';
import { html } from 'lit';
import { m } from '@/i18n';
import { hugeIcon } from './chromeIcons';

/** What the grip's click reports (vendor README local change 36). */
type BlockMenuEvent = CustomEvent<{ block: BlockComponent; grip: HTMLElement }>;

/** Blocks with a bar of their own for the whole block (a table's, a callout's, an
 * image's): the grip only selects them, and that bar shows. */
const OWN_BAR = new Set(['affine:table', 'affine:callout', 'affine:image']);

/** A text block's kinds, as the text bar's own Turn into lists them. */
const KINDS = textConversionConfigs.filter(
  ({ flavour }) => flavour !== 'affine:divider'
);

/**
 * The note's block menu (Epo 2026-11-10, mock H1): a click on a block's grip
 * selects the block and opens this vertical menu beside it, with what applies
 * to a whole block. The floating bar stays away while it is open, and closing
 * it lets the block go, so no bar is left over a block nobody is editing.
 * Returns its removal.
 */
export function blockMenu(host: HTMLElement, std: BlockStdScope) {
  const open = (event: Event) => {
    const { block, grip } = (event as BlockMenuEvent).detail;
    if (std.store.readonly || OWN_BAR.has(block.model.flavour)) return;
    const chain = () => std.command.chain();
    const selected = () => chain().pipe(getSelectedModelsCommand);
    host.setAttribute('data-block-menu', '');
    // The grip hides once its block is selected, so the menu is placed against
    // where it was beside the block, and follows the block as the note scrolls.
    const at = grip.getBoundingClientRect();
    const from = block.getBoundingClientRect();
    popMenu(
      {
        popupStart: () => () => {},
        root: document.body,
        targetRect: {
          getBoundingClientRect: () => {
            const now = block.getBoundingClientRect();
            return new DOMRect(
              at.x + now.x - from.x,
              at.y + now.y - from.y,
              at.width,
              at.height
            );
          },
        },
      },
      {
        options: {
          items: [
            ...(block.model.text
              ? [
                  menu.subMenu({
                    middleware: sideSubMenuMiddleware,
                    name: m.editor_turn_into(),
                    options: {
                      items: KINDS.map(({ flavour, icon, name, type }) =>
                        menu.action({
                          isSelected:
                            block.model.flavour === flavour &&
                            (!type ||
                              (block.model.props as { type?: string }).type ===
                                type),
                          name: tr(name),
                          prefix: html`${icon}`,
                          select: () => {
                            chain()
                              .pipe(updateBlockType, {
                                flavour,
                                ...(type && { props: { type } }),
                              })
                              .run();
                          },
                        })
                      ),
                    },
                    prefix: html`${hugeIcon(RepeatIcon)}`,
                  }),
                ]
              : []),
            menu.action({
              name: m.action_copy(),
              prefix: html`${hugeIcon(Copy01Icon)}`,
              select: () => {
                selected()
                  .pipe(draftSelectedModelsCommand)
                  .pipe(copySelectedModelsCommand)
                  .run();
              },
            }),
            menu.action({
              name: m.editor_duplicate(),
              prefix: html`${hugeIcon(Copy02Icon)}`,
              select: () => {
                std.store.captureSync();
                chain()
                  .pipe(getSelectedModelsCommand, {
                    mode: 'highest',
                    types: ['block', 'image'],
                  })
                  .pipe(duplicateSelectedModelsCommand)
                  .run();
              },
            }),
            menu.action({
              class: { 'delete-item': true },
              name: m.action_delete(),
              prefix: html`${hugeIcon(Delete02Icon)}`,
              select: () => {
                selected().pipe(deleteSelectedModelsCommand).run();
              },
            }),
          ],
          onClose: () => {
            host.removeAttribute('data-block-menu');
            std.selection.clear(['block']);
          },
        },
        placement: 'bottom-start',
      }
    );
  };
  host.addEventListener('capy-block-menu', open);
  return () => host.removeEventListener('capy-block-menu', open);
}
