# Films

A film is a ManimGX scene (https://github.com/academa-labs/manimgx, Manim CE's
API) that the user rendered on their own computer and uploaded as a `.cmv`
file. Capy runs no scene code anywhere: the user runs the exporter, the server
checks the file's structure, and the browser plays it (Epo 2026-11-26). Files
written for ManimGL (`from manimlib import *`) don't run on ManimGX; a ManimGL
exporter is queued in `todo-queue.md`.

## The pieces

| Piece | Where | Does |
| --- | --- | --- |
| Exporter | `exporters/manimgx` (`cmv-manimgx`, Python, MIT) | Runs a scene with ManimGX 0.1.1, writes both forms and keeps the smaller; `cmv-manimgx validate` runs the server's check. To be published as its own repository. |
| Check | `server/internal/cmvfile` | Header, chunk index and video framing only; under a millisecond on a 2.6 MB film. Mirrors `cmv.validate` in the exporter. |
| Upload | `sourceupload` kind `film` (`.cmv`), `checkSourceBytes` | A refused film is a 400 `invalid_film` with the reason. Stored only: no ingest job, ready at once, counted in quota like any file. Drive imports refuse a film (`unsupported_file`): the import worker runs no film check. |
| Viewer | `src/features/films` (`FilmView`, from `FileViewer`) | A worker reads the film; video films play in `<video>`, drawn films on ManimGX's player. |
| Engine | `public/vendor/manimgx/0.1.1/` | ManimGX's web player (wasm-bindgen JS, 1.9 MB WebAssembly) and its 24 fonts, as its Pyodide wheel builds them (`THIRD-PARTY-NOTICES.md`). Loaded only when a drawn film opens. |

## The file

`exporters/manimgx/src/cmv_manimgx/cmv.py` describes the format. In short:
`CMV0`, the header (JSON: `cmv` 1, `form`, size, fps, frames, chunks, tracks;
a drawn film also its quantization steps and `engine` {`manimgx`, version,
take 1}), an index of one-second chunks, then the chunks. A chunk holds a
zstd draw part (drawn films) and a video part (H.264 Annex-B segments, each
led by a keyframe).

- **Video film**: every frame as H.264. The worker moves the units into an
  MP4 (`mp4.ts`, no decoding) for the page's own `<video>` and its controls.
- **Drawn film**: what the engine was asked to draw. The worker decodes each
  chunk (`cmv.ts`, surfaces refined as ManimGX does in `surface.ts`) and writes
  it as ManimGX take messages (`take.ts`), which the player is fed a chunk at
  a time and draws with WebGPU, with its own controls, captions and keys. An
  image track (an image of 65,536 px or more that changes every frame) is
  decoded with WebCodecs in the worker. Without WebGPU the viewer says so.

## The take writer

The player keeps every array it is sent (coded, outside WebAssembly memory)
and decodes a chain of differences when a frame needs it. The writer codes an
array against the one it replaces where the film did, compresses with zstd
level 1 (`@bokuweb/zstd-wasm`), and cuts chains at 4 versions: on the menger
example that made seeks ten times faster and the worst draw a third, for a
20 MB take instead of 13 (`take.ts`). Takes the writer makes draw pixel for
pixel as the Python decoder's do (`bench/manim/scripts/check.py`, derivative
and menger).

## Limits

The check refuses a film (or image track) past 1080p either way round (long
side 1920, short side 1080) or 60 fps (Epo 2026-11-27), and one past 16 tracks, a 64 KiB header
or a chunk whose draw part inflates past 64 MiB (`cmvfile` and `cmv.py`, the
same numbers). Per-file size caps are the plan's, as for any upload.

Measurements, both forms on 48 examples and 68 real scenes, and playback cost:
`bench/manim/reports/2026-11-26-cmv-playback.md`.
