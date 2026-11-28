/**
 * A drawn film on a canvas: ManimGX's player with its own face hidden (Capy
 * draws the controls, FilmPlayer), drawn when it is due and fed the film's
 * take as the worker writes it. Its viewer grabs what the scene's author
 * tagged (`interactive(…)` in the exporter): a drag moves an object,
 * Shift-drag or an object that only turns turns it, the wheel scales it; on a
 * 3D view a drag on empty film orbits the camera, the wheel zooms and a
 * tagged object spins. Grabbing pauses the film; playing or seeking lets
 * every pose go. The wiring follows ManimGX's <manimgx-player> element
 * (browser/src/player.ts, MIT).
 */
import type { FilmControl } from './control';
import type { Engine, EnginePlayer, FilmObject } from './engine';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** How long a film sits paused and untouched before it rests: its player and
 * engine go (several hundred MB on a 3D film, bench/manim/reports/
 * 2026-11-27-manimgx-memory.md), its last picture stays. */
const REST_MS = 60_000;
/** A press that moves less than this (CSS pixels) is a click. */
const CLICK_SLOP = 4;
/** Radians a 3D view turns per CSS pixel dragged. */
const ORBIT = 0.006;
/** How near (CSS pixels) a press takes a values object's handle. */
const HANDLE = 24;
/** A flicked 3D object keeps this much of its spin each frame. */
const FRICTION = 0.94;

interface Pose {
  angle: number;
  dx: number;
  dy: number;
  scale: number;
}
const STILL: Pose = { angle: 0, dx: 0, dy: 0, scale: 1 };

type Drag =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'orbit'; from: [number, number]; x: number; y: number }
  | { id: number; kind: 'spin'; x: number; y: number }
  | { id: number; kind: 'stops'; x: number; y: number }
  | {
      /** Its centre (or pivot) when taken, canvas pixels. */
      centre: [number, number];
      from: Pose;
      id: number;
      kind: 'pose';
      turn: boolean;
      x: number;
      y: number;
    };

type Xy = ArrayLike<number>;
const near = (a: Xy, b: Xy) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));

/** The point of polyline `line` nearest `p` (2D, in the scene's plane). */
function onLine(line: readonly (readonly number[])[], p: Xy) {
  let best: [number, number] = [p[0] ?? 0, p[1] ?? 0];
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 1; i < line.length; i++) {
    const [ax = 0, ay = 0] = line[i - 1] ?? [];
    const [bx = 0, by = 0] = line[i] ?? [];
    const px = p[0] ?? 0;
    const py = p[1] ?? 0;
    const len = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = len
      ? Math.max(
          0,
          Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len)
        )
      : 0;
    const q: [number, number] = [ax + t * (bx - ax), ay + t * (by - ay)];
    const d = near(q, p);
    if (d < bestD) [best, bestD] = [q, d];
  }
  return best;
}

/** A tagged object in the frame shown, with its box in CSS pixels. */
export interface ShownObject extends FilmObject {
  box: [number, number, number, number];
}

export class DrawnPlayer implements FilmControl {
  private readonly player: EnginePlayer;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame = 0;
  private failed = false;
  private active = performance.now();
  private readonly rest: ReturnType<typeof setInterval>;

  private readonly box: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly onChange: () => void;
  private readonly onError: (error: unknown) => void;
  private readonly onRest: () => void;
  private readonly onToggle: () => void;
  private readonly poses = new Map<number, Pose>();
  private view: [number, number, number] = [0, 0, 1]; // yaw, pitch, zoom
  private drag: Drag | null = null;
  private hover: number | undefined;
  /** The stop each values object shows, by id. */
  private readonly stops = new Map<number, number>();
  private flick = 0;
  private paper = false;
  /** Grabbed or turned since the film last played or was sought. */
  touched = false;
  private onDrawn: (() => void) | undefined;
  /** The film's own width: the canvas never draws more pixels than it was
   * exported at (a Retina or full-screen canvas would cost several times the
   * GPU memory and look no sharper than the export,
   * bench/manim/reports/2026-11-27-manimgx-memory.md). */
  private readonly filmWidth: number;

