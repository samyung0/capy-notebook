# ManimGX films without simulation (`bench/manim`)

Measures playing ManimGX scenes in the browser without running Python. Each scene becomes a CMV
file, the container: either a **drawn film** (what the engine drew, played by ManimGX's WebGPU
player) or a **video film** (every frame as H.264), whichever is smaller. Measured: size,
fidelity against ManimGX's exact render, JavaScript decode, and Chrome's CPU and memory while
playing. The exporter and the format are the `cmv-manimgx` package (https://github.com/samyung0/cmv-manim);
findings are in `reports/`.

Needs a Python with the exporter installed (Python 3.13: `uv pip install "cmv-manimgx @ git+https://github.com/samyung0/cmv-manim#subdirectory=manimgx"`,
which brings `manimgx` v0.1.1), ManimGX's `examples/`, `ffmpeg`, Node, and Chrome for the browser runs. Outputs go to the
gitignored `.results/`.

| Script | Does |
| --- | --- |
| `scripts/decode.py <file.cmv> [--take <t>]` | Decodes a film; a drawn film is rebuilt into a take |
| `scripts/check.py <original.take> <rebuilt.take \| video.cmv> [samples]` | Pixel comparison against ManimGX's headless render |
| `scripts/run_all.sh <python> <examples> <out.jsonl> <scene>…` | Export, decode and check each scene, one JSON line each |
| `scripts/run_files.py <python> <out.jsonl> <scene.py>[:<import folder>…] …` | The same for every scene class of other scene files (Manim CE code, run through `cmv-manimgx export --ce`), recording the error of each scene that doesn't run. For 3Blue1Brown's ManimGL files, pass `scripts/manimgl` and then the repository root as import folders |
| `scripts/player/decode_bench.mjs <fzstd> <file.cmv>…` | JavaScript decode time and memory (`cmv.mjs` is the reader) |
| `scripts/player/playback_run.mjs <playwright> chrome <page> <name>…` | Plays a page in Chrome and measures its processes. Pages: `film` (a video film from `.results/cmv/<name>.cmv`, WebCodecs), `playback` (a take from `.results/takes/<name>.take`, ManimGX's WebGPU player), `video` (`.results/takes/<name>.mp4` in a `<video>` element) |
| `scripts/player/note_films_run.mjs <playwright> <base url> <seconds per film> <film>…` | A note holding several films in the app (dev server with mocks): puts the films from `.results/notefilms/<film>.cmv` in a note, plays each in turn, then waits at the top and forces a collection, sampling each Chrome process's macOS footprint and the engine's WebAssembly heap |

The pages need `bench/manim` served on port 8765
(`python3 -m http.server 8765 --directory bench/manim`). The `playback` page also needs
ManimGX's web engine in `.results/web/`: `engine.js`, `engine.wasm` and `font0..23.bin`, from
`manimgx._engine.web()`.
