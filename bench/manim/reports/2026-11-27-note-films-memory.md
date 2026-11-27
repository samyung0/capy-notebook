# Memory of a note holding several films (2026-11-27)

Question: what does a note with several Manim films cost in the browser, and is the memory given
back once the films scroll away?

Setup: the app's dev server with mocks (`VITE_USE_MSW=true`), Chrome 158 headless with WebGPU on
the Mac (M-series, 8 GB), `scripts/player/note_films_run.mjs`. Eight films from ManimGX's
examples, exported with cmv-manimgx at 1280×720 and 30 fps, were put in Biology 101's "Lecture
notes — the cell" through the slash menu's Manim film, one after another below its "Organelle
overview" heading:

| Film | Form | Size |
| --- | --- | --- |
| Euler identity | drawn | 0.25 MB |
| Derivative | drawn | 0.26 MB |
| Circle area | drawn | 0.99 MB |
| Menger slice | drawn | 2.52 MB |
| Hopf fibration | drawn | 4.50 MB |
| Catenoid | video | 1.34 MB |
| Cherenkov cone | video | 4.69 MB |
| Clifford torus | video | 5.12 MB |

Each film was scrolled to the middle of the screen and played for 20 s. The note then went back
to its top for 45 s, and the page's garbage collector was run by hand. Memory is macOS's
footprint per Chrome process (what Activity Monitor and Chrome's task manager show), summed and
sampled every second. Raw samples are in `.results/note-films-8-{before,after}.jsonl` (not
committed).

## Before and after

**Before:** every film shares the page's one engine, and a film block keeps its player from a
screen away until 30 s after it leaves.

**After:** each drawn film gets its own engine in a hidden frame that is removed with the film
(`public/films/engine-frame.html`, `loadEngine`). A film block keeps its player only while it is
on screen and lets go 3 s after leaving; scrolled back to, the film opens where it was, paused.

| | Before | After |
| --- | --- | --- |
| The note, no films | 766 MB | 758 MB |
| Most films loaded at once | 8 | 4 |
| Peak while playing | 3.30 GB | 3.00 GB |
| Back at the top, 45 s on | 3.11 GB | 1.48 GB |
| After a forced collection | **3.01 GB** | **1.23 GB** |
| … of it, the GPU process | 1.71 GB | 62 MB |
| … engine heaps left | 381 MB | none |

## Findings

1. **The drawn films themselves are what peaks.** Menger slice, a 2.5 MB drawn film, takes about
   1.5 GB of GPU memory on its own while it plays, 2.5 GB in all. The Hopf fibration and the
   others add hundreds of MB each. That is ManimGX's engine drawing them; loading fewer players
   at once moved the peak only from 3.3 to 3.0 GB.
2. **The page-wide engine never gave memory back.** With every film gone, 3.0 GB stayed: the
   engine's one GPU device kept 1.7 GB, and its WebAssembly heap, which only grows, kept 381 MB.
   An engine per film, removed with the film, gives both back. The GPU process returns to its
   starting size.
3. **About 470 MB still stays in the page process** after the films have gone and memory has been
   collected (1.06 GB against 0.58 GB). The main thread's JavaScript heap is back at its starting
   size, so this is outside it: memory Chrome keeps for reuse, media buffers, the films' code. Not
   broken down further.
4. **The note itself is about 760 MB in the dev build** before any film. A production build would
   start lower; a film's own cost should be about the same.

## Where one film's memory goes

Chrome's memory-infra dump with Menger slice playing for 20 s in the file viewer
(`scripts/player/film_memory_dump.mjs`):

| Process | Allocator | Size |
| --- | --- | --- |
| GPU | Metal resources (`gpu/angle/metal`): ManimGX's buffers and render targets | 390–425 MB |
| GPU | Driver memory (`ioaccelerator`), likely overlapping the line above | 400–440 MB |
| GPU | Transfer memory (WebGPU uploads) | 80 MB |
| Page | ArrayBuffers (`partition_alloc/array_buffer`) | 272 MB, **45 MB** with the fix below |
| Page | Blink's buffer partition | 195–200 MB |
| Page | Mapped GPU memory | 70 MB |
| Page | V8 heap | 72 MB |

Most of the ArrayBuffers were the conversion worker's: it keeps each array's last full version to
code the next against, and stayed alive until the film unloaded. It now ends once it has posted
its last chunk (or a video film's MP4). The dump doesn't break the Metal line down, so how much
is ManimGX's shape store (arrays that only grow until more than half is dead,
`rust/engine/src/render.rs`) against its render targets is not known.

## Not measured

- A production build; phones, Safari and Firefox.
- What the frame costs each film when it opens (a WebAssembly instance from the browser's cache,
  24 fonts, a GPU device); scrolling quickly past films.
