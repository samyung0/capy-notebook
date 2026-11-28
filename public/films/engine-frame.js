// Loads ManimGX's vendored engine (?v= its version, ?fonts= its font count) in this frame and
// sets window.engine to the promise of it, ready to draw: its WebAssembly up, its GPU up and
// its fonts taken (src/features/films/engine.ts).
const query = new URLSearchParams(location.search);
const base = `/vendor/manimgx/${query.get('v')}/`;

window.engine = (async () => {
  const engine = await import(`${base}engine.js`);
  await engine.default({ module_or_path: `${base}engine.wasm` });
  const fonts = await Promise.all(
    Array.from({ length: Number(query.get('fonts')) }, async (_, i) => {
      const response = await fetch(`${base}font${i}.ttf`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    })
  );
  await engine.init(fonts);
  return engine;
})();
