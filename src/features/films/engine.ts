/**
 * ManimGX's player for the page: its engine (wasm-bindgen JS and WebAssembly)
 * and the fonts its face is set in, vendored under public/vendor/manimgx at
 * the version the exporter pins (THIRD-PARTY-NOTICES.md). The film's own
 * drawing comes as take messages (take.ts); the engine draws it with WebGPU,
 * with its own controls.
 */

/** The interface rust/engine/src/web.rs exports (ManimGX browser/src/engine.ts). */
export interface Engine {
  default(options: { module_or_path: string }): Promise<unknown>;
  init(fonts: Uint8Array[]): Promise<void>;
  Player: new (
    canvas: HTMLCanvasElement,
    time: number,
    playing: boolean,
    mac: boolean
  ) => EnginePlayer;
}

export interface EnginePlayer {
  asks(): (['scene', string] | ['fullscreen', boolean])[];
  cancel(): void;
  readonly cursor: string;
  draw(): void;
  readonly duration: number;
  feed(bytes: Uint8Array): void;
  free(): void;
  fullscreen(on: boolean): void;
  hide(hidden: boolean): void;
  key(key: string, ctrl: boolean, alt: boolean, meta: boolean): boolean;
  leave(): void;
  pause(): void;
  pointer(x: number, y: number): void;
  press(x: number, y: number, touch: boolean): boolean;
  release(): boolean;
  resize(width: number, height: number, scale: number): void;
  time: number;
  wake(): number;
  wheel(dx: number, dy: number): boolean;
}

export const MANIMGX_VERSION = '0.1.1';
const FONTS = 24;

/** An engine of one film's own, and the call that lets it go. */
export interface FilmEngine {
  engine: Engine;
  release(): void;
}

/** An engine for one drawn film, in a frame of its own
 * (public/films/engine-frame.html). The engine keeps one GPU device and a
 * WebAssembly heap that only grows for the realm's life (a page-wide engine
 * kept 3.0 GB, 1.7 GB of it GPU, once eight films had gone, bench/manim/
 * reports/2026-11-27-note-films-memory.md); removing the frame gives them
 * back. */
export async function loadEngine(): Promise<FilmEngine> {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = `/films/engine-frame.html?v=${MANIMGX_VERSION}&fonts=${FONTS}`;
  const loaded = new Promise((resolve, reject) => {
    frame.addEventListener('load', resolve, { once: true });
    frame.addEventListener('error', reject, { once: true });
  });
  document.body.append(frame);
  try {
    await loaded;
    const view = frame.contentWindow as
      | (Window & { engine?: Promise<Engine> })
      | null;
    if (!view?.engine) throw new Error('the engine frame did not load');
    return { engine: await view.engine, release: () => frame.remove() };
  } catch (error) {
    frame.remove();
    throw error;
  }
}

/** Whether this browser has WebGPU, which drawn films need. */
export function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}
