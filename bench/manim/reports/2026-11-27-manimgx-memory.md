# Where ManimGX's web player spends memory (2026-11-27)

Question: Menger slice, a 2.5 MB drawn film, takes Chrome from 0.76 GB to about 2.5 GB while it
plays ([2026-11-27-note-films-memory](2026-11-27-note-films-memory.md)). Chrome's memory-infra dump
shows about 400 MB of Metal memory in the GPU process and 200 MB in Blink's buffer partition, but
not what they are. What are they, which part can Capy avoid on its own, and could ManimGX draw
video frames itself, so that one film mixes drawn seconds and full-frame video seconds on
ManimGX's canvas?

Labels: **measured** (in Chrome, this run), **source** (read from ManimGX 0.1.1's source or its
vendored build), **inferred** (worked out from the two, not measured).

## Setup

- The app's dev server with mocks, Chrome 158 headless with WebGPU, the Mac (M-series, 8 GB).
  One film at a time in the file viewer (a 768×432 canvas at 1×), playing from the start.
- `scripts/player/film_gpu_ledger.mjs` (new): before the engine frame loads, it wraps WebGPU's
  `createBuffer`, `createTexture`, `writeBuffer`, `writeTexture` and the player's `feed` and
  `draw` in that frame. Each buffer and texture is booked with its label and size (a texture's
  bytes are width × height × layers × bytes per texel × samples) and taken off the books when
  the garbage collector takes its JavaScript object (a `FinalizationRegistry`). It prints the
  books each second, then runs the collector (`--expose-gc`) and prints them again. `DUMP=1`
  adds Chrome's memory-infra dump, `BASELINE=1` one before the film opens, `SCALE=2` a 2× screen.
  Raw output: `.results/ledger/` (not committed).
- `scripts/image_track_take.py` (new): what a video film's frames would weigh as take TEXTURE
  arrays, coded as `take.ts` codes an image track's frames.
- Films: Menger slice (`menger.cmv`, drawn, 30 s, 3D meshes plus a 720×720 image track with
  alpha) and Hopf fibration (`hopf_fibration.cmv`, drawn, 30 s, meshes, no image track).
- ManimGX source at tag 0.1.1 (`rust/engine/src`: `render.rs`, `project.rs`, `web.rs`), and the
  vendored `public/vendor/manimgx/0.1.1/engine.js`.

## The one thing to know first

**Source:** ManimGX never frees a GPU resource itself. Its vendored `engine.js` imports
`createBuffer`, `createTexture`, `writeBuffer` and `writeTexture` from WebGPU but no `destroy`
at all. A buffer or texture it replaces or forgets stays in GPU memory until V8's garbage
collector happens to take its small JavaScript object, and V8 doesn't know how big the GPU side
is. **Measured:** in one Menger run V8 waited 21 s, with 845 MB of textures waiting.

## Results

### What the engine makes (measured)

| | Menger slice | Hopf fibration |
| --- | --- | --- |
| Take fed to the player | 20.5 MB (16.6 MB of it image-track textures) | 16.6 MB |
| Image textures sent in the take | 203 | 0 |
| Image textures made on the GPU in 25 s | **564**, 1.98 MB each = 1.11 GB | 0 |
| Live image textures, highest | **845 MB** (416 textures, at 20 s) | 0 |
| Store buffers made in 25 s | 70, 192 MB | 43, 219 MB |
| Store buffers in use at the end | 96–104 MB (32 + 32 + 16 + 16 + 8 MB and small) | 113 MB |
| Store buffers live, highest (in use + not yet collected) | 202 MB | 217 MB |
| Render targets and lists (768×432) | 30 MB | 30 MB |
| `writeBuffer` in 25 s | 664 MB | 514 MB |
| `writeTexture` in 25 s | 1.11 GB | 0.1 MB |
| Live GPU resources, highest | **about 1.05 GB** | 240 MB |
| Live GPU resources after a forced collection | 220 MB (while still playing) | 139 MB |
| Engine's WebAssembly memory | 180–254 MB (varies by run) | 193 MB |

The image textures came at 30 a second from 4 s on, and V8 took 441 of them at once at about
21 s (in a 14 s run it had not yet: 240 live, 475 MB).

