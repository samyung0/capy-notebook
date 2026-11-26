"""Read a CMV film back (see cmv.py). Drawn form: into the engine's calls, with --take written
as a ManimGX take that its player (or `_engine.Replay`) draws; without, only decoded and timed.
Video form: its segments decoded and timed (check.py compares its frames directly).

usage: python -I decode.py <in.cmv> [--take out.take]
Prints one JSON line: decode time, frames, messages by kind.
"""

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

import numpy as np
import zstandard

from cmv_manimgx import cmv  # noqa: E402

from manimgx import _engine  # noqa: E402
from manimgx.rendering import feed  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("cmv")
ap.add_argument("--take")
args = ap.parse_args()

data = Path(args.cmv).read_bytes()
meta, chunks, body = cmv.read_header(data)
Q = meta["q"]


class Null:
    def __getattr__(self, name):
        return lambda *a, **k: None


drawn = meta["form"] == "drawn"
rec = _engine.Recorder(meta["width"], meta["height"], meta["fps"]) if args.take and drawn else Null()
take_out = open(args.take, "wb") if args.take and drawn else None
tracks = meta["tracks"]
shown: dict[int, tuple[int, np.ndarray, np.ndarray | None]] = {}  # track -> this chunk's (first, colour, alpha)

arrays: dict[tuple[int, int], np.ndarray] = {}
parent: dict[tuple[int, int], tuple[int, int] | None] = {}
written: dict[tuple[int, int], int] = {}
counts = Counter()
prev_records = prev_records2 = prev_view = prev_view2 = None
dz = zstandard.ZstdDecompressor()
t_decode = 0.0
t0_all = time.perf_counter()


def array(inp: cmv.In, kid: int, role: int, points: bool) -> np.ndarray:
    coding = inp.u8()
    base_ref = base2_ref = None
    if coding != cmv.ALONE:
        base_ref = (inp.u32(), role)
        if coding == cmv.SECOND:
            base2_ref = (inp.u32(), role)
    r = cmv.get_ints(inp)
    q = cmv.uncode(coding, r, arrays.get(base_ref), arrays.get(base2_ref), points)
    ref = (kid, role)
    arrays[ref], parent[ref] = q, (base_ref if coding != cmv.ALONE else None)
    written[ref] = chunk_index
    if base2_ref and base2_ref in arrays:
        arrays.pop(parent.get(base2_ref) or (0, 0), None)
    return q


def records(inp: cmv.In, base=None, base2=None) -> tuple[bytes, np.ndarray]:
    coding = inp.u8()
    q = cmv.uncode(coding, cmv.get_ints(inp), base, base2, False)
    n = len(q)
    out = np.empty((n, cmv.RECORD_BYTES), np.uint8)
    out[:, :56] = np.ascontiguousarray(q[:, :7], "<u8").view(np.uint8).reshape(n, 56)
    out[:, 56:64] = np.ascontiguousarray(q[:, 7:9], "<i4").view(np.uint8).reshape(n, 8)
    out[:, 64:] = np.ascontiguousarray(cmv.unordered(np.ascontiguousarray(q[:, 9:]))).view(np.uint8).reshape(n, 272)
    return out.tobytes(), q


def f8(q, step) -> bytes:
    return np.ascontiguousarray(q / step, "<f8").tobytes()