  constructor(
    engine: Engine,
    box: HTMLElement,
    canvas: HTMLCanvasElement,
    filmWidth: number,
    time: number,
    {
      onChange,
      onDrawn,
      onError,
      onRest,
      onToggle,
    }: {
      /** What FilmPlayer shows changed: a pose, the hover, grabbing. */
      onChange: () => void;
      /** Its first picture is up. */
      onDrawn: () => void;
      onError: (error: unknown) => void;
      /** It has sat paused and untouched for REST_MS. */
      onRest: () => void;
      /** A click on the film, not on a tagged object: play or pause. */
      onToggle: () => void;
    }
  ) {
    this.box = box;
    this.canvas = canvas;
    this.filmWidth = filmWidth;
    this.onChange = onChange;
    this.onDrawn = onDrawn;
    this.onError = onError;
    this.onRest = onRest;
    this.onToggle = onToggle;
    const rect = canvas.getBoundingClientRect();
    this.player = new engine.Player(canvas, time, false, MAC);
    this.player.face(false);
    this.size(
      rect.width,
      rect.width * devicePixelRatio,
      rect.height * devicePixelRatio
    );
    this.wire();
    this.rest = setInterval(() => {
      if (this.player.playing) this.active = performance.now();
      else if (performance.now() - this.active > REST_MS) this.onRest();
    }, 5000);
  }

  /** Sizes the canvas from its CSS width and its size in screen pixels,
   * capped at the film's own width. */
  private size(cssWidth: number, width: number, height: number) {
    const cap = Math.min(1, this.filmWidth / width);
    const w = Math.max(1, Math.round(width * cap));
    const h = Math.max(1, Math.round(height * cap));
    this.canvas.width = w;
    this.canvas.height = h;
    this.player.resize(w, h, w / Math.max(1, cssWidth));
  }

  feed(bytes: Uint8Array) {
    if (this.failed) return;
    try {
      this.player.feed(bytes);
    } catch (error) {
      this.fail(error);
      return;
    }
    this.after();
  }

  /** Whether it shows as on paper: a light ground, dark ink. */
  get theme() {
    return this.paper;
  }

  set theme(paper: boolean) {
    this.paper = paper;
    this.player.theme(paper);
    this.after();
  }

  get duration() {
    return this.player.duration;
  }

  get playing() {
    return this.player.playing;
  }

  get rate() {
    return this.player.rate;
  }

  set rate(rate: number) {
    this.player.rate = rate;
    this.after();
  }

  get time() {
    return this.player.time;
  }

  /** Seeks; the viewer's poses go. */
  set time(t: number) {
    this.letGo();
    this.player.time = t;
    this.after();
  }

  /** Plays on; the viewer's poses go. */
  play() {
    if (this.failed) return;
    this.letGo();
    this.player.play();
    this.active = performance.now();
    this.after();
  }

  pause() {
    if (this.failed) return;
    this.player.pause();
    this.after();
  }

  /** Whether the frame shown looks at its scene in 3D: a 3D view whose
   * camera is tilted, so the scene's up shows on the canvas. A 3D scene seen
   * straight from above (a slide of flat shapes) is held as a 2D film's. */
  get is3d() {
    if (!this.player.is3d()) return false;
    const a = this.player.toCanvas(0, 0, 0);
    const b = this.player.toCanvas(0, 0, 1);
    return !(a && b) || near(a, b) > 0.5;
  }

  /** Whether the viewer has moved anything, or turned the view. */
  get moved() {
    return (
      this.poses.size > 0 ||
      this.stops.size > 0 ||
      this.view.some((v, i) => v !== (i === 2 ? 1 : 0)) ||
      this.spun
    );
  }
  private spun = false;

  get grabbing() {
    return this.drag !== null && this.drag.kind !== 'click';
  }

  /** The tagged objects in the frame shown, boxed in CSS pixels. */
  shown(): ShownObject[] {
    const k = this.canvas.clientWidth / Math.max(1, this.canvas.width);
    return this.player.objects().flatMap((object) => {
      if (object.handles) {
        const h = this.handle(object);
        if (!h) return [];
        const r = HANDLE / 2;
        return [
          {
            ...object,
            box: [h[0] * k - r, h[1] * k - r, h[0] * k + r, h[1] * k + r],
          },
        ];
      }
      if (object.follows !== undefined) return []; // its leader is the one held
      const b = this.player.bounds(object.id);
      return b
        ? [
            {
              ...object,
              box: [
                b[0] * k,
                b[1] * k,
                b[2] * k,
                b[3] * k,
              ] as ShownObject['box'],
            },
          ]
        : [];
    });
  }