### Chrome's accounting around it (measured, memory-infra)

| | Before the film | Menger, 14 s in | Menger, collected | Hopf, 25 s in |
| --- | --- | --- | --- | --- |
| GPU: Metal (`gpu/angle/metal`) | 59 MB | 722 MB | 302–458 MB | 160 MB |
| GPU: transfer memory (WebGPU uploads, shared with the page) | under 8 MB | 77.5 MB | 77.5 MB | 77.4 MB |
| Page: Blink's buffer partition | **155 MB** | 197 MB | 197 MB | 197 MB |
| Page: ArrayBuffers | 13 MB | 44 MB | 44 MB | 40 MB |
| Page: V8 heap (main) | 127 MB | 138 MB | 75 MB | 71 MB |
| Page: WebAssembly memory | — | 180 MB (ledger) | 218 MB (ledger) | 193 MB (ledger) |

The WebAssembly memory appears under no memory-infra allocator; it is in the page process's
footprint all the same.

### What the render targets cost per pixel

**Measured** for Menger at 768×432 (331,776 pixels), per drawn pixel:

| Target | Format | Bytes a pixel |
| --- | --- | --- |
| Depth and stencil, 4 samples | depth32float-stencil8 ×4 | 32 |
| Colour, 4 samples | rgba8unorm ×4 | 16 |
| See-through list nodes (one a pixel to start; grows on overflow) | buffer | 16 |
| Frame colour, face colour | rgba8unorm ×2 | 8 |
| 3D base and its depth | rgba8 + depth | 8 |
| List heads, coverage atlas, crossings | buffers, r32float | about 10 |
| **In all** | | **about 90** |

**Measured** at 2×: the player first made its targets at 1536×864, 81 MB before lists and atlas
(the headless window then reported 1× pixels and they were made again at 768×432).

**Source**, made only when a film needs them (Menger and Hopf needed none): lit meshes' light
samples (rgba16float ×4, 32 B a pixel), see-through slabs behind sprites (32 B a pixel), bloom
(about 15 B a pixel), ambient occlusion (about 17 B a pixel), a 2048×2048 depth shadow map per
light (16 MB each) and a 512×512 environment cube (about 17 MB). Samples are 4 in Chrome:
`max_samples` is 8 only with a native-only wgpu feature.

**Inferred:** about 90 B a pixel is 30 MB at 768×432, 120 MB at 1536×864 (a Retina screen at the
same CSS size), and about 600 MB for a full-screen film on a 16-inch Retina screen (3456×1944
drawn). With every 3D extra on, about 185 B a pixel.

### Image tracks as take textures (measured, `image_track_take.py`, first 300 frames)

What each video film here would weigh if its frames went through the take as an image track:

| Film (1280×720) | Take arrays a frame | Take a second | H.264 a second | Ratio |
| --- | --- | --- | --- | --- |
| Catenoid | 55 KB | 1.6 MB | 0.05 MB | 35× |
| Clifford torus | 207 KB | 6.1 MB | 0.17 MB | 36× |
| Cherenkov cone | 418 KB | 12.3 MB | 0.16 MB | 78× |

Menger's own 720×720 track came to 82 KB a frame in the app (16.6 MB for 203 frames).

## Findings

1. **Most of Menger's GPU memory is image textures waiting for the garbage collector.**
   (Measured, with source.) Each image-track frame becomes a new 1.98 MB GPU texture. The
   engine also makes the texture again each time a later frame shows the same image: its
   `Player::has` looks only at images not yet uploaded (`self.images`, which `prepare` empties
   into `image_groups`), so a texture already on the GPU counts as missing. Measured: 564
   textures made from 203 sent. Nothing is destroyed, so they pile up at about 60 MB a second
   until V8 collects: 845 MB at the top. The DRAWN budget (64 MB, `project.rs`) doesn't count
   them either: `Player::held` counts textures only before they are uploaded.
