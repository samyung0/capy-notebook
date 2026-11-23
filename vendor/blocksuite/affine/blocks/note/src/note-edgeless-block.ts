import { EdgelessLegacySlotIdentifier } from '@blocksuite/affine-block-surface';
import type { DocTitle } from '@blocksuite/affine-fragment-doc-title';
import {
  DEFAULT_NOTE_WIDTH,
  isInlineNote,
  NoteBlockSchema,
  NoteDisplayMode,
} from '@blocksuite/affine-model';
import { focusTextModel } from '@blocksuite/affine-rich-text';
import { TelemetryProvider } from '@blocksuite/affine-shared/services';
import { handleNativeRangeAtPoint } from '@blocksuite/affine-shared/utils';
import { Bound } from '@blocksuite/global/gfx';
import { toGfxBlockComponent } from '@blocksuite/std';
import {
  type BoxSelectionContext,
  GfxViewInteractionExtension,
} from '@blocksuite/std/gfx';
import { html, nothing, type PropertyValues } from 'lit';
import { query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import clamp from 'lodash-es/clamp';

import { NoteBlockComponent } from './note-block';
import {
  measureNoteSize,
  noteGestureEnds,
  noteGestureStarts,
  saveNoteSize,
} from './note-size';
import * as styles from './note-styles';

export const AFFINE_EDGELESS_NOTE = 'affine-edgeless-note';

// Capy (local change 55; Epo 2026-11-13): a note has no fold. It is always as
// tall as its text: no custom height (`edgeless.collapse`), no pale strip of the
// hidden part on hover and no fold arrow, and the hover and resize tracking that
// only fed them is gone.
export class EdgelessNoteBlockComponent extends toGfxBlockComponent(
  NoteBlockComponent
) {
  private _handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowUp') {
      this._docTitle?.inlineEditor?.focusEnd();
    }
  }

  override connectedCallback(): void {
    super.connectedCallback();

    const selection = this.gfx.selection;

    this._editing = selection.has(this.model.id) && selection.editing;
    this._disposables.add(
      selection.slots.updated.subscribe(() => {
        if (selection.has(this.model.id) && selection.editing) {
          this._editing = true;
        } else {
          // Capy (local change 75): the size waiting on a pause is saved.
          if (this._editing) saveNoteSize(this.model);
          this._editing = false;
        }
      })
    );

    this.disposables.addFromEvent(this, 'keydown', this._handleKeyDown);
  }

  override disconnectedCallback(): void {
    // Capy (local change 75): the size waiting on a pause is saved.
    saveNoteSize(this.model);
    super.disconnectedCallback();
  }

  // Capy (local change 75): a drag starts from the size shown, which its
  // tracked pop writes with the move.
  override onDragStart() {
    noteGestureStarts(this.model);
    super.onDragStart();
  }

  override onDragEnd() {
    super.onDragEnd();
    noteGestureEnds(this.model);
  }

  get edgelessSlots() {
    return this.std.get(EdgelessLegacySlotIdentifier);
  }

  override firstUpdated() {
    const { _disposables } = this;

    // Capy (local change 53): an inline note is as wide as its text (up to a
    // card's width, where it wraps), so its frame hugs it as a text box does.
    // Capy (local change 75): saved as its height is (measured while
    // read-only too); a card drops a waiting width.
    const sizer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width) measureNoteSize(this.model, 'w', width, this._editing);
    });
    sizer.observe(this);
    _disposables.add(() => sizer.disconnect());
  }

  override updated(changedProperties: PropertyValues) {
    if (changedProperties.has('_editing') && this._editing) {
      this.std.getOptional(TelemetryProvider)?.track('EdgelessNoteEditing', {
        page: 'edgeless',
        segment: this.model.isPageBlock() ? 'page' : 'note',
      });
    }
  }

  override getCSSScaleVal(): number {
    const baseScale = super.getCSSScaleVal();
    const extraScale = this.model.props.edgeless?.scale ?? 1;
    return baseScale * extraScale;
  }

  override getRenderingRect() {
    const { xywh, edgeless } = this.model.props;
    const { scale = 1 } = edgeless;

    const bound = Bound.deserialize(xywh);
    const width = bound.w / scale;

    // Capy (local change 53): an inline note sizes to its text.
    const inline = isInlineNote(this.model.props);
    return {
      x: bound.x,
      y: bound.y,
      w: inline ? 'max-content' : width,
      h: 'unset',
      zIndex: this.toZIndex(),
    };
  }

  override renderGfxBlock() {
    const { model } = this;
    // Capy (local change 53): an inline note's text wraps at a card's width.
    this.style.maxWidth = isInlineNote(model.props)
      ? `${DEFAULT_NOTE_WIDTH}px`
      : '';
    const { displayMode } = model.props;
    if (!!displayMode && displayMode === NoteDisplayMode.DocOnly)
      return nothing;

    const { xywh, edgeless } = model.props;
    const { borderRadius } = edgeless.style;
    const { scale = 1 } = edgeless;

    const bound = Bound.deserialize(xywh);

    // Capy (local change 56): turned about its middle.
    const style = {
      borderRadius: borderRadius + 'px',
      transform: model.rotate ? `rotate(${model.rotate}deg)` : undefined,
      transformOrigin: 'center',
    };

    return html`
      <div
        class=${styles.edgelessNoteContainer}
        style=${styleMap(style)}
        data-model-height="${bound.h}"
        data-editing=${this._editing}
        data-inline=${isInlineNote(model.props) /* Capy (local change 52) */}
        data-testid="edgeless-note-container"
        data-scale="${scale}"
      >
        <edgeless-note-background
          .editing=${this._editing}
          .note=${this.model}
        ></edgeless-note-background>

        <div
          data-testid="edgeless-note-clip-container"
          class=${styles.clipContainer}
          style=${styleMap({ 'overflow-y': 'clip' })}
        >
          <div>
            <edgeless-page-block-title
              .note=${this.model}
            ></edgeless-page-block-title>
            <div
              contenteditable=${String(!this.store.readonly$.value)}
              class="edgeless-note-page-content"
            >
              ${this.renderPageContent()}
            </div>
          </div>
        </div>

        <edgeless-note-mask
          .model=${this.model}
          .host=${this.host}
          .zoom=${this.gfx.viewport.zoom ?? 1}
          .disableMask=${this.hideMask}
          .editing=${this._editing}
        ></edgeless-note-mask>
      </div>
    `;
  }

  override onBoxSelected(_: BoxSelectionContext) {
    return this.model.props.displayMode !== NoteDisplayMode.DocOnly;
  }

  @state()
  private accessor _editing = false;

  @state()
  accessor hideMask = false;

  @query('doc-title')
  private accessor _docTitle: DocTitle | null = null;
}

