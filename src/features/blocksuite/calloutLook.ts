import { setCalloutVariantIcon } from '@blocksuite/affine/blocks/callout';
import { CalloutBlockModel } from '@blocksuite/affine/model';
import {
  type ToolbarContext,
  ToolbarModuleExtension,
} from '@blocksuite/affine/shared/services';
import { BlockFlavourIdentifier } from '@blocksuite/affine/std';
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from '@hugeicons/core-free-icons';
import { html } from 'lit';
import { AiIcon } from '@/components/ui/Icon';
import {
  CALLOUT_VARIANTS,
  type CalloutVariant,
  normalizeCalloutVariant,
} from '@/features/notes/richBlockConfig';
import { hugeIcon } from './chromeIcons';

/* A note's callout keeps the app's own look (Epo 2026-11-10): the five kinds the
   Plate note and the chat share (richBlockConfig.ts), each with its tint, border
   and icon. The kind is the block's `variant`; BlockSuite's emoji and background
   colours are not used. Styles: pageEditor.css. */

const ICON: Record<CalloutVariant, unknown> = {
  danger: Alert02Icon,
  info: InformationCircleIcon,
  success: CheckmarkCircle02Icon,
  tip: AiIcon,
  warning: Alert02Icon,
};

const icon = (variant: unknown) =>
  html`${hugeIcon(ICON[normalizeCalloutVariant(variant)])}`;

setCalloutVariantIcon(icon);

/** A selected callout's bar: its kind in place of BlockSuite's background and
 * emoji pickers, beside Delete. */
export const calloutBar = ToolbarModuleExtension({
  config: {
    actions: [
      { id: 'style', when: false },
      { id: 'icon', when: false },
      {
        content(ctx: ToolbarContext) {
          const model = ctx.getCurrentModelByType(CalloutBlockModel);
          if (!model) return null;
          const props = model.props as { variant?: string };
          const current = normalizeCalloutVariant(props.variant);
          const label = CALLOUT_VARIANTS.find(
            ({ value }) => value === current
          )?.label;
          return html`<editor-menu-button
            .contentPadding=${'4px'}
            .button=${html`<editor-icon-button
              aria-label=${label}
              .tooltip=${label}
            >
              ${icon(current)}<span class="label">${label}</span>
            </editor-icon-button>`}
          >
            <div data-size="small" data-orientation="vertical">
              ${CALLOUT_VARIANTS.map(
                ({ label: name, value }) =>
                  html`<editor-menu-action
                    aria-label=${name}
                    ?data-selected=${value === current}
                    @click=${() => {
                      ctx.store.captureSync();
                      ctx.store.updateBlock(model, { variant: value });
                    }}
                  >
                    ${icon(value)}<span class="label">${name}</span>
                  </editor-menu-action>`
              )}
            </div>
          </editor-menu-button>`;
        },
        id: 'a.variant',
      },
    ],
  },
  id: BlockFlavourIdentifier('custom:affine:callout'),
});