2. **The shape store's GPU buffers double, and the old ones wait for collection.** (Measured,
   with source.) The store keeps seven arrays (vertices, links, indices, paint rows, extras,
   curve points, subpath ranges). Each GPU buffer is a power of two at least as big as its
   array. When an array outgrows its buffer, a new one is made and the whole array is sent
   again; the old one is not destroyed. A repack (a new generation) reuses the same buffers and
   only sends everything again. Both films reach about 100–113 MB in use (32 MB buffers for the
   mesh arrays). With not-yet-collected buffers the top is about 200 MB, and the engine sends
   500–660 MB through `writeBuffer` in 25 s.
3. **The engine's WebAssembly memory is 180–250 MB, and it only grows.** (Measured size; makeup
   inferred from source.) It holds the store's own copy of the arrays (path points twice: as
   f64 and as the GPU's f32), the 32 MB cache of decoded take arrays, a whole second store while
   repacking, a mesh's arrays widened from f32 to f64 as it is made, and each image three times
   over while uploading (decoded, copied, premultiplied). The jumps line up with the store's
   buffer growth (61 → 180 MB as Menger's buffers reached 16–32 MB). WebAssembly memory never
   shrinks, so the high-water mark stays until the frame is removed.
4. **Blink's 200 MB buffer partition is mostly the page, not the film.** (Measured.) It was
   155 MB before the film opened in the dev build; the film adds about 40 MB (not broken down
   further). The 77.5 MB of transfer memory is Chrome's WebGPU upload buffer, grown for the
   engine's large single writes (whole 32 MB arrays); it is shared memory mapped into both the
   page and the GPU process.
5. **What is left after a collection is about 220 MB of GPU memory for Menger and 140 MB for
   Hopf.** (Measured.) That is the store (about 100 MB), images still in use (Menger), and 30 MB
   of targets. For Menger, the GPU process's Metal line after collection (302–458 MB) is up to
   180 MB more than the books plus the 59 MB there before the film (staging, Dawn's own memory,
   resources Dawn has not yet released?); for Hopf it is no more. Not attributed.
6. **Render targets are small at 1× but scale with pixels.** (Measured at 1×; scaled.) About
   90 B a drawn pixel for these films: 30 MB in the file viewer at 1×, 120 MB on a Retina
   screen, about 600 MB full screen on a large Retina screen.

### What Capy can change itself

| Change | Where | Expected saving | Cost |
| --- | --- | --- | --- |
| Cap the drawing buffer at the film's own pixels (1280×720 here) or a pixel budget | `drawnPlayer.ts` (`resize` and the canvas size) | Retina in the viewer: 120 → 80 MB. Full screen: about 600 → 80 MB (inferred) | Vector edges no sharper than the film's own size |
| Export a film with a per-frame image track as a video film | the exporter's form choice (cmv-manimgx) | Menger: the whole drawn player (about 1 GB of GPU at the top, 200 MB of WebAssembly) for a `<video>` | A 3.9 MB file instead of 2.6 MB; no drawn-film captions or chapters |
| Let go of a paused drawn film after a while, as when scrolled away | `FilmView` / `FilmEmbed` (`resumeAt` already reopens it in place) | Everything the film holds, about 350–450 MB at rest (inferred: GPU after collection, WebAssembly and take) | Reopening costs a load |
| Decode image-track frames at the size they are drawn | `film.worker.ts` | Textures and take about ⅓ at 768 px wide (inferred) | Decode again on resize and full screen. Not worth it before the engine fixes below |
| Chain depth, chunk size of the take | `take.ts`, `film.worker.ts` | Little: the take is 16–21 MB in all, about 7 MB between depth 4 and 32. The engine builds shapes only when a frame draws them, so how the take is fed doesn't change GPU memory (source) | — |

Capy can't make the engine destroy what it lets go. The engine frame is Capy's, but destroying
textures from outside would also hit ones still in use.

### What needs ManimGX

In order of what they'd save (inferred from the measurements above):

1. **Destroy what it replaces or evicts**: superseded store buffers, image textures on
   eviction or replacement, list buffers and targets when they are made again (`Buffer::destroy`
   and `Texture::destroy` in wgpu; WebGPU keeps them until work already submitted is done).
   Menger's top would fall from about 1.05 GB of live GPU resources to about 250 MB; Hopf's from
   240 to 140 MB.
2. **Count uploaded textures as held**: `has` and `held` should look at `image_groups` too.
   That ends re-making a texture for each new frame (564 → at most 203 here), and lets the DRAWN
   budget bound them.
3. **Reuse textures**: keep one texture per image size or track and write each frame into it,
   instead of a new one per frame.
4. **Grow the store's buffers less and on the GPU**: grow by less than double (or to fit), copy
   the old buffer on the GPU instead of sending whole arrays again from WebAssembly, and send
   large arrays in pieces, which also keeps Chrome's transfer buffer small. Give WebAssembly
   less to hold: a smaller DRAWN budget on the web, and a repack that doesn't build a whole
   second store beside the first. This lowers the high-water mark that never comes back.
5. **Optionally, fewer samples**: the 4 samples (colour and depth) are 48 of the 90 B a pixel.
   An option to draw meshes without them would let a host trade edges for memory.

## Can ManimGX draw a video frame itself?

**Not in 0.1.1.** (Source.) The take's only image is TEXTURE: a raw RGBA array. The player
keeps it coded for the film's life and turns each one into a new GPU texture. The vendored
build imports neither `copyExternalImageToTexture` nor `importExternalTexture`, and `web.rs`
exports nothing that takes an image or a `VideoFrame`. Capy's worker decodes an image track's
H.264 with WebCodecs, reads it back to RGBA through a 2D canvas, codes it and sends it as
TEXTURE (`film.worker.ts`, `take.ts`).

**What image tracks cost today**: (measured) on the GPU a texture per shown frame (1.98 MB for
Menger's 720×720, 3.5 MB for 1280×720) that waits for the collector, made again per frame as in
finding 1; in the page the coded RGBA kept for the film's life. For real full-frame seconds that
is 1.6–12.3 MB a second against 0.05–0.17 MB of H.264, 35–78 times the size. A minute of
Cherenkov cone as an image track would keep about 740 MB of take in the page (inferred), and on
the GPU about 105 MB a second of new textures until collected. So today a film can't carry
full-frame video seconds on ManimGX's canvas.

**What it would take** (inferred from source):

- **The GPU part is cheap.** wgpu's web backend has `Queue::copy_external_image_to_texture`
  (WebGPU's `copyExternalImageToTexture`), which takes a decoded frame and copies it on the GPU
  into a texture that already exists. Its sources include an ImageBitmap and a video element,
  and a `VideoFrame` too as far as I know (not checked against wgpu 30's source here). One
  texture per track, written each frame, costs 3.5 MB at 1280×720, with no readback to RGBA and
  no copies in WebAssembly. `importExternalTexture` would avoid even that copy, but wgpu has no
  web binding for it that I know of; it would mean calling WebGPU directly and a separate shader
  path.
- **The real work is the time.** The engine draws synchronously when the page calls `draw`.
  It would need a take message saying "track t's frame f" instead of pixels, a hook to ask the
  page for that frame when drawing, and a way to wait when the frame isn't decoded yet. It
  already waits for frames that haven't arrived (`Clock::bound`). Capy would keep a WebCodecs
  decoder per track, a few frames ahead of the playhead; on a seek it decodes from the segment's
  keyframe, and a CMV segment starts with one every second, so that is at most a second's
  frames. The H.264 stays as it is in the file: no RGBA take.
- With that, a film could mix drawn seconds and full-frame video seconds on one canvas. A video
  second would be one image record covering the frame. A film would then hold one texture per
  track, the decoder's few frames, and the H.264 (the file itself), instead of a texture per
  frame and the RGBA take.
- Without changing ManimGX, the only way to mix them is to stack a `<video>` with the canvas and
  switch by the film's clock (`player.time`). But the engine clears its canvas to opaque black,
  so during video seconds Capy would have to hide the canvas, and ManimGX's own controls with it.

## Not measured

- A production build, a real 2× screen (headless reported 1× pixels to the player's resize
  observer), full screen, Safari and Firefox; films with lights, bloom, occlusion or shadows.
- How much of the Metal line left after collection is Dawn's staging or deferred releases.
- The WebAssembly memory's makeup (that needs an instrumented engine build); the 40 MB the film
  adds to Blink's buffer partition.
- Any of the ManimGX changes above; the savings given for them are estimates from this ledger.
