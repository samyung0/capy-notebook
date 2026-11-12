import { TextBackgroundDuotoneIcon } from '@blocksuite/icons/lit';
import { css, LitElement } from 'lit';

export class TextDuotoneIcon extends LitElement {
  static override styles = css`
    svg {
      display: flex;
      /* Capy (local change 34): the bar's icon size. */
      font-size: var(--capy-toolbar-icon-size, 20px);
    }
    svg > path:nth-child(1) {
      fill: var(--background, unset);
    }
    svg > path:nth-child(3) {
      fill: var(--color, unset);
    }
  `;
  override render() {
    return TextBackgroundDuotoneIcon();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-text-duotone-icon': TextDuotoneIcon;
  }
}