declare global {
  interface HTMLElementTagNameMap {
    [AFFINE_EDGELESS_NOTE]: EdgelessNoteBlockComponent;
  }
}

export const EdgelessNoteInteraction =
  GfxViewInteractionExtension<EdgelessNoteBlockComponent>(
    NoteBlockSchema.model.flavour,
    {
      // Capy (local change 56): a note turns by the frame's knob, as text does;
      // AFFiNE's notes did not turn.
      // Capy (local change 55): a card is resized by its sides, which set its
      // width (its text rewraps, its height follows), or its corners, which
      // scale it; an inline note by its corners only (local change 53). AFFiNE
      // kept a card 218 wide at least, and its top and bottom set a custom
      // height.
      resizeConstraint: {
        allowedHandlers: [
          'top-left',
          'top-right',
          'bottom-left',
          'bottom-right',
          'left',
          'right',
        ],
        lockRatio: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
        minWidth: 40,
        minHeight: 1,
      },
      handleResize: ({ model }) => {
        const initialScale: number = model.props.edgeless.scale ?? 1;
        const inline = isInlineNote(model.props);
        return {
          beforeResize(context): void {
            if (!inline) return;
            context.set({
              allowedHandlers: [
                'top-left',
                'top-right',
                'bottom-left',
                'bottom-right',
              ],
              minWidth: 1,
            });
          },
          onResizeStart(context): void {
            // Capy (local change 75): from the size shown.
            noteGestureStarts(model);
            context.default(context);
            model.stash('edgeless');
          },

          onResizeMove(context): void {
            const { handle, originalBound, newBound, lockRatio, constraint } =
              context;
            if (lockRatio) {
              const scale = (newBound.w / originalBound.w) * initialScale;
              model.props.edgeless = { ...model.props.edgeless, scale };
              model.props.xywh = newBound.serialize();
              return;
            }
            // A side: the width alone, the height left to the text. The other
            // side's middle stays where it is, along the note's turn too
            // (local change 56).
            const bound = Bound.deserialize(model.xywh);
            const w = clamp(
              newBound.w,
              constraint.minWidth * initialScale,
              constraint.maxWidth
            );
            const radians = (model.rotate * Math.PI) / 180;
            const shift =
              ((handle === 'left' ? -1 : 1) * (w - originalBound.w)) / 2;
            const centerX = originalBound.center[0] + shift * Math.cos(radians);
            const centerY =
              originalBound.y + bound.h / 2 + shift * Math.sin(radians);
            bound.w = w;
            bound.x = centerX - w / 2;
            bound.y = centerY - bound.h / 2;
            model.props.xywh = bound.serialize();
          },

          onResizeEnd(context): void {
            context.default(context);
            model.pop('edgeless');
            noteGestureEnds(model);
          },
        };
      },
      // Capy (local change 75): a turn starts from the size shown.
      handleRotate: ({ model }) => ({
        onRotateStart(context): void {
          noteGestureStarts(model);
          context.default(context);
        },
        onRotateEnd(context): void {
          context.default(context);
          noteGestureEnds(model);
        },
      }),
      handleSelection: ({ std, gfx, view, model }) => {
        return {
          onSelect(context) {
            const { selected, multiSelect, event: e } = context;
            const { editing } = gfx.selection;
            const alreadySelected = gfx.selection.has(model.id);

            if (!multiSelect && selected && (alreadySelected || editing)) {
              if (model.isLocked()) return;

              if (alreadySelected && editing) {
                return;
              }

              gfx.selection.set({
                elements: [model.id],
                editing: true,
              });

              view.updateComplete
                .then(() => {
                  if (!view.isConnected) {
                    return;
                  }

                  let isClickOnTitle = false;
                  const titleRect = view
                    .querySelector('edgeless-page-block-title')
                    ?.getBoundingClientRect();

                  if (titleRect) {
                    const titleBound = new Bound(
                      titleRect.x,
                      titleRect.y,
                      titleRect.width,
                      titleRect.height
                    );
                    if (titleBound.isPointInBound([e.clientX, e.clientY])) {
                      isClickOnTitle = true;
                    }
                  }

                  if (isClickOnTitle) {
                    handleNativeRangeAtPoint(e.clientX, e.clientY);
                    return;
                  }

                  if (model.children.length === 0) {
                    const blockId = std.store.addBlock(
                      'affine:paragraph',
                      { type: 'text' },
                      model.id
                    );

                    if (blockId) {
                      focusTextModel(std, blockId);
                    }
                  } else {
                    const rect = view
                      .querySelector('.affine-block-children-container')
                      ?.getBoundingClientRect();

                    if (rect) {
                      const offsetY = 8 * gfx.viewport.zoom;
                      const offsetX = 2 * gfx.viewport.zoom;
                      const x = clamp(
                        e.clientX,
                        rect.left + offsetX,
                        rect.right - offsetX
                      );
                      const y = clamp(
                        e.clientY,
                        rect.top + offsetY,
                        rect.bottom - offsetY
                      );
                      handleNativeRangeAtPoint(x, y);
                    } else {
                      handleNativeRangeAtPoint(e.clientX, e.clientY);
                    }
                  }
                })
                .catch(console.error);
            } else if (multiSelect && alreadySelected && editing) {
              // range selection using Shift-click when editing
              return;
            } else {
              context.default(context);
            }
          },
        };
      },
    }
  );
