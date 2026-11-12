import { panelBaseStyle } from '@blocksuite/affine-shared/styles';
import { stopPropagation } from '@blocksuite/affine-shared/utils';
import { WithDisposable } from '@blocksuite/global/lit';
import { css, html, LitElement } from 'lit';

export class EditorToolbar extends WithDisposable(LitElement) {
  static override styles = css`
    ${panelBaseStyle(':host')}
    /* Capy (local change 34): the app sets a bar's height, gap and padding. */
    :host {
      height: var(--capy-toolbar-height, 36px);
      gap: var(--capy-toolbar-gap, 8px);
      padding: var(--capy-toolbar-padding, 0 6px);
      box-sizing: content-box;
      /* A bar wider than a phone keeps every control and scrolls sideways. */
      max-width: var(--capy-toolbar-max-width, none);
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
    }

    ::slotted(*) {
      flex-shrink: 0;
    }

    :host([data-without-bg]) {
      border-color: transparent;
      background: transparent;
      box-shadow: none;
    }

    ::slotted(*) {
      display: flex;
      height: 100%;
      justify-content: center;
      align-items: center;
      gap: 8px;
      color: var(--affine-text-primary-color);
      fill: currentColor;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();

    this._disposables.addFromEvent(this, 'pointerdown', (e: PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
    });
    // Capy (local change 32): a pinch or swipe over the buttons reaches the canvas,
    // which zooms or pans it; upstream stopped every wheel here without preventing
    // it, so a pinch zoomed the page. An open menu still keeps its scroll.
    this._disposables.addFromEvent(
      this,
      'wheel',
      (e: WheelEvent) => {
        if (
          e
            .composedPath()
            .some(
              (node) =>
                node instanceof HTMLElement &&
                node.tagName === 'EDITOR-MENU-CONTENT'
            )
        )
          stopPropagation(e);
      },
      { passive: false }
    );
  }

  override render() {
    return html`<slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'editor-toolbar': EditorToolbar;
  }
}
