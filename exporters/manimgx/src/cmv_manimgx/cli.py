"""cmv-manimgx: export a ManimGX scene to a CMV film, or check a film before uploading it.

cmv-manimgx export scene.py [SceneName] -o film.cmv [--form auto|drawn|video] [--ce]
cmv-manimgx validate film.cmv
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

from . import cmv


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(
        prog="cmv-manimgx", description="ManimGX scenes as CMV films."
    )
    sub = ap.add_subparsers(dest="command", required=True)
    ex = sub.add_parser("export", help="run a scene and write its film")
    ex.add_argument("scene", help="the scene file")
    ex.add_argument(
        "name", nargs="?", help="the Scene class (default: the file's first)"
    )
    ex.add_argument("-o", "--out", help="the film to write (default: <SceneName>.cmv)")
    ex.add_argument(
        "--form",
        choices=["auto", "drawn", "video"],
        default="auto",
        help="drawn: what the engine draws; video: H.264 frames; auto: the smaller (default)",
    )
    ex.add_argument(
        "--ce",
        action="store_true",
        help="the file is Manim CE code: its `manim` imports resolve to manimgx",
    )
    ex.add_argument(
        "--path",
        action="append",
        default=[],
        help="another folder the scene imports from",
    )
    ex.add_argument("--take", help="also keep the original ManimGX take here")
    ex.add_argument("--width", type=int, default=1280)
    ex.add_argument("--height", type=int, default=720)
    ex.add_argument("--fps", type=int, default=30)
    ex.add_argument(
        "--crf", type=int, default=23, help="H.264 quality (lower: better, larger)"
    )
    ex.add_argument(
        "--json", action="store_true", help="print the summary as one JSON line"
    )
    va = sub.add_parser(
        "validate", help="check a film's structure, as the server does on upload"
    )
    va.add_argument("film")
    args = ap.parse_args(argv)

    if args.command == "validate":
        try:
            meta = cmv.validate(Path(args.film).read_bytes())
        except cmv.Invalid as e:
            sys.exit(f"invalid: {e}")
        print(
            f"valid: {meta['form']} film, {meta['width']}×{meta['height']}, {meta['frames'] / meta['fps']:.1f} s"
        )
        return

    # refused before rendering: Capy refuses a film past these (cmv.LIMITS)
    if not cmv.fits(args.width, args.height) or not 1 <= args.fps <= cmv.LIMITS["fps"]:
        sys.exit(
            f"films are at most {cmv.LIMITS['long_side']}×{cmv.LIMITS['short_side']}"
            f" (either way round) at {cmv.LIMITS['fps']} fps"
        )
    if args.form != "drawn" and not shutil.which("ffmpeg"):
        sys.exit(
            "ffmpeg is needed for the video form: install it, or pass --form drawn"
        )
    from .export import Settings, export  # imports manimgx: only when exporting

    settings = Settings(
        form=args.form,
        width=args.width,
        height=args.height,
        fps=args.fps,
        crf=args.crf,
        take=args.take,
        paths=args.path,
    )
    out = args.out or f"{args.name or Path(args.scene).stem}.cmv"
    summary = export(
        args.scene,
        str(Path(out).resolve()),
        name=args.name,
        ce=args.ce,
        settings=settings,
    )
    if args.json:
        print(json.dumps(summary))
    else:
        sizes = ", ".join(
            f"{k[:-3]} {v} MB"
            for k, v in summary.items()
            if k in ("drawn_MB", "video_MB")
        )
        print(
            f"{out}: {summary['form']} film, {summary['seconds']} s, {summary['MB']} MB ({sizes})"
        )
