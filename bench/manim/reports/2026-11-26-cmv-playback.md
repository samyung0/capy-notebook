# ManimGX playback without simulation: the CMV container, sizes and browser cost (2026-11-26)

Question: can Capy play a ManimGX scene in the browser without running any Python, and what does
each film cost in bytes, fidelity, CPU and memory?

All 48 scenes in ManimGX v0.1.1's `examples/` were exported at 1280×720 and 30 fps on the Mac
(M-series, 8 GB). Raw records are in [`2026-11-26-mac/`](2026-11-26-mac/).

## Names

| Name | Means |
| --- | --- |
| **CMV** | The container: the one file we would store and serve per scene. Both forms below use the same layout. |
| **Drawn film** | A CMV file holding what ManimGX's engine was asked to draw: shapes, surfaces, point clouds and colours uploaded once, then per frame which objects to draw and where. ManimGX's own WebGPU player draws it; it stays sharp at any size. |
| **Video film** | A CMV file holding the film already drawn: every frame of the whole picture as H.264. A video decoder shows it. |
| **Image track** | Inside a drawn film only: H.264 for one picture inside the scene that changes every frame (a heat map, a field plot). |
| **MP4** | The comparison baseline only: one ordinary `.mp4` per scene, not part of CMV. |

The exporter (`scripts/export.py`) makes both forms of every scene and keeps the smaller one.
Picking the smaller is a placeholder rule, still to be signed off; a cap on vertices per frame
would be another rule.

## File layout

```
CMV file
├─ "CMV0"                 4 bytes
├─ header length          u32
├─ header JSON            form (drawn | video), size, fps, frames, precision steps, video tracks
├─ chunk index            per chunk: offset u64, draw bytes u32, video bytes u32,
│                         first frame u32, frames u32   (24 bytes a chunk)
└─ chunks, one per second of film, each self-contained for its second:
   ├─ draw part           zstd frame of draw messages        (drawn films; 0 bytes in video films)
   └─ video part          that second's H.264 segments        (0 bytes when nothing is video)
                          per segment: track, first frame, frame count, frame sizes,
                          then the frames as H.264 access units, the first a keyframe
```

Because every second is self-contained, a page can fetch any second with an HTTP range request
and start playing there. A drawn film's arrays may be coded against the previous second, so a
jump fetches that chunk too.

What goes into each part:

| Part | Holds | Precision |
| --- | --- | --- |
| Draw part: paths | Glyphs, curves, polygons (TeX included) | 1/65,536 of the shape's size |
| Draw part: surfaces and meshes | Surface sample grids (the reader refines them as ManimGX does) and explicit triangle meshes | 1/1,048,576 |
| Draw part: point clouds | Particles, dots | 1/4,096 |
| Draw part: colour rows | Per-vertex or per-cell colours | 1/1,024 |
| Draw part: small images | Images under 256×256, or ones that don't change | Lossless |
| Draw part: frames | Per frame, the view and every object's record (which shape, where, colour, stroke) | Lossless |
| Video part, drawn films | Image tracks: images of at least 256×256 that change every frame, colour and alpha apart | H.264 CRF 23 (alpha CRF 18) |
| Video part, video films | The whole picture, every frame, one track | H.264 CRF 23 |

The rule for what goes to H.264 is simple:

- In a video film, everything does.
- In a drawn film, only image tracks do. Two of 48 scenes have them: Phased array (2.5 MB of
  track) and Menger slice (1.0 MB).

## Results per scene

PSNR is the worst of 30 sampled frames of the chosen form, compared with ManimGX's exact render:

- A drawn film rebuilds the render almost exactly: at least 50 dB, usually 55–75 dB.
- A video film is H.264 at CRF 23: 28–42 dB. That is ordinary video quality, with thin lines and
  text slightly soft.

