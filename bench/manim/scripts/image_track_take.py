"""What a film's frames would weigh as ManimGX take TEXTURE arrays, against their H.264.

usage: python3 image_track_take.py <film.cmv> [frames]   (needs numpy, zstandard, ffmpeg)

Takes track 0's H.264 from the film's video parts, decodes the first frames to RGBA with ffmpeg
and codes each as Capy's take writer does an image track's frame (src/features/films/take.ts):
the bytewise difference from the frame before (every 5th alone: chains of 4), split into its
four channel planes, zstd level 1. The player keeps every such array for the film's life.
"""

import json
import struct
import subprocess
import sys

import numpy as np
import zstandard


def annexb(path: str) -> tuple[dict, bytes]:
    data = open(path, "rb").read()
    if data[:4] != b"CMV0":
        raise SystemExit("not a CMV file")
    (n,) = struct.unpack_from("<I", data, 4)
    meta = json.loads(data[8 : 8 + n])
    at = 8 + n
    index = [struct.unpack_from("<QIIII", data, at + 24 * i) for i in range(meta["chunks"])]
    body = at + 24 * meta["chunks"]
    out = []
    for offset, draw, video, _first, _frames in index:
        p = body + offset + draw
        end = p + video
        if not video:
            continue
        segments = data[p]
        p += 1
        for _ in range(segments):
            track, _first, count = struct.unpack_from("<III", data, p)
            p += 12
            alpha = meta["tracks"][track].get("alpha")
            sizes = struct.unpack_from(f"<{count * (2 if alpha else 1)}I", data, p)
            p += 4 * len(sizes)
            for i, k in enumerate(sizes):
                if track == 0 and i < count:
                    out.append(data[p : p + k])
                p += k
        assert p == end
    return meta, b"".join(out)


def main() -> None:
    path = sys.argv[1]
    frames = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    meta, stream = annexb(path)
    track = meta["tracks"][0]
    w, h = track["width"], track["height"]
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "h264", "-i", "-", "-frames:v", str(frames), "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
        input=stream, capture_output=True, check=True,
    ).stdout
    n = len(raw) // (w * h * 4)
    z = zstandard.ZstdCompressor(level=1)
    prev, sizes = None, []
    for i in range(n):
        f = np.frombuffer(raw, np.uint8, w * h * 4, i * w * h * 4)
        coded = f if (prev is None or i % 5 == 0) else (f - prev).astype(np.uint8)
        sizes.append(len(z.compress(coded.reshape(-1, 4).T.copy().tobytes())))
        prev = f
    fps = meta["fps"]
    h264 = len(stream) / (meta["frames"] / fps)
    mean = float(np.mean(sizes))
    print(
        f"{path.split('/')[-1]}: {w}x{h}, {n} frames: raw {w * h * 4 / 2**20:.2f} MB a frame; "
        f"as take arrays {mean / 1024:.0f} KB a frame, {mean * fps / 2**20:.1f} MB a second; "
        f"H.264 {h264 / 2**20:.2f} MB a second ({mean * fps / h264:.0f}x)"
    )


if __name__ == "__main__":
    main()