  /** Puts every object and the view back as the film has them. */
  reset() {
    this.letGo();
    this.after();
  }

  /** Where object `id` is in the scene against its target: whether it is
   * within the target's tolerance, and how far off (scene units). */
  check(id: number): { distance: number; hit: boolean } | undefined {
    const it = this.player.objects().find((o) => o.id === id);
    const b = this.player.bounds(id);
    if (!(it?.target && b)) return;
    const at = this.player.toScene((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    if (!at) return;
    const distance = near(at, it.target);
    return { distance, hit: distance <= (it.tolerance ?? 0) };
  }

  /** Turns 3D object `id` a quarter about the world's x, y or z axis,
   * over a few frames. */
  quarter(id: number, axis: 0 | 1 | 2) {
    this.hold();
    this.spun = true;
    const steps = 12;
    let done = 0;
    const step = () => {
      if (this.failed || done === steps) return;
      done++;
      this.player.turn(id, axis, Math.PI / 2 / steps);
      this.after();
      requestAnimationFrame(step);
    };
    step();
    this.onChange();
  }

  /** A values object's handle shown now, canvas pixels: its stop's, or the
   * film's own value's. */
  private handle(object: FilmObject): Float32Array | undefined {
    const { handles = [], value, values = [] } = object;
    let index = this.stops.get(object.id);
    if (index === undefined && value !== undefined)
      index = values.reduce(
        (best, v, k) =>
          Math.abs(v - value) < Math.abs((values[best] ?? 0) - value)
            ? k
            : best,
        0
      );
    const point = handles[index ?? 0];
    return point && this.player.toCanvas(point[0], point[1], point[2]);
  }

  private letGo() {
    this.touched = false;
    cancelAnimationFrame(this.flick);
    if (!this.moved) return;
    this.poses.clear();
    this.stops.clear();
    this.view = [0, 0, 1];
    this.spun = false;
    this.player.reset();
    this.player.resetView();
    this.onChange();
  }

  /** The viewer took hold: the film pauses. */
  private hold() {
    this.player.pause();
    this.touched = true;
  }

  /** Frees the player; returns where the film was. */
  destroy(): number {
    this.controller.abort();
    clearInterval(this.rest);
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.flick);
    this.player.pause();
    const { time } = this.player;
    this.player.free();
    return time;
  }

  private fail(error: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.onError(error);
  }

  /** What the viewer does with the film: grabs, orbits, clicks. */
  private wire() {
    const { canvas, player } = this;
    const signal = this.controller.signal;
    const at = (e: PointerEvent | WheelEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [
        (e.clientX - rect.left) * (canvas.width / rect.width),
        (e.clientY - rect.top) * (canvas.height / rect.height),
      ];
    };
    // canvas pixels per CSS pixel
    const ratio = () => canvas.width / Math.max(1, canvas.clientWidth);
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      hand: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions
    ) =>
      canvas.addEventListener(
        type,
        (e) => {
          if (this.failed) return;
          this.active = performance.now();
          hand(e);
          this.after();
        },
        { ...options, signal }
      );
    const object = (id: number | undefined) =>
      id === undefined ? undefined : player.objects().find((o) => o.id === id);
    const pose = (id: number, next: Pose) => {
      this.poses.set(id, next);
      player.pose(id, next.dx, next.dy, next.angle, next.scale);
    };
    // the values object whose shown handle is under (x, y), canvas pixels
    const valuesAt = (x: number, y: number) =>
      player.objects().find((o) => {
        const h = o.handles && this.handle(o);
        return h && near(h, [x, y]) / ratio() < HANDLE;
      });
    // where an object dragged to `want` (canvas pixels) may be: on its curve,
    // inside its rectangle, on its grid, all in the scene's units
    const keep = (it: FilmObject, want: [number, number]): [number, number] => {
      if (!(it.along || it.within || it.snap)) return want;
      const s = player.toScene(want[0], want[1]);
      if (!s) return want;
      let p: [number, number] = [s[0] ?? 0, s[1] ?? 0];
      if (it.along) p = onLine(it.along, p);
      if (it.snap) {
        const snap = it.snap;
        p = [Math.round(p[0] / snap) * snap, Math.round(p[1] / snap) * snap];
      }
      if (it.within) {
        const [x0, y0, x1, y1] = it.within;
        p = [
          Math.min(x1, Math.max(x0, p[0])),
          Math.min(y1, Math.max(y0, p[1])),
        ];
      }
      const c = player.toCanvas(p[0], p[1], s[2]);
      return c ? [c[0] ?? want[0], c[1] ?? want[1]] : want;
    };
    // a 3D object let go while spinning keeps turning, slowing down
    let velocity: [number, number] = [0, 0];
    const flick = (id: number) => {
      const step = () => {
        velocity = [velocity[0] * FRICTION, velocity[1] * FRICTION];
        if (this.failed || Math.hypot(...velocity) < 0.3) return;
        player.spin(id, ...velocity);
        this.after();
        this.flick = requestAnimationFrame(step);
      };
      this.flick = requestAnimationFrame(step);
    };
    let pressed: number | null = null; // one pointer at a time
    on('pointermove', (e) => {
      const [x, y] = at(e);
      const drag = this.drag;
      if (!drag || e.pointerId !== pressed) {
        const hover = player.pick(x, y) ?? valuesAt(x, y)?.id;
        if (hover !== this.hover) {
          this.hover = hover;
          this.onChange();
        }
        canvas.style.cursor =
          hover !== undefined || this.is3d ? 'grab' : 'pointer';
        return;
      }
      if (drag.kind === 'click') {
        // a drag on a 2D film's empty space does nothing
        return;
      }
      if (drag.kind === 'orbit') {
        const k = ORBIT / ratio();
        this.view[0] = drag.from[0] - (x - drag.x) * k;
        this.view[1] = Math.max(
          -1.4,
          Math.min(1.4, drag.from[1] - (y - drag.y) * k)
        );
        player.orbit(this.view[0], this.view[1]);
      } else if (drag.kind === 'spin') {
        player.spin(drag.id, x - drag.x, y - drag.y);
        this.spun = true;
        velocity = [x - drag.x, y - drag.y];
        [drag.x, drag.y] = [x, y];
      } else if (drag.kind === 'stops') {
        const it = object(drag.id);
        const handles = (it?.handles ?? []).map((h) =>
          player.toCanvas(h[0], h[1], h[2])
        );
        let index = 0;
        handles.forEach((h, k) => {
          if (h && near(h, [x, y]) < near(handles[index] ?? [x, y], [x, y]))
            index = k;
        });
        if (this.stops.get(drag.id) !== index) {
          this.stops.set(drag.id, index);
          player.stop(drag.id, index);
        }
      } else if (drag.turn) {
        const it = object(drag.id);
        const [cx, cy] = drag.centre;
        let angle =
          drag.from.angle +
          Math.atan2(y - cy, x - cx) -
          Math.atan2(drag.y - cy, drag.x - cx);
        if (it?.step) {
          const step = (it.step * Math.PI) / 180;
          angle = Math.round(angle / step) * step;
        }
        pose(drag.id, { ...drag.from, angle });
      } else {
        const it = object(drag.id);
        const [cx, cy] = drag.centre;
        const want: [number, number] = [cx + x - drag.x, cy + y - drag.y];
        const [tx, ty] = it ? keep(it, want) : want;
        pose(drag.id, {
          ...drag.from,
          dx: drag.from.dx + tx - cx,
          dy: drag.from.dy + ty - cy,
        });
      }
      this.onChange();
    });
    on('pointerdown', (e) => {
      if (pressed !== null || e.button !== 0 || !e.isPrimary) return;
      pressed = e.pointerId;
      this.box.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = at(e);
      cancelAnimationFrame(this.flick);
      const id = player.pick(x, y);
      const it = object(id);
      const is3d = this.is3d;
      const values = id === undefined ? valuesAt(x, y) : undefined;
      if (values) {
        this.drag = { id: values.id, kind: 'stops', x, y };
        this.hold();
      } else if (id === undefined || !it) {
        this.drag = is3d
          ? { from: [this.view[0], this.view[1]], kind: 'orbit', x, y }
          : { kind: 'click', x, y };
        if (is3d) this.hold();
      } else if (is3d && it.rotate) {
        this.drag = { id, kind: 'spin', x, y };
        this.hold();
      } else {
        const b = player.bounds(id) ?? [x, y, x, y];
        const pivot =
          it.pivot && player.toCanvas(it.pivot[0], it.pivot[1], it.pivot[2]);
        this.drag = {
          centre: pivot
            ? [pivot[0] ?? x, pivot[1] ?? y]
            : [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
          from: this.poses.get(id) ?? STILL,
          id,
          kind: 'pose',
          turn: it.rotate && (e.shiftKey || !it.move),
          x,
          y,
        };
        this.hold();
      }
      if (this.drag.kind !== 'click') canvas.style.cursor = 'grabbing';
      this.onChange();
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerId !== pressed) return;
      pressed = null;
      const drag = this.drag;
      this.drag = null;
      // a press that barely moved: a click, on empty film or a still 3D view
      if (!cancelled && drag) {
        const [x, y] = at(e);
        const still = Math.hypot(x - drag.x, y - drag.y) / ratio() < CLICK_SLOP;
        if (drag.kind === 'click' && still) this.onToggle();
        if (drag.kind === 'orbit' && still) {
          this.touched = this.moved;
          this.onToggle();
        }
        if (drag.kind === 'spin' && !still) flick(drag.id);
      }
      canvas.style.cursor =
        this.hover !== undefined || this.is3d ? 'grab' : 'pointer';
      this.onChange();
    };
    on('pointerup', (e) => end(e, false));
    on('pointercancel', (e) => end(e, true));
    on('pointerleave', () => {
      if (this.hover === undefined) return;
      this.hover = undefined;
      this.onChange();
    });
    on(
      'wheel',
      (e) => {
        const [x, y] = at(e);
        const id = player.pick(x, y);
        const it = object(id);
        // pixels, lines (as a window's), pages
        const unit = [1, 20, canvas.clientHeight][e.deltaMode] ?? 1;
        const factor = Math.exp(-e.deltaY * unit * 0.002);
        if (id !== undefined && it?.scale) {
          e.preventDefault();
          this.hold();
          const from = this.poses.get(id) ?? STILL;
          pose(id, {
            ...from,
            scale: Math.min(4, Math.max(0.25, from.scale * factor)),
          });
        } else if (!it && this.is3d) {
          e.preventDefault();
          this.hold();
          this.view[2] = Math.min(4, Math.max(0.4, this.view[2] * factor));
          player.zoom(this.view[2]);
        } else return;
        this.onChange();
      },
      { passive: false }
    );
    // drawn at the size the page shows it, in the screen's own pixels, up to
    // the film's own
    const resize = new ResizeObserver(([entry]) => {
      const css = entry?.contentBoxSize[0];
      if (!(entry && css) || this.failed) return;
      const device = entry.devicePixelContentBoxSize?.[0];
      this.size(
        css.inlineSize,
        device ? device.inlineSize : css.inlineSize * devicePixelRatio,
        device ? device.blockSize : css.blockSize * devicePixelRatio
      );
      this.after();
    });
    resize.observe(canvas);
    // out of sight it draws nothing (its clock and sound go on)
    const visibility = new IntersectionObserver(([entry]) => {
      if (!entry || this.failed) return;
      player.hide(!entry.isIntersecting);
      this.after();
    });
    visibility.observe(this.box);
    signal.addEventListener(
      'abort',
      () => {
        resize.disconnect();
        visibility.disconnect();
      },
      { once: true }
    );
  }

  /** What the player asks, its cursor, and its next picture when due. */
  private after() {
    if (this.failed || this.controller.signal.aborted) return;
    const { player } = this;
    clearTimeout(this.timer);
    let wake: number;
    try {
      wake = player.wake();
    } catch (error) {
      this.fail(error);
      return;
    }
    if (wake === 0) this.frame ||= requestAnimationFrame(() => this.draw());
    else if (wake > 0) this.timer = setTimeout(() => this.after(), wake);
  }

  private draw() {
    this.frame = 0;
    try {
      this.player.draw();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.onDrawn?.();
    this.onDrawn = undefined;
    // a still frame's objects (their halos, FilmPlayer) may have moved
    if (!this.player.playing) this.onChange();
    this.after();
  }
}