| Scene | Seconds | Drawn MB | Video MB | Kept | Kept MB | PSNR min (dB) |
| --- | --- | --- | --- | --- | --- | --- |
| Linear maps | 21.1 | 0.20 | 7.93 | **drawn** | 0.20 | 51.1 |
| DLA coral | 31.0 | 0.58 | 12.12 | **drawn** | 0.58 | 60.1 |
| Times tables | 26.7 | 1.72 | 31.14 | **drawn** | 1.72 | 64.1 |
| Rupert cube | 29.3 | 0.09 | 1.20 | **drawn** | 0.09 | 49.7 |
| Hilbert curve | 17.4 | 0.53 | 4.05 | **drawn** | 0.53 | 53.5 |
| Pythagoras | 19.8 | 0.06 | 0.45 | **drawn** | 0.06 | 74.7 |
| Lozenge cubes | 30.8 | 2.65 | 18.92 | **drawn** | 2.65 | 62.5 |
| Quadratic formula | 25.6 | 0.10 | 0.65 | **drawn** | 0.10 | 63.3 |
| Bifurcation Mandelbrot | 29.0 | 0.58 | 3.62 | **drawn** | 0.58 | 57.1 |
| Heavy top | 30.5 | 0.84 | 3.87 | **drawn** | 0.84 | 66.6 |
| Colliding blocks | 27.0 | 0.13 | 0.54 | **drawn** | 0.13 | 71.6 |
| Score diffusion | 30.0 | 2.18 | 8.54 | **drawn** | 2.18 | 59.7 |
| Galton board | 17.2 | 0.25 | 0.87 | **drawn** | 0.25 | 60.0 |
| Derivative | 27.4 | 0.27 | 0.88 | **drawn** | 0.27 | 74.6 |
| Euler identity | 27.2 | 0.27 | 0.82 | **drawn** | 0.27 | 68.1 |
| Riemann sums | 18.3 | 0.22 | 0.60 | **drawn** | 0.22 | 68.4 |
| Miura ori | 30.5 | 1.43 | 3.71 | **drawn** | 1.43 | 54.2 |
| Lagrange points | 29.3 | 0.75 | 1.85 | **drawn** | 0.75 | 50.6 |
| Tennis racket | 29.9 | 0.99 | 2.31 | **drawn** | 0.99 | 65.7 |
| Surface plots | 15.0 | 0.90 | 1.59 | **drawn** | 0.90 | 50.9 |
| Complex maps | 25.3 | 4.67 | 7.62 | **drawn** | 4.67 | 67.1 |
| Hopf fibration | 30.0 | 4.71 | 7.60 | **drawn** | 4.71 | 62.3 |
| Menger slice | 30.0 | 2.64 | 3.94 | **drawn** | 2.64 | 52.5 |
| Fourier π | 25.5 | 2.38 | 2.99 | **drawn** | 2.38 | 75.6 |
| Life spacetime | 29.3 | 2.83 | 3.49 | **drawn** | 2.83 | 64.9 |
| Circle area | 17.9 | 1.04 | 1.26 | **drawn** | 1.04 | 55.8 |
| Unit circle | 17.7 | 0.62 | 0.59 | **video** | 0.59 | 41.9 |
| Harmonic drive | 30.5 | 5.16 | 4.67 | **video** | 4.67 | 37.2 |
| Taylor series | 24.7 | 1.15 | 1.02 | **video** | 1.02 | 37.9 |
| Kuramoto fireflies | 30.2 | 18.47 | 16.31 | **video** | 16.31 | 32.1 |
| Voronoi cones | 29.5 | 3.84 | 3.06 | **video** | 3.06 | 34.4 |
| Sphere packing | 29.1 | 4.75 | 2.96 | **video** | 2.96 | 36.7 |
| Neural untangle | 30.0 | 11.27 | 6.29 | **video** | 6.29 | 35.1 |
| Vortex rings | 30.0 | 52.35 | 29.12 | **video** | 29.12 | 31.2 |
| Cherenkov cone | 29.8 | 9.19 | 4.92 | **video** | 4.92 | 34.7 |
| Taylor poles | 30.0 | 4.04 | 1.49 | **video** | 1.49 | 38.4 |
| Lorenz attractor | 27.0 | 13.54 | 4.94 | **video** | 4.94 | 28.0 |
| Prime spirals | 24.2 | 36.59 | 11.51 | **video** | 11.51 | 29.3 |
| Riemann surfaces | 29.3 | 10.78 | 1.99 | **video** | 1.99 | 39.3 |
| Kaleidoscope sphere | 30.1 | 34.60 | 5.08 | **video** | 5.08 | 31.2 |
| Wave packet | 30.0 | 22.92 | 3.05 | **video** | 3.05 | 35.9 |
| Catenoid helicoid | 29.3 | 13.72 | 1.40 | **video** | 1.40 | 41.0 |
| Sugihara cylinder | 30.0 | 19.99 | 1.71 | **video** | 1.71 | 39.3 |
| Traffic helix | 30.0 | 116.12 | 9.65 | **video** | 9.65 | 30.9 |
| Clifford torus | 30.0 | 82.78 | 5.36 | **video** | 5.36 | 31.3 |
| Phased array | 29.7 | 62.07 | 3.95 | **video** | 3.95 | 36.8 |
| Van Allen | 30.0 | 170.90 | 8.15 | **video** | 8.15 | 32.5 |
| Turing torus | 30.0 | 73.49 | 3.45 | **video** | 3.45 | 34.3 |

