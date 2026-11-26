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
const BASE = `/vendor/manimgx/${MANIMGX_VERSION}/`;
const FONTS = 24;

let loading: Promise<Engine> | null = null;

/** The engine, loaded once per page; a failed load is tried again next time. */
export function loadEngine(): Promise<Engine> {
  loading ??= (async () => {
    const engine = (await import(
      /* @vite-ignore */ `${BASE}engine.js`
    )) as Engine;
    await engine.default({ module_or_path: `${BASE}engine.wasm` });
    const fonts = await Promise.all(
      Array.from({ length: FONTS }, async (_, i) => {
        const response = await fetch(`${BASE}font${i}.ttf`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      })
    );
    await engine.init(fonts);
    return engine;
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Whether this browser has WebGPU, which drawn films need. */
export function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}
