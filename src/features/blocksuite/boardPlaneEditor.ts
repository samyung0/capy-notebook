import { ThemeProvider } from '@blocksuite/affine/shared/services';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import {
  AlertCircleIcon,
  Delete02Icon,
  LeftToRightListBulletIcon,
  MoreVerticalIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons';
import { html, render } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import type { MathfieldElement } from 'mathlive';
import { attachGestures } from '@/features/graph/gestures';
import type { GraphElement, Vec } from '@/features/graph/model';
import { graphTools, kindOf, toolsFor } from '@/features/graph/tools';
import { PLANE_ZOOM, zoomedAt } from '@/features/graph/view';
import {
  buildElements,
  COMMAND_SHORTCUTS,
  type GraphRow,
  markRow,
  parsedKind,
  readRow,
  reconcileRows,
  rowsAfterEdit,
  rowsFromElements,
  typedLine,
} from '@/features/questions/graphSyntax';
import mathFieldStyles from '@/features/questions/mathField.css?inline';
import { getLocale, m } from '@/i18n';
import { sameJson } from '@/lib/sameJson';
import { ELEMENTS_MAX, LABEL_SIZE, PAPER, PLANE_LABEL_MAX } from './boardData';
import { openBoardEditor, toolTip } from './boardEditorShell';
import { EraserTrail } from './boardEraser';
import { openFormulaCard, symbolButtons } from './boardFormula';
import {
  drawPlane,
  fitCard,
  markPoints,
  type PlaneElementModel,
  type PlaneView,
  setPlaneEditor,
  viewOfPlane,
} from './boardPlane';
import { boardKindOf, hugeIcon, mathsIcon } from './boardTools';

/** Fit's least span, in units, across and up (Epo 2026-11-13). */
const FIT_SPAN = 10;
/** How far from the origin the view goes, in the plane's units. */
const VIEW_MAX = 1e9;

/** The objects list's open or closed, as last chosen this session; until then open
 * on a wide screen and closed on a phone (Epo 2026-11-13, L2). */
let listChoice: boolean | null = null;
/** Under this width the list is a sheet over the plane's lower half. */
const SHEET_BELOW = 640;

/** The endless plane, filling the board for editing. Everything plotted is written at
 * once, so undo steps through it click by click; the view is written on leaving. Escape
 * ends the open mark, or leaves as Done does when there's none. Its tools are every
 * graph editor's (graph/tools.ts) and its list's rows the graph dialog's
 * (questions/graphSyntax.ts), so it takes every row the dialog takes (Epo 2026-11-16). */
function openPlaneEditor(gfx: GfxController, model: PlaneElementModel) {
  const theme = gfx.std.get(ThemeProvider);
  let frame = 0;
  /** The menu's zoom counts from the card's scale on the canvas as 100% (Epo 2026-11-09). */
  const cardPpu = model.ppu;

  /** The objects list's rows, following the plane's elements but for the rows typed
   * and not written yet (`drafts`): a row is written when Enter or leaving it says
   * so, one undo step, and drawn meanwhile. A row a change leaves unable to draw (a
   * point it names went) keeps its text and error, unwritten. */
  let rows: GraphRow[] = rowsFromElements(model.elementList);
  let built = buildElements(rows);
  let seen = model.elementList;
  const drafts = new Set<string>();
  /** The empty row at the end of the list, where a new row is typed. */
  let newKey = crypto.randomUUID();
  /** Why the plane took nothing more, under the new row's icon. */
  let fullError: string | null = null;
  /** The row whose ⋮ menu is open, and how far down the list it sits. */
  let menuFor: { id: string; top: number } | null = null;
  /** The row to focus once the list has drawn it (a label just added). */
  let focusRow: string | null = null;
  const fields = new Map<string, MathfieldElement>();
  let Mathfield: typeof MathfieldElement | null = null;

  /** The rows' elements while one is typed or broken, else the plane's own. */
  const drawn = (): GraphElement[] =>
    drafts.size ? built.elements : model.elementList;
  /** Rows follow the plane's elements: an undo, a redo, Clear all. */
  const follow = () => {
    const list = model.elementList;
    if (list === seen) return;
    seen = list;
    const next = reconcileRows(
      rows,
      list,
      new Map(built.elements.map((element) => [element.id, element])),
      (key) => drafts.has(key)
    );
    if (next === rows) return;
    rows = next;
    built = buildElements(rows);
  };
  /** The plane holds what `next` rows give, as one undo step; stored elements that
   * didn't change stay the same objects, so only what changed is written. */
  const writeRows = (next: GraphRow[]) => {
    const before = built;
    rows = next;
    built = buildElements(rows);
    drafts.clear();
    for (const row of rows)
      if (built.errors.has(row.key) && row.kind === 'expression')
        drafts.add(row.key);
    fullError = null;
    const stored = new Map(model.elementList.map((each) => [each.id, each]));
    const list = built.elements.map((element) => {
      const old = stored.get(element.id);
      return old && sameJson(old, element) ? old : element;
    });
    if (
      list.length !== model.elementList.length ||
      list.some((element, i) => element !== model.elementList[i])
    )
      shell?.write(() => model.writeList(list));
    seen = model.elementList;
    if (before.elements !== built.elements) redraw();
    drawControls();
  };

  const shell = openBoardEditor(gfx, model.id, {
    clear: {
      empty: () => !model.elementList.length,
      run: () => {
        tools.clear();
        menuFor = null;
        writeRows([]);
        redraw();
      },
    },
    fit: () => fitMarks(),
    onDelete: () => tools.deleteSelected(),
    onEscape: () => {
      if (menuFor) {
        menuFor = null;
        drawControls();
        return true;
      }
      // A row being typed in lets go first, back as it was.
      const field = document.activeElement;
      const row = field?.closest<HTMLElement>('.capy-plane-list [data-row]');
      if (
        row?.dataset.row &&
        (field instanceof HTMLInputElement || field?.localName === 'math-field')
      ) {
        discardRow(row.dataset.row);
        (field as HTMLElement).blur();
        return true;
      }
      return tools.escape();
    },
    onLeave: () => {
      if (drafts.size) writeRows(rows);
      tools.leave();
      detachGestures();
      detachTools();
      const { height, width } = box();
      const [x, y] = [
        view.x0 + width / 2 / view.ppu,
        view.y0 - height / 2 / view.ppu,
      ];
      const [, , w, h] = model.deserializedXYWH;
      // The view is where the student looks, not part of the undo history.
      gfx.doc.withoutTransact(() => {
        model.ppu = view.ppu;
        model.x0 = x - w / 2 / view.ppu;
        model.y0 = y + h / 2 / view.ppu;
      });
      if (model.fit) fitCard(model);
      cancelAnimationFrame(frame);
    },
    onShortcut: (key) => tools.shortcut(key),
    onUpdate: () => {
      follow();
      drawControls();
      redraw();
    },
    zoom: {
      in: () => zoomCentre(1.5),
      out: () => zoomCentre(1 / 1.5),
      percent: {
        reset: () => zoomCentre(cardPpu / view.ppu),
        value: () => view.ppu / cardPpu,
      },
    },
  });
  if (!shell) return;
  const { box, canvas, controls, ctx, root } = shell;

  const [, , cardW, cardH] = model.deserializedXYWH;
  const start = box();
  const centre: Vec = [
    model.x0 + cardW / 2 / model.ppu,
    model.y0 - cardH / 2 / model.ppu,
  ];
  const view: PlaneView = {
    polar: model.polar,
    ppu: model.ppu,
    x0: centre[0] - start.width / 2 / model.ppu,
    y0: centre[1] + start.height / 2 / model.ppu,
  };
  const workspace = boardKindOf(gfx.std) === 'workspace';
  /** Where the plane was last drawn, in pixels on this canvas. */
  const sheet = { h: 0, w: 0, x: 0, y: 0 };
  const labelField = () =>
    controls.querySelector<HTMLInputElement>('.capy-chart-label');

  const tools = graphTools({
    accent: () =>
      getComputedStyle(canvas).getPropertyValue('--affine-primary-color'),
    canvas,
    changed: () => drawControls(),
    ctx,
    dark: () => theme.theme === 'dark',
    elements: drawn,
    formula: (near, _at, done) =>
      void openFormulaCard(gfx, near?.latex ?? '', (latex) => done(latex)),
    full: () => rows.length >= ELEMENTS_MAX,
    labelText: () => labelField()?.value ?? null,
    local: (event) => {
      const rect = box();
      return [event.clientX - rect.left, event.clientY - rect.top];
    },
    polar: () => Boolean(view.polar),
    redraw: () => redraw(),
    refused: () => {
      fullError = m.drawing_board_plane_full();
      drawControls();
    },
    size: () => sheet,
    trail: new EraserTrail(() => redraw()),
    view: () => viewOfPlane(view),
    write: (next) => writeRows(rowsAfterEdit(rows, drawn(), next)),
  });

  const draw = () => {
    const { height, width } = shell.sizeCanvas();
    const paper = PAPER[theme.theme];
    sheet.h = height;
    sheet.w = width;
    drawPlane(ctx, sheet, view, tools.shown(), paper, redraw);
    tools.drawOverlay(paper.ink);
  };
  const redraw = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  /** The view stays within VIEW_MAX of the origin. */
  const hold = () => {
    view.x0 = Math.max(-VIEW_MAX, Math.min(VIEW_MAX, view.x0));
    view.y0 = Math.max(-VIEW_MAX, Math.min(VIEW_MAX, view.y0));
  };
  /** Zoomed about a pixel, within the plane's range (`PLANE_ZOOM`). */
  const zoomAt = (factor: number, at: Vec) => {
    const next = zoomedAt(viewOfPlane(view), factor, at, PLANE_ZOOM);
    view.ppu = next.ppuX;
    view.x0 = next.left;
    view.y0 = next.top;
    hold();
  };
  const zoomCentre = (factor: number) => {
    const { height, width } = box();
    zoomAt(factor, [width / 2, height / 2]);
    redraw();
  };
  /** A gesture's move, gathered once a frame, is drawn in that same frame. */
  let moving = false;
  const drawMoved = () => {
    if (moving) return;
    moving = true;
    queueMicrotask(() => {
      moving = false;
      cancelAnimationFrame(frame);
      frame = 0;
      draw();
    });
  };
  const fitMarks = () => {
    const seen = markPoints(model.elementList);
    const xs = seen.map(([x]) => x);
    const ys = seen.map(([, y]) => y);
    const { height, width } = box();
    const [x0, x1, y0, y1] = [
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...ys),
      Math.max(...ys),
    ];
    // At least FIT_SPAN units each way, so a plane with nothing (or one point near
    // the origin) shows a stretch of grid rather than one unit across the screen.
    view.ppu = Math.max(
      PLANE_ZOOM.min,
      Math.min(
        PLANE_ZOOM.max,
        (width - 100) / Math.max(x1 - x0, FIT_SPAN),
        (height - 160) / Math.max(y1 - y0, FIT_SPAN)
      )
    );
    view.x0 = (x0 + x1) / 2 - width / 2 / view.ppu;
    view.y0 = (y0 + y1) / 2 + height / 2 / view.ppu;
    hold();
    redraw();
  };

  // The wheel pans, pinch and Ctrl/⌘-wheel zoom about the pointer, the middle button
  // and two fingers pan: the engine's gestures, as every graph has them.
  const detachGestures = attachGestures(canvas, {
    pan: (dx, dy) => {
      view.x0 -= dx / view.ppu;
      view.y0 += dy / view.ppu;
      hold();
      drawMoved();
    },
    settle: () => undefined,
    zoom: (factor, at) => {
      zoomAt(factor, at);
      drawMoved();
    },
  });
  const detachTools = tools.attach();

  // The objects list (Epo 2026-11-13, L2): a floating card of the plane's marks over
  // its top left, a sheet over its lower half on a phone. Workspace canvases only.
  const listOpen = () =>
    workspace && (listChoice ?? box().width >= SHEET_BELOW);
  const listLayout = () =>
    listOpen() ? (box().width < SHEET_BELOW ? 'sheet' : 'floating') : '';
  const toggleList = () => {
    listChoice = !listOpen();
    menuFor = null;
    drawControls();
  };
  /** A row typed into, as the graph dialog reads it: drawn at once, written when
   * Enter or leaving the row says so. The empty row becomes a row of its own. */
  const typedRow = (key: string, latex: string, ascii: string) => {
    const read = readRow(latex, ascii);
    if (rows.some((row) => row.key === key))
      rows = rows.map((row) =>
        row.key === key && row.kind === 'expression'
          ? { ...row, latex, ...read }
          : row
      );
    else {
      if (!latex.trim()) return;
      if (rows.length >= ELEMENTS_MAX) {
        fullError = m.drawing_board_plane_full();
        drawControls();
        return;
      }
      rows = [...rows, { key, kind: 'expression', latex, style: {}, ...read }];
      newKey = crypto.randomUUID();
    }
    built = buildElements(rows);
    drafts.add(key);
    drawControls();
    redraw();
  };
  /** Writes what a typed row holds; an emptied row goes. A row that can't be read
   * keeps its text and error. */
  const commitRow = (key: string) => {
    const field = fields.get(key);
    if (!drafts.has(key) && field?.value.trim()) return;
    writeRows(
      field && !field.value.trim()
        ? rows.filter((row) => row.key !== key)
        : rows
    );
  };
  /** A row as it was before typing (Escape). */
  const discardRow = (key: string) => {
    drafts.delete(key);
    seen = [];
    follow();
    const field = fields.get(key);
    const row = rows.find((each) => each.key === key);
    if (field)
      field.setValue(row?.kind === 'expression' ? row.latex : '', {
        silenceNotifications: true,
      });
    const input = controls.querySelector<HTMLInputElement>(
      `[data-row="${key}"] input`
    );
    if (input && row) input.value = rowText(row);
    drawControls();
    redraw();
  };
  /** An expression row's typeset field, made once per row and kept across draws. */
  const fieldFor = (key: string) => {
    const known = fields.get(key);
    if (known || !Mathfield) return known ?? null;
    const field = new Mathfield();
    field.defaultMode = 'math';
    field.smartFence = true;
    field.mathVirtualKeyboardPolicy = 'auto';
    field.className = 'capy-plane-math';
    if (key === newKey)
      field.placeholder = `\\text{${m.drawing_board_plane_type_formula()}}`;
    field.addEventListener('input', () =>
      typedRow(key, field.value, field.getValue('ascii-math'))
    );
    // Capture: MathLive takes keys inside its shadow root first.
    field.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        commitRow(key);
      },
      true
    );
    field.addEventListener('focusout', () => commitRow(key));
    fields.set(key, field);
    return field;
  };
  /** Loads MathLive the first time the list opens, then draws the rows. */
  const loadMathfield = async () => {
    const { MathfieldElement } = await import('mathlive');
    MathfieldElement.fontsDirectory = '/mathlive/fonts';
    MathfieldElement.soundsDirectory = null;
    MathfieldElement.locale = getLocale();
    Mathfield = MathfieldElement;
    drawControls();
  };
  /** Fields join the page before MathLive's shadow root takes styles and a value;
   * an unfocused row follows its row's LaTeX, so undo shows in it. */
  const syncFields = () => {
    for (const [key, field] of fields) {
      const row = rows.find((each) => each.key === key);
      if (key !== newKey && row?.kind !== 'expression') {
        fields.delete(key);
        continue;
      }
      if (!field.isConnected) continue;
      if (!field.dataset.ready) {
        field.dataset.ready = '1';
        const styles = document.createElement('style');
        styles.textContent = mathFieldStyles;
        field.shadowRoot?.append(styles);
        field.menuItems = [];
        field.inlineShortcuts = {
          ...field.inlineShortcuts,
          ...COMMAND_SHORTCUTS,
        };
      }
      if (
        row?.kind === 'expression' &&
        field.value !== row.latex &&
        document.activeElement !== field
      )
        field.setValue(row.latex, { silenceNotifications: true });
    }
    if (focusRow) {
      controls
        .querySelector<HTMLInputElement>(`[data-row="${focusRow}"] input`)
        ?.select();
      focusRow = null;
    }
  };
  const rowText = (row: GraphRow) =>
    row.kind === 'label'
      ? row.text
      : row.kind === 'mark'
        ? markRow(row.element).text
        : '';
  /** A label's or line's row, typed in place and written on change. */
  const commitText = (row: GraphRow, input: HTMLInputElement) => {
    const text = input.value.trim();
    if (row.kind === 'label')
      writeRows(
        text
          ? rows.map((each) =>
              each.key === row.key
                ? { ...row, text: text.slice(0, PLANE_LABEL_MAX) }
                : each
            )
          : rows.filter((each) => each.key !== row.key)
      );
    else if (row.kind === 'mark') {
      const line = typedLine(row.element, text);
      if (line)
        writeRows(
          rows.map((each) =>
            each.key === row.key ? { ...row, element: line } : each
          )
        );
      else input.value = rowText(row);
    }
    redraw();
  };
  const addLabel = () => {
    if (rows.length >= ELEMENTS_MAX) {
      fullError = m.drawing_board_plane_full();
      drawControls();
      return;
    }
    const { height, width } = box();
    const key = crypto.randomUUID();
    focusRow = key;
    writeRows([
      ...rows,
      {
        // Over a phone's sheet, the middle of what's left above it.
        coords: tools.snapped([
          width / 2,
          listLayout() === 'sheet' ? height * 0.26 : height / 2,
        ]),
        key,
        kind: 'label',
        text: m.drawing_board_plane_label(),
      },
    ]);
    redraw();
  };
  const rowElement = (key: string) =>
    built.elements.find((element) => element.id === key);
  const rowBody = (row: GraphRow, number: number) => {
    if (row.kind === 'expression') {
      const field = fieldFor(row.key);
      field?.setAttribute(
        'aria-label',
        m.question_ui_graph_expression({ number })
      );
      return field;
    }
    const shown = row.kind === 'mark' ? markRow(row.element) : null;
    // Shaped on the plane, not typed: the row names it (Epo 2026-11-13).
    if (shown && !shown.typed)
      return html`<span class="capy-plane-row-text">${shown.text}</span>`;
    return html`<input
      aria-label=${row.kind === 'label' ? m.drawing_board_plane_label() : m.question_ui_graph_expression({ number })}
      maxlength=${row.kind === 'label' ? PLANE_LABEL_MAX : 80}
      type="text"
      .value=${rowText(row)}
      @change=${(event: Event) => commitText(row, event.target as HTMLInputElement)}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
      }}
    />`;
  };
  const objectsList = () => {
    const layout = listLayout();
    const newField = fieldFor(newKey);
    newField?.setAttribute(
      'aria-label',
      m.question_ui_graph_expression({ number: rows.length + 1 })
    );
    const kindIcon = (row: GraphRow | null, error: string | undefined) => {
      if (error)
        return html`<span class="err" title=${error}>${hugeIcon(AlertCircleIcon)}</span>`;
      const element = row && rowElement(row.key);
      const kind = element
        ? kindOf(element)
        : row?.kind === 'expression' && row.parsed
          ? parsedKind(row.parsed)
          : null;
      return kind && unsafeSVG(mathsIcon(kind));
    };
    return html`<div
      class="capy-plane-list"
      data-layout=${layout}
      @pointerleave=${() => {
        if (!controls.querySelector('.capy-plane-list :focus'))
          tools.setHot(null);
      }}
    >
      <ol
        @scroll=${() => {
          if (!menuFor) return;
          menuFor = null;
          drawControls();
        }}
      >
        ${repeat(
          // The empty row last, keyed as the row it becomes once typed in and drawn
          // by the same template, so its field stays where it is, focused.
          [...rows, null],
          (row) => row?.key ?? newKey,
          (row, index) =>
            html`<li
              class=${row && tools.selected(row.key) ? 'on' : ''}
              ?data-new=${!row}
              data-row=${row?.key ?? newKey}
              @focusin=${() => tools.setHot(row?.key ?? null)}
              @pointerenter=${() => row && tools.setHot(row.key)}
            >
              <span class="kind"
                >${kindIcon(row, row ? built.errors.get(row.key) : (fullError ?? undefined))}</span
              >
              ${row ? rowBody(row, index + 1) : newField}
              ${
                row
                  ? html`<button
                      aria-label=${m.a11y_more_actions()}
                      class="more"
                      type="button"
                      @click=${(event: MouseEvent) => {
                        const list = controls.querySelector('.capy-plane-list');
                        const button = event.currentTarget as HTMLElement;
                        menuFor =
                          menuFor?.id === row.key || !list
                            ? null
                            : {
                                id: row.key,
                                top:
                                  button.getBoundingClientRect().bottom -
                                  list.getBoundingClientRect().top +
                                  4,
                              };
                        drawControls();
                      }}
                    >
                      ${hugeIcon(MoreVerticalIcon)}
                    </button>`
                  : html`<span></span>`
              }
            </li>`
        )}
      </ol>
      <button class="add" type="button" @click=${addLabel}>
        ${hugeIcon(PlusSignIcon)} ${m.drawing_board_plane_label()}
      </button>
      ${
        menuFor
          ? html`<div class="capy-menu-list" role="menu" style="top:${menuFor.top}px">
              <button
                role="menuitem"
                type="button"
                @click=${() => {
                  const id = menuFor?.id;
                  menuFor = null;
                  tools.setHot(null);
                  writeRows(rows.filter((row) => row.key !== id));
                  redraw();
                }}
              >
                ${hugeIcon(Delete02Icon)} ${m.action_delete()}
              </button>
            </div>`
          : null
      }
    </div>`;
  };
  /** A symbol from the row typed where the label's caret is, within its length. */
  const insertSymbol = (symbol: string) => {
    const field = labelField();
    if (!field) return;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    if (field.value.length - (end - start) + symbol.length > PLANE_LABEL_MAX)
      return;
    field.setRangeText(symbol, start, end, 'end');
  };
  const drawControls = () => {
    const tool = tools.tool();
    const typing = tools.typing();
    root.dataset.tool = tool;
    const layout = listLayout();
    const showList = layout !== '';
    root.dataset.list = layout;
    if (showList && !Mathfield) void loadMathfield();
    const finishLabel = tools.finishLabel();
    // The field keeps what's typed in it across draws.
    const label = labelField();
    render(
      html`${
        finishLabel
          ? html`<button
                class="capy-plane-finish"
                type="button"
                @click=${() => tools.finish()}
              >
                ${finishLabel}
              </button>`
          : null
      }
        ${
          typing
            ? html`<input
                aria-label=${m.drawing_board_chart_label()}
                class="capy-chart-label"
                maxlength=${PLANE_LABEL_MAX}
                style="left:${(typing.at[0] - view.x0) * view.ppu}px;top:${(view.y0 - typing.at[1]) * view.ppu}px;font-size:${typing.size ?? LABEL_SIZE}px"
                type="text"
                .value=${typing.text}
                @blur=${() => tools.commitLabel()}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === 'Enter') tools.commitLabel();
                }}
              />
              <div
                class="capy-symbols capy-plane-symbols"
                style="top:${(view.y0 - typing.at[1]) * view.ppu + (typing.size ?? LABEL_SIZE) / 2 + 12}px"
              >
                ${symbolButtons(insertSymbol)}
              </div>`
            : null
        }
        ${
          workspace
            ? html`<button
                aria-label=${m.drawing_board_objects()}
                aria-pressed=${showList}
                class="capy-plane-list-toggle"
                type="button"
                @click=${toggleList}
              >
                ${hugeIcon(LeftToRightListBulletIcon)}
              </button>`
            : null
        }
        ${showList ? objectsList() : null}
        <div class="capy-plane-tools">
          <div class="capy-plane-row">
            ${toolsFor(Boolean(view.polar)).map(
              ({ icon, id, key, label }) =>
                html`<button
                  aria-label=${label()}
                  aria-pressed=${tool === id}
                  type="button"
                  @click=${() => tools.pick(id)}
                >
                  ${unsafeSVG(mathsIcon(icon))} ${toolTip(label(), key)}
                </button>`
            )}
          </div>
        </div>`,
      controls
    );
    syncFields();
    // A label just opened for typing takes the keys, its text selected.
    const field = labelField();
    if (typing && field && !label) field.select();
    // The symbol row sits under its label, kept inside the plane.
    const symbols = controls.querySelector<HTMLElement>('.capy-plane-symbols');
    if (symbols && typing) {
      const half = symbols.offsetWidth / 2;
      const x = (typing.at[0] - view.x0) * view.ppu;
      symbols.style.left = `${Math.min(Math.max(x, half + 8), box().width - half - 8)}px`;
    }
    if (showList)
      controls
        .querySelector('.capy-plane-list li.on')
        ?.scrollIntoView({ block: 'nearest' });
  };
  drawControls();
  // Past 640 px either way the list turns card or sheet.
  new ResizeObserver(() => {
    if (root.dataset.list !== listLayout()) drawControls();
    redraw();
  }).observe(root);
  draw();
}

setPlaneEditor(openPlaneEditor);
