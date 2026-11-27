# Memory of a note holding several films (2026-11-27)

Question: what does a note with several Manim films cost in the browser, and is the memory given
back once the films scroll away?

Setup: the app's dev server with mocks (`VITE_USE_MSW=true`), Chrome 158 headless with WebGPU on
the Mac (M-series, 8 GB), `scripts/player/note_films_run.mjs`. Eight films from ManimGX's
examples, exported with cmv-manimgx at 1280×720 and 30 fps, were put in Biology 101's "Lecture
notes — the cell" through the slash menu's Manim film, at the note's end:

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

Each film was scrolled to and played for 20 s, then the note went back to its top for 45 s (a
film block lets go of its player 30 s after it is more than a screen away), then the page's
garbage collector was run by hand. Memory is macOS's footprint per Chrome process (what Activity
Monitor and Chrome's task manager show), summed, sampled every second. Raw samples:
`.results/note-films-8.jsonl` (not committed). Three runs agreed within about 150 MB.

## Results

| Moment | Films loaded | Chrome total | Page process | GPU process | Engine heap |
| --- | --- | --- | --- | --- | --- |
| The note, no films | 0 | 737 MB | 577 MB | 53 MB | — |
| All eight just put in | 8 | up to 2.2 GB | 1.4 GB | 0.4 GB | 58 MB |
| Menger playing | 3–4 | up to 2.2 GB | 1.2 GB | 0.8 GB | 354 MB |
| Hopf fibration playing | 4–5 | up to 3.4 GB | 1.5 GB | 1.8 GB | 388 MB |
| Video films playing | 3–5 | about 2.0 GB | 1.3–1.4 GB | 0.5 GB | 388 MB |
| Back at the top, 45 s on | 0 | 1.94 GB | 1.33 GB | 0.49 GB | 388 MB |
| After a forced collection | 0 | 1.83 GB | 1.24 GB | 0.48 GB | 388 MB |

The engine heap is ManimGX's WebAssembly memory: one per page, shared by every drawn film.

## Findings

1. **Several players at once are what costs.** A film block loads its player when it comes
   within a screen of view and keeps it 30 s after leaving, so walking a note keeps 3 to 5 films
   loaded. The peak, 3.4 GB, came with the Hopf fibration (a 4.5 MB drawn film) playing beside
   three or four others, most of it in the GPU process. One small film alone added about 310 MB.
2. **About 1.1 GB stays after every film has gone**, even after a forced collection:
   - **Engine heap, 388 MB.** WebAssembly memory only grows. The players are freed
     (`Player.free()`), but the page keeps the heap they grew to until the tab closes.
   - **GPU process, about 430 MB.** The players' WebGPU memory isn't given back once they are
     freed. The engine may not destroy its WebGPU device; that wasn't confirmed.
   - **Page process, about 270 MB more** besides the engine heap. The main thread's JavaScript
     heap is back at its starting size (104 MB), so this is outside it: canvases, media buffers,
     the films' code. Not broken down further.
3. **Video films cost less than drawn ones** while playing, about 2.0 GB total with 3 to 5 loaded
   against 2.2–3.4 GB, as the earlier report found per film.
4. **The note itself is 737 MB in the dev build** before any film. A production build would start
   lower; a film's own cost should be about the same.

## What would bring it down (not done)

- Keep at most one drawn player loaded, or only the films actually on screen, with no screen of
  margin and a short linger for films. The 3–5 players kept loaded are where the peak comes from.
- Give each film its own engine instance (its own WebAssembly heap), dropped with the film, so
  the 388 MB high-water mark goes with it. Each film would then compile and set up the engine and
  its fonts again (not measured).
- Destroy the WebGPU device when a player is freed. That is a ManimGX engine change.

## Not measured

- A production build; phones, Safari and Firefox.
- Scrolling quickly past films, and a note opened, closed and opened again in one tab.
