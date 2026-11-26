# cmv-manimgx

Turn a [ManimGX](https://github.com/academa-labs/manimgx) scene into a CMV film: one file that
Capy plays in the browser without running any Python. You run the exporter on your own
computer, then upload the `.cmv` file.

A film takes one of two forms, and by default the exporter makes both and keeps the smaller:

- **drawn**: what ManimGX's engine was asked to draw (shapes, text, surfaces, colours). It stays
  sharp at any size. It is usually the smaller form for text, formulas, diagrams and graphs.
- **video**: every frame as H.264. It is usually smaller for particles and surfaces that change
  shape every frame.

## Install

Python 3.11 or newer, and `ffmpeg` on your `PATH` (for the video form):

```bash
pip install ./exporters/manimgx
```

## Use

```bash
cmv-manimgx export scene.py MyScene -o my-scene.cmv
```

- `MyScene` is the Scene class to render; without it, the file's first.
- `--form drawn` or `--form video` keeps one form instead of the smaller.
- `--ce` runs a file written for Manim CE (`from manim import *`) unchanged. ManimGX has Manim
  CE's API, and this resolves the `manim` imports to `manimgx`. Code that uses more of CE than
  ManimGX has still fails.
- `--width`, `--height` and `--fps` set the film's size (default 1280×720 at 30 fps); `--crf`
  sets the H.264 quality (default 23; lower is better and larger).

Check a film before uploading it, with the same structure check the server runs:

```bash
cmv-manimgx validate my-scene.cmv
```

Files written for ManimGL (`from manimlib import *`, such as 3Blue1Brown's) don't run on ManimGX.

The file format is described in `src/cmv_manimgx/cmv.py`.
