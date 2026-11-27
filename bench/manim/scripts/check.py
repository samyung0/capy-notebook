"""Compare a CMV film with the original take, drawn by ManimGX's own headless player
(`_engine.Replay`): sampled frames, pixel by pixel. A drawn film is compared through the take
decode.py rebuilt from it; a video film by its own decoded frames.

usage: python -I check.py <original.take> <rebuilt.take | video.cmv> [samples]
Prints one JSON line: frames compared, worst and median PSNR, the worst frame's largest
channel difference and its share of pixels off by more than 8 levels (of 255).
"""

import json
import sys
import time
from pathlib import Path

import numpy as np

from cmv_manimgx import cmv  # noqa: E402

from manimgx import _engine  # noqa: E402


class VideoFilm:
    """A video-form CMV film's frames, decoded a chunk at a time."""

    def __init__(self, data: bytes):
        self.data = data
        self.meta, self.chunks, self.body = cmv.read_header(data)
        self.frames, self.cached = self.meta["frames"], (None, None)

    def render(self, f: int) -> bytes:
        c = next(i for i, ch in enumerate(self.chunks) if ch[3] <= f < ch[3] + ch[4])
        if self.cached[0] != c:
            offset, draw, video = self.chunks[c][:3]
            at = self.body + offset + draw
            (_, start, colour, _), = cmv.get_segments(self.data[at : at + video], self.meta["tracks"])
            self.cached = (c, (start, cmv.decode_h264(colour, self.meta["width"], self.meta["height"], False)))
        start, frames = self.cached[1]
        rgb = frames[f - start]
        return np.concatenate([rgb, np.full(rgb.shape[:2] + (1,), 255, np.uint8)], 2).tobytes()


a = _engine.Replay(Path(sys.argv[1]).read_bytes())
second = Path(sys.argv[2]).read_bytes()
b = VideoFilm(second) if second[:4] == cmv.MAGIC else _engine.Replay(second)
samples = int(sys.argv[3]) if len(sys.argv) > 3 else 60
assert a.frames == b.frames, (a.frames, b.frames)
w, h = a.size
frames = sorted(set(np.linspace(0, a.frames - 1, samples).astype(int).tolist()))
psnr, worst, draw = [], None, []
for f in frames:
    t0 = time.perf_counter()
    x = np.frombuffer(a.render(f), np.uint8).reshape(h, w, 4).astype(np.int16)
    draw.append(time.perf_counter() - t0)
    y = np.frombuffer(b.render(f), np.uint8).reshape(h, w, 4).astype(np.int16)
    d = np.abs(x - y)[..., :3]
    mse = float((d.astype(np.float64) ** 2).mean())
    p = 99.0 if mse == 0 else 10 * np.log10(255**2 / mse)
    psnr.append(p)
    if worst is None or p < worst[0]:
        worst = (p, f, int(d.max()), float((d.max(axis=2) > 8).mean()))
print(json.dumps({
    "frames": a.frames, "compared": len(frames),
    "psnr_min": round(min(psnr), 1), "psnr_median": round(float(np.median(psnr)), 1),
    "worst_frame": worst[1], "worst_max_diff": worst[2], "worst_share_over_8": round(worst[3], 5),
    "replay_draw_ms_median": round(float(np.median(draw)) * 1e3, 1),
}))
