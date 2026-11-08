import {
  Menu01Icon,
  MinusSignIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { html, nothing, render } from 'lit';
import { m } from '@/i18n';
import { hugeIcon } from './boardTools';

type Icon = Parameters<typeof hugeIcon>[0];

export type MenuEntry = {
  disabled?: boolean;
  icon?: Icon;
  label: string;
  run: () => void;
};
/** A row of − and + (and the zoom between them, which resets it). Pressing them keeps
 * the menu open, so a few presses step the zoom. */
export type MenuZoom = {
  in: () => void;
  out: () => void;
  percent?: { reset: () => void; value: () => number };
};

/** The ☰ button and its menu, top right of the board and of an open card (Epo
 * 2026-11-08): everything that isn't a tool lives here, so the bottom row holds only
 * the toolbar. An entry closes it, as does a press anywhere else or Escape. */
export class BoardMenu {
  readonly element = document.createElement('div');
  open = false;
  private readonly content: () => { entries: MenuEntry[]; zoom?: MenuZoom };

  constructor(content: () => { entries: MenuEntry[]; zoom?: MenuZoom }) {
    this.content = content;
    this.element.className = 'capy-menu';
    document.addEventListener('pointerdown', this.away, true);
    this.element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.open) return;
      event.stopPropagation();
      this.set(false);
    });
    this.draw();
  }

  private readonly away = (event: PointerEvent) => {
    if (this.open && !event.composedPath().includes(this.element))
      this.set(false);
  };

  set(open: boolean) {
    this.open = open;
    this.draw();
  }

  /** Again from what it shows: the undo stacks, the zoom. */
  readonly draw = () => {
    const { entries, zoom } = this.content();
    const run = (action: () => void) => () => {
      action();
      this.set(false);
    };
    const step = (action: () => void) => () => {
      action();
      this.draw();
    };
    render(
      html`<button
          aria-expanded=${this.open}
          aria-haspopup="menu"
          aria-label=${m.drawing_board_menu()}
          class="capy-menu-button"
          title=${m.drawing_board_menu()}
          type="button"
          @click=${() => this.set(!this.open)}
        >
          ${hugeIcon(Menu01Icon)}
        </button>
        ${
          this.open
            ? html`<div class="capy-menu-list" role="menu">
                ${entries.map(
                  ({ disabled, icon, label, run: action }) =>
                    html`<button
                      ?disabled=${disabled}
                      role="menuitem"
                      type="button"
                      @click=${run(action)}
                    >
                      ${icon ? hugeIcon(icon) : nothing} ${label}
                    </button>`
                )}
                ${
                  zoom
                    ? html`<div class="capy-menu-zoom">
                        <button
                          aria-label=${m.drawing_board_zoom_out()}
                          title=${m.drawing_board_zoom_out()}
                          type="button"
                          @click=${step(zoom.out)}
                        >
                          ${hugeIcon(MinusSignIcon)}
                        </button>
                        ${
                          zoom.percent
                            ? html`<button
                                aria-label=${m.drawing_board_zoom_reset()}
                                class="capy-menu-percent"
                                title=${m.drawing_board_zoom_reset()}
                                type="button"
                                @click=${step(zoom.percent.reset)}
                              >
                                ${Math.round(zoom.percent.value() * 100)}%
                              </button>`
                            : nothing
                        }
                        <button
                          aria-label=${m.drawing_board_zoom_in()}
                          title=${m.drawing_board_zoom_in()}
                          type="button"
                          @click=${step(zoom.in)}
                        >
                          ${hugeIcon(PlusSignIcon)}
                        </button>
                      </div>`
                    : nothing
                }
              </div>`
            : nothing
        }`,
      this.element
    );
  };

  dispose() {
    document.removeEventListener('pointerdown', this.away, true);
    render(null, this.element);
    this.element.remove();
  }
}
