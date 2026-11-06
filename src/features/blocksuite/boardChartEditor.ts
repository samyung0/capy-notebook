import {
  EditPropsStore,
  ThemeProvider,
} from '@blocksuite/affine/shared/services';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import { html, nothing, render } from 'lit';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import { m } from '@/i18n';
import {
  AXIS_MAX,
  BARS_MAX,
  barPlot,
  type ChartBar,
  type ChartElementModel,
  drawChart,
  LABEL_LENGTH_MAX,
  LABEL_REACH,
  LABELS_MAX,
  type Pads,
  type PieLabel,
  pieCircle,
  SPOKES_MAX,
  setChartEditor,
} from './boardChart';
import { drawChip, openBoardEditor } from './boardEditorShell';
import { clockAngle, snapTo, type Vec } from './boardGeometry';
import { fillRow, mathsIcon } from './boardTools';

type Tool = 'draw' | 'label' | 'erase';

const PIXELS_TO_LABEL = 30;
const DEGREES_TO_ERASE = 8;
/** Most numbered lines the axis takes. */
const AXIS_LINES_MAX = 100;

/** A bar or pie chart, filling the board for editing. Each change is written at once,
 * one undo step. */
function openChartEditor(gfx: GfxController, model: ChartElementModel) {
  let frame = 0;
  let tool: Tool = 'draw';
  /** The label being typed: under a bar, or in a pie at an angle. */
  let typing: {
    angle?: number;
    barId?: string;
    id?: string;
    text: string;
    x: number;
    y: number;
  } | null = null;
  /** The bar being dragged up. */
  let live: { slot: number; value: number } | null = null;
  let pointer: Vec | null = null;

  const shell = openBoardEditor(gfx, model.id, {
    onEscape: () => {
      if (!typing) return false;
      typing = null;
      drawControls();
      return true;
    },
    onLeave: () => {
      commitLabel();
      cancelAnimationFrame(frame);
    },
    onUpdate: () => {
      drawControls();
      redraw();
    },
  });
  if (!shell) return;
  const { box, canvas, controls, ctx, root } = shell;
  root.classList.add('capy-chart-editor');
  const resolve = gfx.std.get(ThemeProvider);
  const isBar = model.kind === 'bar';

  const update = (props: Partial<ChartElementModel>) =>
    shell.write(() => gfx.surface?.updateElement(model.id, props));

  const pads = (): Pads => {
    const phone = box().width < 768;
    return isBar
      ? {
          // The tools with their fill row, and the labels under the bars.
          bottom: 128,
          left: phone ? 44 : 70,
          right: phone ? 16 : 40,
          top: phone ? 112 : 64,
        }
      : { bottom: 92, left: 16, right: 16, top: 64 };
  };
  const slots = () =>
    Math.max(
      3,
      model.bars.length < BARS_MAX ? model.bars.length + 1 : BARS_MAX
    );
  const screen = () => {
    const { height, width } = box();
    return { h: height, w: width, x: 0, y: 0 };
  };
  const local = (event: PointerEvent): Vec => {
    const rect = box();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  const slotAt = ([x]: Vec) => {
    const { left, slotW } = barPlot(screen(), pads(), slots());
    return Math.max(0, Math.min(slots() - 1, Math.floor((x - left) / slotW)));
  };
  /** A bar's height from the pointer's, in half steps up to the axis's end. */
  const valueAt = ([, y]: Vec) => {
    const { base, height } = barPlot(screen(), pads(), slots());
    const value = ((base - y) / height) * model.axisMax;
    return Math.max(
      0,
      Math.min(model.axisMax, snapTo(value, model.axisStep / 2))
    );
  };
  const angleAt = ([x, y]: Vec) => {
    const { cx, cy } = pieCircle(screen(), pads());
    return clockAngle([cx, -cy], [x, -y]);
  };
  /** The sector a new line closes: from the line before it, clockwise. */
  const sectorTo = (angle: number) => {
    const before = [...model.spokes]
      .sort((a, b) => a - b)
      .filter((spoke) => spoke <= angle)
      .at(-1);
    const from = before ?? Math.max(...model.spokes, 0);
    return (angle - from + 360) % 360;
  };
  /** The pie label under a point, if any. */
  const labelAt = ([x, y]: Vec) => {
    const { cx, cy, r } = pieCircle(screen(), pads());
    return model.labels.find(({ angle }) => {
      const turn = (angle * Math.PI) / 180;
      return (
        Math.hypot(
          x - (cx + r * LABEL_REACH * Math.sin(turn)),
          y - (cy - r * LABEL_REACH * Math.cos(turn))
        ) < PIXELS_TO_LABEL
      );
    });
  };

  const draw = () => {
    const { height, width } = shell.sizeCanvas();
    const area = { h: height, w: width, x: 0, y: 0 };
    let bars: ChartBar[] = model.bars;
    if (live) {
      const { slot, value } = live;
      bars = bars.map((bar, i) => (i === slot ? { ...bar, value } : bar));
      if (slot >= bars.length)
        bars = [...bars, { fill: newFill(), id: '', label: '', value }];
    }
    const { axisMax, axisStep, kind, labels, spokes } = model;
    drawChart(
      ctx,
      area,
      { axisMax, axisStep, bars, kind, labels, spokes },
      (color) => resolve.getColorValue(color, 'transparent', true),
      pads(),
      isBar ? slots() : undefined
    );
    if (live) {
      const {
        base,
        height: plot,
        left,
        slotW,
      } = barPlot(area, pads(), slots());
      drawChip(
        ctx,
        `${Number(live.value.toPrecision(10))}`,
        left + slotW * live.slot + slotW * 0.78,
        base - (plot * live.value) / axisMax + 20,
        width
      );
    }
    if (!isBar && tool === 'draw' && pointer) {
      const { cx, cy, r } = pieCircle(area, pads());
      const angle = angleAt(pointer);
      const turn = (angle * Math.PI) / 180;
      const [x, y] = [cx + r * Math.sin(turn), cy - r * Math.cos(turn)];
      ctx.strokeStyle = '#1e96eb';
      ctx.fillStyle = '#1e96eb';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      drawChip(ctx, `${sectorTo(angle)}°`, x, y, width);
    }
  };
  const redraw = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  };

  const newFill = () =>
    gfx.std.get(EditPropsStore).lastProps$.value['shape:rect'].fillColor;

  const openLabel = (at: Vec) => {
    if (isBar) {
      const slot = slotAt(at);
      const bar = model.bars[slot];
      if (!bar) return;
      const { base, left, slotW } = barPlot(screen(), pads(), slots());
      typing = {
        barId: bar.id,
        text: bar.label,
        x: left + slotW * (slot + 0.5),
        y: base + 14,
      };
    } else {
      const label = labelAt(at);
      if (!label && model.labels.length >= LABELS_MAX) return;
      const angle = label?.angle ?? angleAt(at);
      const { cx, cy, r } = pieCircle(screen(), pads());
      const turn = (angle * Math.PI) / 180;
      typing = {
        angle,
        id: label?.id,
        text: label?.text ?? '',
        x: cx + r * LABEL_REACH * Math.sin(turn),
        y: cy - r * LABEL_REACH * Math.cos(turn),
      };
    }
    drawControls();
    controls.querySelector<HTMLInputElement>('.capy-chart-label')?.select();
  };
  const commitLabel = () => {
    const field = controls.querySelector<HTMLInputElement>('.capy-chart-label');
    const open = typing;
    typing = null;
    if (!open || !field) return;
    const text = field.value.trim();
    if (open.barId) {
      const bars = model.bars.map((bar) =>
        bar.id === open.barId ? { ...bar, label: text } : bar
      );
      if (text !== model.bars.find((bar) => bar.id === open.barId)?.label)
        update({ bars });
    } else {
      const others: PieLabel[] = model.labels.filter(
        ({ id }) => id !== open.id
      );
      if (text)
        update({
          labels: [
            ...others,
            {
              angle: open.angle ?? 0,
              id: open.id ?? crypto.randomUUID(),
              text,
            },
          ],
        });
      else if (open.id) update({ labels: others });
    }
    drawControls();
  };

  const eraseAt = (at: Vec) => {
    if (isBar) {
      const slot = slotAt(at);
      if (model.bars[slot])
        update({ bars: model.bars.filter((_, i) => i !== slot) });
      return;
    }
    const label = labelAt(at);
    if (label) {
      update({ labels: model.labels.filter((other) => other !== label) });
      return;
    }
    const angle = angleAt(at);
    const near = model.spokes.find((spoke) => {
      const apart = Math.abs(spoke - angle) % 360;
      return Math.min(apart, 360 - apart) <= DEGREES_TO_ERASE;
    });
    if (near !== undefined)
      update({ spokes: model.spokes.filter((spoke) => spoke !== near) });
  };

  const setAxis = (event: Event, which: 'axisMax' | 'axisStep') => {
    const field = event.target as HTMLInputElement;
    const value = Number(field.value);
    const axisMax = which === 'axisMax' ? value : model.axisMax;
    const axisStep = which === 'axisStep' ? value : model.axisStep;
    if (
      value > 0 &&
      axisMax <= AXIS_MAX &&
      axisStep <= axisMax &&
      axisMax / axisStep <= AXIS_LINES_MAX
    )
      update({ axisMax, axisStep });
    else field.value = String(model[which]);
  };
  /** The axis ends at the first numbered line above the tallest bar. */
  const fit = () => {
    const tallest = Math.max(...model.bars.map(({ value }) => value), 0);
    const axisMax =
      Math.max(Math.ceil(tallest / model.axisStep), 1) * model.axisStep;
    if (axisMax !== model.axisMax) update({ axisMax });
  };

  let pressed = false;
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button) return;
    canvas.setPointerCapture(event.pointerId);
    pressed = true;
    const at = local(event);
    pointer = at;
    if (isBar && tool === 'draw') {
      const slot = slotAt(at);
      if (slot <= model.bars.length && slot < BARS_MAX)
        live = { slot, value: valueAt(at) };
    }
    redraw();
  });
  canvas.addEventListener('pointermove', (event) => {
    const at = local(event);
    pointer = pressed || event.pointerType === 'mouse' ? at : null;
    if (live && pressed) live = { ...live, value: valueAt(at) };
    redraw();
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!pressed) return;
    pressed = false;
    const at = local(event);
    if (live) {
      const { slot, value } = live;
      live = null;
      const bar = model.bars[slot];
      if (bar && value)
        update({
          bars: model.bars.map((other, i) =>
            i === slot ? { ...other, value } : other
          ),
        });
      else if (bar) update({ bars: model.bars.filter((_, i) => i !== slot) });
      else if (value)
        update({
          bars: [
            ...model.bars,
            { fill: newFill(), id: crypto.randomUUID(), label: '', value },
          ],
        });
    } else if (tool === 'label') {
      commitLabel();
      openLabel(at);
    } else if (tool === 'erase') eraseAt(at);
    else if (!isBar && model.spokes.length < SPOKES_MAX) {
      const angle = angleAt(at);
      if (!model.spokes.includes(angle))
        update({ spokes: [...model.spokes, angle] });
    }
    if (event.pointerType !== 'mouse') pointer = null;
    redraw();
  });
  canvas.addEventListener('pointercancel', () => {
    pressed = false;
    live = null;
    pointer = null;
    redraw();
  });
  canvas.addEventListener('pointerleave', () => {
    pointer = null;
    redraw();
  });

  const tools: { icon: string; id: Tool; label: () => string }[] = [
    isBar
      ? { icon: 'bars', id: 'draw', label: m.drawing_board_bars }
      : { icon: 'pie', id: 'draw', label: m.drawing_board_pie },
    { icon: 'label', id: 'label', label: m.drawing_board_chart_label },
    { icon: 'erase', id: 'erase', label: m.drawing_board_erase_mark },
  ];

  const drawControls = () => {
    root.dataset.tool = tool;
    render(
      html`${
        isBar
          ? html`<div class="capy-chart-axis">
              <label>
                ${m.drawing_board_axis_to()}
                <input
                  inputmode="decimal"
                  type="text"
                  .value=${String(model.axisMax)}
                  @change=${(event: Event) => setAxis(event, 'axisMax')}
                />
              </label>
              <label>
                ${m.drawing_board_axis_step()}
                <input
                  inputmode="decimal"
                  type="text"
                  .value=${String(model.axisStep)}
                  @change=${(event: Event) => setAxis(event, 'axisStep')}
                />
              </label>
            </div>`
          : nothing
      }
        <div class="capy-plane-top">
          ${
            isBar
              ? html`<button type="button" @click=${fit}>
                  ${m.drawing_board_fit()}
                </button>`
              : nothing
          }
          <button class="primary" type="button" @click=${shell.close}>
            ${m.drawing_board_done()}
          </button>
        </div>
        ${
          typing
            ? html`<input
                aria-label=${m.drawing_board_chart_label()}
                class="capy-chart-label"
                maxlength=${LABEL_LENGTH_MAX}
                style="left:${typing.x}px;top:${typing.y}px"
                type="text"
                .value=${typing.text}
                @blur=${commitLabel}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === 'Enter') commitLabel();
                }}
              />`
            : nothing
        }
        <div class="capy-plane-tools">
          ${isBar && tool === 'draw' ? fillRow(gfx, drawControls) : nothing}
          <div class="capy-plane-row">
            ${tools.map(
              ({ icon, id, label }) =>
                html`<button
                  aria-label=${label()}
                  aria-pressed=${tool === id}
                  title=${label()}
                  type="button"
                  @click=${() => {
                    commitLabel();
                    tool = id;
                    pointer = null;
                    drawControls();
                    redraw();
                  }}
                >
                  ${unsafeSVG(mathsIcon(icon))}
                </button>`
            )}
          </div>
        </div>`,
      controls
    );
  };
  drawControls();
  new ResizeObserver(redraw).observe(root);
  draw();
}

setChartEditor(openChartEditor);