In all:

- **What was kept:** 26 drawn films and 22 video films, 164 MB in total, median 1.9 MB per
  scene (about 3.7 MB per minute).
- **If everything were drawn:** 801 MB.
- **If everything were video:** 263 MB, median 3.6 MB.
- **The standalone MP4s:** 203 MB, median 2.4 MB.
- **Why CMV's video costs more than an MP4:** a CMV video film restarts with a keyframe every
  second and has no B-frames, so each second decodes on its own. That costs about 30% over an
  MP4, which can reference frames many seconds back.
- **Which scenes stay drawn:** text, formulas, 2D vector work and light 3D. They are usually 2–40×
  smaller than their video.
- **Which go to video:** particles, dense curves and surfaces that change shape every frame.
  Drawing those re-sends every vertex each frame, about 1–6 MB per second, so they are 1.1–34×
  bigger drawn.

## Real videos

ManimGX's examples are 30-second showcase pieces, so the same export, decode and check also ran
on the scene files of published YouTube videos. The exporter keeps the smaller form, as above.

- **Manim CE videos** were run unchanged through `scripts/ce.py`, which resolves `manim` imports
  to `manimgx` and puts back a few dropped methods (`set_width`, `set_fill_color`, …).
- **3Blue1Brown's videos** are written for ManimGL, so they ran through a stand-in for their
  `manim_imports_ext` (`scripts/manimgl/`) that maps ManimGL's common names onto ManimGX's.
- Run with `scripts/run_files.py`.

| Video | Code | Scenes that ran | Film | Kept | All as video | Forms kept | Worst frame |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Reducible: Traveling Salesman (2022) | CE | 11 of 13 | 122 s | 0.41 MB | 3.17 MB | 11 drawn | 41.1 dB |
| Reducible: JPEG compression (2022) | CE | 12 of 31 | 149 s | 0.47 MB | 3.82 MB | 12 drawn | 38.1 dB |
| Reducible: PageRank (2022) | CE | 9 of 24 | 45 s | 0.19 MB | 1.07 MB | 9 drawn | 65.7 dB |
| xiaoxiae: (a,b)-trees (2023) | CE | 9 of 13 | 218 s | 3.59 MB | 12.84 MB | 8 drawn, 1 video | 37.6 dB (the video one) |
| xiaoxiae: Linear Programming (2023) | CE | 12 of 24 | 53 s | 0.33 MB | 1.16 MB | 11 drawn, 1 video | 39.7 dB (the video one) |
| xiaoxiae: Exploring State Space (2023) | CE | 0 of 16 | — | — | — | — | — |
| 3Blue1Brown: Laplace transform (2025) | ManimGL | 15 of 65 | 35 s | 0.09 MB | 0.48 MB | 14 drawn, 1 video | 54.9 dB |
| 3Blue1Brown: Colliding blocks v2 (2025) | ManimGL | 0 of 15 | — | — | — | — | — |