for chunk_index, (offset, draw, video, first, nframes) in enumerate(chunks):
    cmv.forget(arrays, parent, written, chunk_index)
    t0 = time.perf_counter()
    at = body + offset
    for track, start, colour, alpha in cmv.get_segments(data[at + draw : at + draw + video], tracks):
        t = tracks[track]
        shown[track] = (start, cmv.decode_h264(colour, t["width"], t["height"], False),
                        cmv.decode_h264(alpha, t["width"], t["height"], True) if alpha else None)
    inp = cmv.In(dz.decompress(data[at : at + draw]) if draw else b"")
    while not inp.done():
        op = inp.u8()
        counts[op] += 1
        if op == cmv.PATH:
            kid = inp.u32()
            ca = inp.f32s(6)
            p = array(inp, kid, 0, True)
            s = array(inp, kid, 1, False)
            rec.add_path(kid, f8(p, Q["geometry"]), np.ascontiguousarray(s, "<u4").tobytes(), list(ca))
        elif op == cmv.GROW:
            kid, closed = inp.u32(), inp.u8()
            p = np.cumsum(cmv.get_ints(inp), axis=0)
            rec.grow_path(kid, f8(p, Q["geometry"]), bool(closed))
        elif op == cmv.POINTS:
            kid = inp.u32()
            v = array(inp, kid, 0, True)
            rec.add_points(kid, np.ascontiguousarray(v / Q["points"], "<f4").tobytes())
        elif op == cmv.MESH:
            kid, outline, block = inp.u32(), inp.u32(), inp.u32()
            p = array(inp, kid, 0, True)
            uv = array(inp, kid, 1, False)
            nrm = array(inp, kid, 2, False)
            tri = array(inp, kid, 3, False)
            rec.add_mesh(kid, f8(p, Q["surface"]), f8(uv, Q["uv"]), f8(nrm, Q["normals"]) if len(nrm) else b"",
                         np.ascontiguousarray(tri, "<u4").tobytes(), outline, block)
        elif op == cmv.GRID:
            kid = inp.u32()
            u, v, first_face, end_face, steps = (inp.u32() for _ in range(5))
            g = array(inp, kid, 0, True) / Q["surface"]
            uv = array(inp, kid, 1, False) / Q["uv"]
            # as the feeder refines a lattice (feed.Feeder.mesh)
            grid = np.hstack([g, uv]).reshape(u + 1, v + 1, -1)
            points, normals, faces, blk = feed.refine_surface(grid, steps)
            drawn = slice(first_face * blk, end_face * blk)
            per = len(faces) // (u * v)
            faces = faces[first_face * per : end_face * per] - first_face * blk
            points, normals = points[drawn], normals[drawn]
            rec.add_mesh(kid, np.ascontiguousarray(points[:, :3], "<f8").tobytes(), np.ascontiguousarray(points[:, 3:], "<f8").tobytes(),
                         np.ascontiguousarray(normals, "<f8").tobytes(), faces.astype("<u4").tobytes(), 4 * steps + 1, blk)
        elif op == cmv.ROWS:
            kid = inp.u32()
            k = inp.u32()
            r = np.repeat(array(inp, kid, 0, False), k, axis=0)
            rec.add_rows(kid, np.ascontiguousarray(r / Q["rows"], "<f4").tobytes())
        elif op == cmv.TEXTURE:
            kid, w, h = inp.u32(), inp.u32(), inp.u32()
            px = array(inp, kid, 0, False)
            rec.add_texture(kid, w, h, px.astype(np.uint8).tobytes())
        elif op == cmv.VIDEO_FRAME:
            kid, track, index = inp.u32(), inp.u32(), inp.u32()
            start, rgb, alpha = shown[track]
            w, h = tracks[track]["width"], tracks[track]["height"]
            rec.add_texture(kid, w, h, np.concatenate([rgb[index - start], alpha[index - start]], 2).tobytes())
        elif op == cmv.ENVIRONMENT:
            eid, w, h = inp.u32(), inp.u32(), inp.u32()
            rec.add_environment(eid, w, h, bytes(inp.bytes_()))
        elif op == cmv.FRAME:
            repeat = inp.u32()
            coding = inp.u8()
            vq = cmv.uncode(coding, cmv.get_ints(inp), prev_view, prev_view2, False)
            prev_view2, prev_view = prev_view, vq
            view = cmv.unordered(vq[0]).tobytes()
            recs, q = records(inp, prev_records, prev_records2)
            prev_records2, prev_records = prev_records, q
            cams = []
            for _ in range(inp.u32()):
                cid, w, h = inp.u32(), inp.u32(), inp.u32()
                cview = bytes(inp.bytes_())
                cams.append((cid, w, h, cview, records(inp)[0]))
            rec.frame(view, recs, repeat, cams)
        elif op == cmv.NOTE:
            rec.note(bytes(inp.bytes_()).decode())
        elif op == cmv.SOUND:
            rec.sound(bytes(inp.bytes_()))
        elif op == cmv.END:
            rec.end(bool(inp.u8()))
        else:
            raise ValueError(f"unknown op {op}")
    t_decode += time.perf_counter() - t0
    if take_out:
        take_out.write(rec.drain())
if take_out:
    take_out.write(rec.drain())
    take_out.close()
names = {v: k for k, v in vars(cmv).items() if isinstance(v, int) and k.isupper() and k not in ("RECORD_BYTES", "KEY_FIELDS", "ALONE", "FIRST", "SECOND", "TAIL", "RAW")}
print(json.dumps({"cmv": Path(args.cmv).name, "form": meta["form"], "frames": meta["frames"], "seconds": round(meta["frames"] / meta["fps"], 1),
                  "decode_s": round(t_decode, 3), "decode_ms_per_video_s": round(t_decode / (meta["frames"] / meta["fps"]) * 1e3, 1),
                  "messages": {names.get(k, k): v for k, v in counts.most_common()}}))
