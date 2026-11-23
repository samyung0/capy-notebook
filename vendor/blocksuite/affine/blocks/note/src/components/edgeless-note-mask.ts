import type { NoteBlockModel } from '@blocksuite/affine-model';
import { SignalWatcher, WithDisposable } from '@blocksuite/global/lit';
import { type EditorHost, ShadowlessElement } from '@blocksuite/std';
import { html } from 'lit';
import { property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

import { measureNoteSize } from '../note-size';
import { ACTIVE_NOTE_EXTRA_PADDING } from '../note-styles';

export class EdgelessNoteMask extends SignalWatcher(
  WithDisposable(ShadowlessElement)
) {
  protected override firstUpdated() {
    const maskDOM = this.renderRoot!.querySelector('.affine-note-mask');
    // Capy (local change 75): measured while read-only too, so an unlocked
    // board has the text's last height.
    const observer = new ResizeObserver(entries => {
      // Capy (local change 55): always the text's height; a note has no fold.
      for (const entry of entries) {
        // Capy (local change 53): less the 20 px the mask reaches past the
        // note on each side while it is edited, which AFFiNE stored as height.
        const extra = this.editing ? ACTIVE_NOTE_EXTRA_PADDING : 0;
        const height = entry.contentRect.height - 2 * extra;
        if (!height) return;
        // Capy (local change 75): the editing tab saves it once typing
        // pauses, the others only after 3 s of differing.
        measureNoteSize(this.model, 'h', height, this.editing);
      }
    });

    observer.observe(maskDOM!);

    this._disposables.add(() => {
      observer.disconnect();
    });
  }

  override render() {
    const extra = this.editing ? ACTIVE_NOTE_EXTRA_PADDING : 0;
    return html`
      <div
        class="affine-note-mask"
        style=${styleMap({
          position: 'absolute',
          top: `${-extra}px`,
          left: `${-extra}px`,
          bottom: `${-extra}px`,
          right: `${-extra}px`,
          zIndex: '1',
          pointerEvents: this.editing || this.disableMask ? 'none' : 'auto',
          borderRadius: `${
            this.model.props.edgeless.style.borderRadius * this.zoom
          }px`,
        })}
      ></div>
    `;
  }

  @property({ attribute: false })
  accessor disableMask!: boolean;

  @property({ attribute: false })
  accessor editing!: boolean;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor model!: NoteBlockModel;

  @property({ attribute: false })
  accessor zoom!: number;
}

declare global {
  interface HTMLElementTagNameMap {
    'edgeless-note-mask': EdgelessNoteMask;
  }
}
