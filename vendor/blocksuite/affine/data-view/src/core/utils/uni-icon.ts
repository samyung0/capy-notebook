import { ShadowlessElement } from '@blocksuite/std';
import { css, html, type TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';

import { uniMap } from './uni-component/operation.js';
import { createUniComponentFromWebComponent } from './uni-component/uni-component.js';

export class AffineLitIcon extends ShadowlessElement {
  static override styles = css`
    affine-lit-icon {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    affine-lit-icon svg {
      fill: var(--affine-icon-color);
    }
  `;

  protected override render(): unknown {
    return html`${this.icon?.()}`;
  }

  @property({ attribute: false })
  accessor icon!: () => TemplateResult;
}

const litIcon = createUniComponentFromWebComponent<{
  icon: () => TemplateResult;
}>(AffineLitIcon);
// Capy (local change 27): takes the icon itself, not its name. A lookup by name kept
// every icon in the build (about 137 KB gzipped), wherever the icons are loaded.
export const createIcon = (icon: () => TemplateResult) => {
  return uniMap(litIcon, () => ({ icon }));
};
