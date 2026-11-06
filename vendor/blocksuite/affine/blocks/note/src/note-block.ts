import type { NoteBlockModel } from '@blocksuite/affine-model';
import { BlockComponent } from '@blocksuite/std';
import type { BlockModel } from '@blocksuite/store';
import { css, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

/* Capy (local change 8): the note's blocks render in chunks of about
 * `CHUNK`, one `.affine-note-chunk` element each, which the app makes
 * `content-visibility: auto` (as Plate's `data-slate-chunk`): per block,
 * Chrome checked every block's visibility and hit-tested past each of them
 * on every scrolled frame. A block starts a chunk when its id hashes to one,
 * so an inserted or removed block moves no other block between chunks (a
 * moved block is rendered anew), unless it starts or ends one. */
const CHUNK = 32;
const CHUNK_MAX = 2 * CHUNK;

function startsChunk(id: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1)
    hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return (hash >>> 0) % CHUNK === 0;
}

function chunks(children: BlockModel[]) {
  const result: BlockModel[][] = [];
  let current: BlockModel[] = [];
  for (const child of children) {
    if (
      current.length &&
      (current.length >= CHUNK_MAX || startsChunk(child.id))
    ) {
      result.push(current);
      current = [];
    }
    current.push(child);
  }
  if (current.length) result.push(current);
  return result;
}

export class NoteBlockComponent extends BlockComponent<NoteBlockModel> {
  static override styles = css`
    .affine-note-block-container {
      display: flow-root;
    }
    .affine-note-block-container.selected {
      background-color: var(--affine-hover-color);
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
  }

  override renderBlock() {
    return html`
      <div class="affine-note-block-container">
        <div class="affine-block-children-container">
          ${repeat(
            chunks(this.model.children),
            chunk => chunk[0].id,
            chunk =>
              html`<div class="affine-note-chunk">${this.host.renderModels(
                chunk
              )}</div>`
          )}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'affine-note': NoteBlockComponent;
  }
}