Across the 68 scenes that ran (10.4 minutes of film):

- **Size:** 5.1 MB kept, about 0.5 MB per minute. As video in CMV they would be 22.5 MB, about
  2.2 MB per minute.
- **Forms:** 65 of the 68 stayed drawn. Explainer videos are mostly text, diagrams and graphs,
  where drawing wins about 4–10×.
- **Fidelity:** drawn films have a median worst frame of 74.6 dB. Four scenes have one sampled
  frame at 38–48 dB, where 0.1–0.2% of the pixels differ; that was not looked into.
- **Stand-in asset:** Reducible's TSP scenes load a background image that isn't in their
  repository, so a plain dark gradient stood in for it.

Why the other 133 scenes didn't run (these are ManimGX compatibility limits, not CMV limits):

| Cause | Scenes |
| --- | --- |
| An image, SVG or data file not in the repository | 28 |
| ManimGL's camera frame (`self.frame`, `set_field_of_view`) or pi creatures | 25 |
| Other ManimGL API differences (`get_graph`, `add_coordinate_labels`, `t2c` splitting, …) | 30 |
| LaTeX that ManimGX can't convert to Typst (`\sc`, `\par`, `\minus`, …) | 18 |
| Subclasses of Manim CE's `Graph` internals | 16 |
| Manim CE's `Code` arguments | 6 |
| Other single API gaps | 10 |

So real Manim CE code mostly runs once assets are present: 53 of 121 scenes ran, and 27 of the
68 that didn't were missing files. 3Blue1Brown's ManimGL code mostly needs porting: only the
short equation overlays ran.

## Playback cost in Chrome (headless, M-series)

CPU seconds per second of film and peak resident memory, for Chrome's renderer and GPU processes
together:

| What plays | Scenes | CPU s per film s | Peak RSS | Frames |
| --- | --- | --- | --- | --- |
| Drawn film: ManimGX's WebGPU player | Derivative, Hopf fibration, Cherenkov cone | 0.36–0.55 | 310–527 MB | No drops; draw call 1.7–9.7 ms median |
| Video film: WebCodecs to a canvas (`film.html`) | Catenoid, Clifford torus, Van Allen, Vortex rings | 0.15–0.31 | 190–300 MB | 0–5 of about 900 missed, all at the start |
| Plain MP4 in a `<video>` element | Derivative, Hopf fibration, Cherenkov cone | 0.09 | 190–210 MB | No drops |

Notes on these numbers:

- The drawn films were played as ManimGX takes rebuilt from their CMV files. ManimGX's web player
  accepts only its own take bytes (`feed(take)`), so shipping drawn films needs either a CMV→take
  step in the page or our own build of the player with a direct upload call.
- Painting video frames onto a canvas ourselves costs 2–3× a `<video>` element, which composites
  them directly. Handing the H.264 segments to Media Source Extensions instead would likely get
  close to the `<video>` number. That is not measured.
- Unpacking drawn films in JavaScript, before they reach the player, costs a median 9 ms per
  film-second. The worst are Surface plots at 241 ms (refining its surfaces) and Bifurcation at
  117 ms. The worst single second took 567 ms, so this belongs in a worker.
- The reader holds at most 108 MB of arrays as coding bases.
- Video films need no JavaScript decoding; their segments are only sliced out.

## Not measured

- Phones and low-end laptops.
- Safari and Firefox. Safari has WebGPU from version 26; Firefox has none by default, so drawn
  films would need a video fallback there.
- Several films playing on one page.
- The CMV→take step for drawn films.
- Media Source Extensions playback of video films.
- Lorenz attractor's drawn form scored only 40 dB; the cause was not looked into, since its
  video form is kept.
