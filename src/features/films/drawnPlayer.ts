/**
 * A drawn film on a canvas: ManimGX's player, handed what its viewer does in
 * the web's own words, drawn when it is due, and fed the film's take as the
 * worker writes it. The wiring follows ManimGX's <manimgx-player> element
 * (browser/src/player.ts, MIT).
 */
import type { Engine, EnginePlayer } from './engine';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** How long a film sits paused and untouched before it rests: its player and
 * engine go (several hundred MB on a 3D film, bench/manim/reports/
 * 2026-11-27-manimgx-memory.md), its last picture stays. */
const REST_MS = 60_000;

export class DrawnPlayer {
  private readonly player: EnginePlayer;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame = 0;
  private failed = false;
  private active = performance.now();
  private readonly rest: ReturnType<typeof setInterval>;

  private readonly box: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly onError: (error: unknown) => void;
  private readonly onRest: () => void;
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
      onDrawn,
      onError,
      onRest,
    }: {
      /** Its first picture is up. */
      onDrawn: () => void;
      onError: (error: unknown) => void;
      /** It has sat paused and untouched for REST_MS. */
      onRest: () => void;
    }
  ) {
    this.box = box;
    this.canvas = canvas;
    this.filmWidth = filmWidth;
    this.onDrawn = onDrawn;
    this.onError = onError;
    this.onRest = onRest;
    const rect = canvas.getBoundingClientRect();
    this.player = new engine.Player(canvas, time, false, MAC);
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

  /** A click at (x, y) in the canvas's pixels: the one that woke a resting
   * film, handed on once its take is in. */
  click(x: number, y: number) {
    if (this.failed) return;
    this.player.press(x, y, false);
    this.player.release();
    this.after();
  }

  /** Frees the player; returns where the film was. */
  destroy(): number {
    this.controller.abort();
    clearInterval(this.rest);
    clearTimeout(this.timer);
    cancelAnimationFrame(this.frame);
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

  /** What the viewer does, handed on; the page's default is prevented when
   * the player took it. */
  private wire() {
    const { box, canvas, player } = this;
    const signal = this.controller.signal;
    const at = (e: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [
        (e.clientX - rect.left) * (canvas.width / rect.width),
        (e.clientY - rect.top) * (canvas.height / rect.height),
      ];
    };
    const on = <K extends keyof HTMLElementEventMap>(
      target: Pick<HTMLElement, 'addEventListener'>,
      type: K,
      hand: (event: HTMLElementEventMap[K]) => boolean | undefined,
      options?: AddEventListenerOptions
    ) =>
      target.addEventListener(
        type,
        (e) => {
          if (this.failed) return;
          this.active = performance.now();
          if (hand(e)) e.preventDefault();
          this.after();
        },
        { ...options, signal }
      );
    let pressed: number | null = null; // one pointer at a time
    on(box, 'keydown', (e) =>
      player.key(e.key, e.ctrlKey, e.altKey, e.metaKey)
    );
    on(canvas, 'pointermove', (e) => {
      player.pointer(...at(e));
      return false;
    });
    on(canvas, 'pointerdown', (e) => {
      if (pressed !== null || e.button !== 0 || !e.isPrimary) return false;
      pressed = e.pointerId;
      box.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
      return player.press(...at(e), e.pointerType === 'touch');
    });
    const end = (e: PointerEvent, ended: () => boolean) => {
      if (e.pointerId !== pressed) return false;
      pressed = null;
      return ended();
    };
    on(canvas, 'pointerup', (e) => end(e, () => player.release()));
    on(canvas, 'pointercancel', (e) =>
      end(e, () => {
        player.cancel();
        return false;
      })
    );
    on(canvas, 'pointerleave', () => {
      player.leave();
      return false;
    });
    on(
      canvas,
      'wheel',
      (e) => {
        // pixels, lines (as a window's), pages
        const unit = [1, 20, canvas.clientHeight][e.deltaMode] ?? 1;
        return player.wheel(e.deltaX * unit, e.deltaY * unit);
      },
      { passive: false }
    );
    on(document, 'fullscreenchange', () => {
      player.fullscreen(document.fullscreenElement === box);
      return false;
    });
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
    visibility.observe(box);
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
    for (const [ask, value] of player.asks()) {
      if (ask !== 'fullscreen') continue; // a film has its one scene
      if (value) this.box.requestFullscreen?.().catch(() => undefined);
      else if (document.fullscreenElement === this.box)
        document.exitFullscreen();
    }
    this.canvas.style.cursor = player.cursor;
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
    this.after();
  }
}
