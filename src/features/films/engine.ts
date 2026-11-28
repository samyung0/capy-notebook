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

/** An object the scene's author tagged with `interactive(…)`: what its
 * viewer may do to it. */
export interface FilmObject {
  /** A polyline it only moves along. */
  along?: Point[];
  /** Seconds of the frame a values object's stops stand for. */
  at?: number;
  /** Tagged objects posed with it, rigidly. */
  followers?: number[];
  /** The leader a follower moves with. */
  follows?: number;
  /** Where its viewer grabs a values object, one per stop. */
  handles?: Point[];
  id: number;
  label: string;
  move: boolean;
  /** The scene point it turns and scales about. */
  pivot?: Point;
  rotate: boolean;
  scale: boolean;
  /** Scene units it snaps to. */
  snap?: number;
  /** Degrees it turns in. */
  step?: number;
  /** Where its viewer is asked to put it, `tolerance` near. */
  target?: Point;
  tolerance?: number;
  /** The tracker's value in the film's own frame. */
  value?: number;
  /** A values object's stops: a frame drawn for each. */
  values?: number[];
  /** A rectangle [x0, y0, x1, y1] it stays inside. */
  within?: [number, number, number, number];
}

/** A point of the scene, in its units. */
export type Point = [number, number, number];

export interface EnginePlayer {
  asks(): (['scene', string] | ['fullscreen', boolean])[];
  /** Object `id`'s posed bounds in the frame shown, [x0, y0, x1, y1] in canvas
   * pixels; none when it isn't in that frame. */
  bounds(id: number): number[] | undefined;
  cancel(): void;
  readonly cursor: string;
  draw(): void;
  readonly duration: number;
  /** Shows ManimGX's own controls, or not: Capy draws its own. */
  face(show: boolean): void;
  feed(bytes: Uint8Array): void;
  free(): void;
  fullscreen(on: boolean): void;
  hide(hidden: boolean): void;
  /** Whether the frame shown is a 3D view's. */
  is3d(): boolean;
  key(key: string, ctrl: boolean, alt: boolean, meta: boolean): boolean;
  leave(): void;
  /** The tagged objects drawn in the frame shown. */
  objects(): FilmObject[];
  /** The viewer's turn of a 3D view (radians), on the scene's own camera. */
  orbit(yaw: number, pitch: number): void;
  pause(): void;
  /** The topmost tagged object at (x, y) canvas pixels. */
  pick(x: number, y: number): number | undefined;
  play(): void;
  readonly playing: boolean;
  pointer(x: number, y: number): void;
  /** Holds object `id` moved by (dx, dy) canvas pixels, turned by `angle`
   * radians and scaled by `scale` about its centre, until `reset()`. */
  pose(
    id: number,
    dx: number,
    dy: number,
    angle: number,
    scale: number
  ): boolean;
  press(x: number, y: number, touch: boolean): boolean;
  /** Its clock's rate: 1 plays at the film's own speed. */
  rate: number;
  release(): boolean;
  /** Lets every pose go. */
  reset(): void;
  /** Lets the viewer's turn and zoom of a 3D view go. */
  resetView(): void;
  resize(width: number, height: number, scale: number): void;
  /** Turns a tagged 3D object as a trackball does, by a drag of (dx, dy)
   * canvas pixels since the last call. */
  spin(id: number, dx: number, dy: number): boolean;
  /** Shows a values object's stop `index` instead of the film's frame;
   * none: the film's frame. Until `reset()`. */
  stop(id: number, index?: number): boolean;
  /** Shows the film as on paper (light ground, dark ink), or as made. */
  theme(paper: boolean): void;
  time: number;
  /** Scene point → canvas pixels, through the frame shown's camera. */
  toCanvas(x: number, y: number, z?: number): Float32Array | undefined;
  /** Canvas pixels → scene point on the plane at height `z`. */
  toScene(x: number, y: number, z?: number): Float32Array | undefined;
  /** Turns a tagged object about the world's x, y or z axis (0, 1, 2). */
  turn(id: number, axis: 0 | 1 | 2, angle: number): boolean;
  wake(): number;
  wheel(dx: number, dy: number): boolean;
  /** The viewer's zoom of a 3D view, `factor` times closer. */
  zoom(factor: number): void;
}

export const MANIMGX_VERSION = '0.1.1-capy.2';
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
