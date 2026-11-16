import { scrollbarStyle } from '@blocksuite/affine-shared/styles';
import { unsafeCSSVar, unsafeCSSVarV2 } from '@blocksuite/affine-shared/theme';
import { baseTheme } from '@toeverything/theme';
import { css, unsafeCSS } from 'lit';

export const styles = css`
  .overlay-mask {
    pointer-events: auto;
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: var(--affine-z-index-popover);
  }

  .slash-menu {
    position: fixed;
    left: 0;
    top: 0;
    box-sizing: border-box;
    /* Capy (local change 35): the app's menu panel, 240px. */
    padding: 4px;
    width: 240px;
    border: 1px solid ${unsafeCSSVarV2('layer/insideBorder/border')};
    overflow-y: auto;
    /* Capy (local change 35): the app's font. */
    font-family: var(--affine-font-family, ${unsafeCSS(baseTheme.fontSansFamily)});

    background: ${unsafeCSSVarV2('layer/background/overlayPanel')};
    box-shadow: ${unsafeCSSVar('overlayPanelShadow')};
    border-radius: var(--radius-toolbar, 8px);
    z-index: var(--affine-z-index-popover);
    user-select: none;
    /* transition: max-height 0.2s ease-in-out; */
  }

  ${scrollbarStyle('.slash-menu')}

  .slash-menu-group-name {
    box-sizing: border-box;
    padding: 8px 8px 4px;

    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: left;
    color: ${unsafeCSSVarV2('text/tertiary')};
  }

  .slash-menu-item {
    padding: 0 8px;
    justify-content: flex-start;
    gap: 10px;
    border-radius: var(--capy-toolbar-button-radius, 4px);
  }

  .slash-menu-item-icon {
    box-sizing: border-box;
    width: 18px;
    height: 18px;
    color: var(--affine-icon-color);

    display: flex;
    justify-content: center;
    align-items: center;
  }

  .slash-menu-item-shortcut {
    font-size: 12px;
    color: ${unsafeCSSVarV2('text/tertiary')};
  }

  .slash-menu-item-icon svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  .slash-menu-item.ask-ai {
    color: var(--affine-brand-color);
  }
  .slash-menu-item.github .github-icon {
    color: var(--affine-black);
  }
`;

export const slashItemToolTipStyle = css`
  .affine-tooltip {
    display: flex;
    padding: 4px 4px 2px 4px;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
  }

  .tooltip-figure svg {
    display: block;
  }

  .tooltip-caption {
    padding-left: 4px;
    color: var(
      --light-textColor-textSecondaryColor,
      var(--textColor-textSecondaryColor, #8e8d91)
    );
    font-family: var(--affine-font-family);
    font-size: var(--affine-font-xs);
    line-height: var(--affine-line-height);
  }
`;
