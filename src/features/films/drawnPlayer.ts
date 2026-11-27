/**
 * A drawn film on a canvas: ManimGX's player, handed what its viewer does in
 * the web's own words, drawn when it is due, and fed the film's take as the
 * worker writes it. The wiring follows ManimGX's <manimgx-player> element
 * (browser/src/player.ts, MIT).
 */
import type { Engine, EnginePlayer } from './engine';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

export class DrawnPlayer {
  private readonly player: EnginePlayer;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame = 0;
  private failed = false;

  private readonly box: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly onError: (error: unknown) => void;

  constructor(
    engine: Engine,
    box: HTMLElement,
    canvas: HTMLCanvasElement,
    time: number,
    onError: (error: unknown) => void
  ) {
    this.box = box;
    this.canvas = canvas;
    this.onError = onError;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * devicePixelRatio));
    canvas.height = Math.max(1, Math.round(rect.height * devicePixelRatio));
    this.player = new engine.Player(canvas, time, false, MAC);
    this.player.resize(canvas.width, canvas.height, devicePixelRatio);
    this.wire();
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

  /** Frees the player; returns where the film was. */
  destroy(): number {
    this.controller.abort();
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
    // drawn at the size the page shows it, in the screen's own pixels
    const resize = new ResizeObserver(([entry]) => {
      const css = entry?.contentBoxSize[0];
      if (!(entry && css) || this.failed) return;
      const device = entry.devicePixelContentBoxSize?.[0];
      const w = device
        ? device.inlineSize
        : Math.round(css.inlineSize * devicePixelRatio);
      const h = device
        ? device.blockSize
        : Math.round(css.blockSize * devicePixelRatio);
      player.resize(w, h, w / css.inlineSize);
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
    this.after();
  }
}
