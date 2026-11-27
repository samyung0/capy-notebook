"""Export a ManimGX scene to a CMV film (see cmv.py), drawn or video.

The scene runs as `render(take=…)` runs it, with the take's recorder replaced by ours: every
upload and frame the feeder hands it is encoded into the drawn form, while the real recorder
writes the original take beside it. The video form is that take drawn by ManimGX's headless
player, every frame as H.264.

    form="drawn"   the drawn form
    form="video"   the video form
    form="auto"    both, and the smaller is kept
"""

import importlib.metadata
import importlib.util
import os
import sys
import tempfile
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import manimgx as m
import numpy as np
import zstandard
from manimgx import _engine
from manimgx.config import config
from manimgx.drawing.geometry import Lattice
from manimgx.rendering import feed
from manimgx.rendering import film as film_module

from . import cmv


@dataclass
class Settings:
    form: str = "auto"  # drawn | video | auto
    width: int = 1280
    height: int = 720
    fps: int = 30
    crf: int = (
        23  # H.264 quality of video films and image tracks (lower: better, larger)
    )
    level: int = 9  # zstd level of draw parts
    q_geometry: float = 65536.0  # steps per unit: paths
    q_surface: float = 1048576.0  # surfaces and meshes
    q_points: float = 4096.0  # point clouds
    q_rows: float = 1024.0  # colour rows
    video_min_pixels: int = (
        65536  # images this large that change every frame become a track
    )
    take: str | None = (
        None  # where the original take is written (a temporary file if None)
    )
    paths: list[str] = field(
        default_factory=list
    )  # more folders the scene imports from


S = Settings()
Q: dict = {}
Z = zstandard.ZstdCompressor()

# the object being recorded, and which of its uploads this is (its role), for bases
CUR = {"id": None, "roles": Counter(), "lattice": None}
o_make, o_mesh = feed.Feeder.make_record, feed.Feeder.mesh


def make_record(self, mob, *a, **k):
    CUR["id"], CUR["roles"] = id(mob), Counter()
    try:
        return o_make(self, mob, *a, **k)
    finally:
        CUR["id"] = None


def mesh(self, shape, topology, uvs, steps=0):
    lattice = topology if isinstance(topology, Lattice) else None
    CUR["lattice"] = (shape, lattice, uvs, steps) if lattice is not None else None
    try:
        return o_mesh(self, shape, topology, uvs, steps)
    finally:
        CUR["lattice"] = None


def repeat(q: np.ndarray) -> int:
    """How many times each row repeats in place (a lattice's cell rows, one per refined vertex)."""
    if len(q) < 2:
        return 1
    change = np.flatnonzero(np.any(q[1:] != q[:-1], axis=1)) + 1
    k = int(np.gcd.reduce(np.diff(np.r_[0, change, len(q)])))
    return k if k > 1 and np.array_equal(np.repeat(q[::k], k, axis=0), q) else 1


class Video:
    """An image that changes every frame: its frames for the chunk being written, then encoded
    as that chunk's segment (colour and alpha apart)."""

    def __init__(self, w: int, h: int):
        self.w, self.h, self.frames = w, h, 0
        self.first, self.colour, self.alpha = 0, [], []

    def add(self, rgba: np.ndarray):
        self.colour.append(np.ascontiguousarray(rgba[..., :3]).tobytes())
        self.alpha.append(np.ascontiguousarray(rgba[..., 3]).tobytes())
        self.frames += 1

    def segment(self, out: cmv.Out, track: int):
        colour = cmv.h264(b"".join(self.colour), self.w, self.h, "rgb24", S.crf, S.fps)
        alpha = cmv.h264(b"".join(self.alpha), self.w, self.h, "gray", 18, S.fps)
        cmv.put_segment(out, track, self.first, colour, alpha)
        self.first, self.colour, self.alpha = self.frames, [], []


class Exporter:
    """Stands in for `_engine.Recorder`: the same calls, encoded into CMV."""

    def __init__(self, width, height, fps):
        self.real = REAL(width, height, fps)
        self.meta = {
            "cmv": cmv.VERSION,
            "width": width,
            "height": height,
            "fps": float(fps),
        }
        self.ids: dict[int, int] = {}
        self.arrays: dict[
            tuple[int, int], np.ndarray
        ] = {}  # (key id, role) -> quantized ints
        self.parent: dict[tuple[int, int], tuple[int, int] | None] = {}
        self.written: dict[
            tuple[int, int], int
        ] = {}  # (key id, role) -> chunk it was written in
        self.slots: dict[
            tuple, tuple[int, int]
        ] = {}  # (object, op, role) -> its last array
        self.out = cmv.Out()
        self.chunks: list[
            tuple[bytes, bytes, int, int]
        ] = []  # draw part, video part, first frame, frames
        self.frames = self.chunk_first = 0
        self.prev_records = self.prev_records2 = None
        self.prev_view = self.prev_view2 = None
        self.raw = Counter()  # uncompressed bytes per part
        self.videos: dict[tuple, Video] = {}
        self.video_list: list[Video] = []
        self.encode_s = 0.0

    # ── helpers ──
    def id(self, key: int) -> int:
        if key == 0:
            return 0
        if key not in self.ids:
            self.ids[key] = len(self.ids) + 1
        return self.ids[key]

    def slot(self, op: int) -> tuple | None:
        if CUR["id"] is None:
            return None
        CUR["roles"][op] += 1
        return (CUR["id"], op, CUR["roles"][op])

    def array(self, part: str, kid: int, role: int, q: np.ndarray, slot, points: bool):
        """Write one array, coded against the same object's last array in this role."""
        base_ref = self.slots.get(slot + (role,)) if slot is not None else None
        base = self.arrays.get(base_ref) if base_ref else None
        base2_ref = self.parent.get(base_ref) if base_ref else None
        base2 = self.arrays.get(base2_ref) if base2_ref else None
        coding, r = cmv.code(q, base, base2, points)
        if np.abs(r).max(initial=0) >= 2**31:
            raise OverflowError(
                f"{part}: a value does not fit 32 bits; lower its precision"
            )
        start = len(self.out.parts)
        self.out.u8(coding)
        if coding != cmv.ALONE:
            self.out.u32(base_ref[0])
            if coding == cmv.SECOND:
                self.out.u32(base2_ref[0])
        cmv.put_ints(self.out, r)
        self.raw[part] += sum(len(p) for p in self.out.parts[start:])
        ref = (kid, role)
        self.arrays[ref], self.parent[ref] = (
            q,
            (base_ref if coding != cmv.ALONE else None),
        )
        self.written[ref] = len(self.chunks)
        if base2_ref and base2_ref in self.arrays and coding != cmv.ALONE:
            self.arrays.pop(
                self.parent.get(base2_ref) or (0, 0), None
            )  # three back: no longer a base
        if slot is not None:
            self.slots[slot + (role,)] = ref

    def roll(self):
        """A second's frames written: the next call starts a chunk (so the END stays in the last)."""
        if self.frames - self.chunk_first >= S.fps:
            self.flush()

    def flush(self):
        if not self.out.parts:
            return
        data = self.out.getvalue()
        video = cmv.Out()
        due = [(n, v) for n, v in enumerate(self.video_list) if v.colour]
        if due:
            video.u8(len(due))
            for n, v in due:
                v.segment(video, n)
        self.chunks.append(
            (
                Z.compress(data),
                video.getvalue(),
                self.chunk_first,
                self.frames - self.chunk_first,
            )
        )
        self.chunk_first, self.out = self.frames, cmv.Out()
        cmv.forget(self.arrays, self.parent, self.written, len(self.chunks))

    def timed(fn):
        def wrapper(self, *a, **k):
            t0 = time.perf_counter()
            try:
                return fn(self, *a, **k)
            finally:
                self.encode_s += time.perf_counter() - t0

        return wrapper

    # ── the recorder's calls ──
    @timed
    def add_path(self, key, points, subpaths, centroid_area):
        self.roll()
        if self.real:
            self.real.add_path(key, points, subpaths, centroid_area)
        kid, slot = self.id(key), self.slot(cmv.PATH)
        self.out.u8(cmv.PATH)
        self.out.u32(kid)
        self.out.f32s(list(centroid_area))
        p = np.frombuffer(points, "<f8").reshape(-1, 3)
        self.array(
            "paths", kid, 0, np.round(p * Q["geometry"]).astype(np.int64), slot, True
        )
        s = np.frombuffer(subpaths, "<u4").reshape(-1, 4).astype(np.int64)
        self.array("paths", kid, 1, s, slot, False)

    @timed
    def grow_path(self, key, points, closed=False):
        self.roll()
        if self.real:
            self.real.grow_path(key, points, closed)
        self.out.u8(cmv.GROW)
        self.out.u32(self.id(key))
        self.out.u8(int(closed))
        p = np.round(
            np.frombuffer(points, "<f8").reshape(-1, 3) * Q["geometry"]
        ).astype(np.int64)
        start = len(self.out.parts)
        cmv.put_ints(self.out, np.diff(p, axis=0, prepend=np.zeros((1, 3), np.int64)))
        self.raw["paths"] += sum(len(x) for x in self.out.parts[start:])

    @timed
    def add_points(self, key, vertices):
        self.roll()
        if self.real:
            self.real.add_points(key, vertices)
        kid, slot = self.id(key), self.slot(cmv.POINTS)
        self.out.u8(cmv.POINTS)
        self.out.u32(kid)
        v = np.frombuffer(vertices, "<f4").reshape(-1, 4).astype(np.float64)
        self.array(
            "point clouds",
            kid,
            0,
            np.round(v * Q["points"]).astype(np.int64),
            slot,
            True,
        )

    @timed
    def add_mesh(self, key, points, uvs, normals, triangles, outline=0, block=0):
        self.roll()
        if self.real:
            self.real.add_mesh(key, points, uvs, normals, triangles, outline, block)
        kid, ctx = self.id(key), CUR["lattice"]
        if ctx is not None:
            shape, lattice, grid_uvs, steps = ctx
            _, canonical, _ = shape.affine
            u, v = lattice[0], lattice[1]
            if len(canonical) == (u + 1) * (v + 1) and outline == 4 * steps + 1:
                slot = self.slot(cmv.GRID)
                self.out.u8(cmv.GRID)
                self.out.u32(kid)
                for x in (*lattice[:4], steps):
                    self.out.u32(int(x))
                self.array(
                    "surfaces",
                    kid,
                    0,
                    np.round(canonical * Q["surface"]).astype(np.int64),
                    slot,
                    True,
                )
                uv = (
                    np.zeros((len(canonical), 2))
                    if grid_uvs is None
                    else np.asarray(grid_uvs, float)
                )
                self.array(
                    "surfaces",
                    kid,
                    1,
                    np.round(uv * Q["uv"]).astype(np.int64),
                    slot,
                    False,
                )
                return
        slot = self.slot(cmv.MESH)
        self.out.u8(cmv.MESH)
        self.out.u32(kid)
        self.out.u32(outline)
        self.out.u32(block)
        self.array(
            "meshes",
            kid,
            0,
            np.round(np.frombuffer(points, "<f8").reshape(-1, 3) * Q["surface"]).astype(
                np.int64
            ),
            slot,
            True,
        )
        self.array(
            "meshes",
            kid,
            1,
            np.round(np.frombuffer(uvs, "<f8").reshape(-1, 2) * Q["uv"]).astype(
                np.int64
            ),
            slot,
            False,
        )
        n = (
            np.frombuffer(normals, "<f8").reshape(-1, 3)
            if len(normals)
            else np.zeros((0, 3))
        )
        self.array(
            "meshes", kid, 2, np.round(n * Q["normals"]).astype(np.int64), slot, False
        )
        self.array(
            "meshes",
            kid,
            3,
            np.frombuffer(triangles, "<u4").reshape(-1, 3).astype(np.int64),
            slot,
            False,
        )

    @timed
    def add_rows(self, key, rows):
        self.roll()
        if self.real:
            self.real.add_rows(key, rows)
        kid, slot = self.id(key), self.slot(cmv.ROWS)
        self.out.u8(cmv.ROWS)
        self.out.u32(kid)
        q = np.round(
            np.frombuffer(rows, "<f4").reshape(-1, 4).astype(np.float64) * Q["rows"]
        ).astype(np.int64)
        k = repeat(q)
        self.out.u32(k)
        self.array("colour rows", kid, 0, q[::k], slot, False)

    @timed
    def add_texture(self, key, width, height, rgba):
        self.roll()
        if self.real:
            self.real.add_texture(key, width, height, rgba)
        kid, slot = self.id(key), self.slot(cmv.TEXTURE)
        img = np.frombuffer(rgba, np.uint8).reshape(height, width, 4)
        vkey = (slot, width, height) if slot is not None else None
        if (
            vkey is not None
            and width * height >= S.video_min_pixels
            and (vkey in self.videos or self.slots.get(slot + (0,)))
        ):
            video = self.videos.get(vkey)
            if video is None:
                video = self.videos[vkey] = Video(width, height)
                self.video_list.append(video)
            self.out.u8(cmv.VIDEO_FRAME)
            self.out.u32(kid)
            self.out.u32(self.video_list.index(video))
            self.out.u32(video.frames)
            video.add(img)
            self.raw["image tracks"] += 13
            return
        self.out.u8(cmv.TEXTURE)
        self.out.u32(kid)
        self.out.u32(width)
        self.out.u32(height)
        self.array("images", kid, 0, img.reshape(-1, 4).astype(np.int64), slot, False)

    @timed
    def add_environment(self, id, width, height, rgbe):
        self.roll()
        if self.real:
            self.real.add_environment(id, width, height, rgbe)
        self.out.u8(cmv.ENVIRONMENT)
        for x in (id, width, height):
            self.out.u32(x)
        self.out.bytes_(rgbe)
        self.raw["environment"] += len(rgbe)

    def evict(self, keys):
        pass

    def stored(self):
        return 0, 0

    def records(self, records: bytes, part: str, base=None, base2=None) -> np.ndarray:
        R = np.frombuffer(records, np.uint8).reshape(-1, cmv.RECORD_BYTES)
        keys = R[:, : 8 * cmv.KEY_FIELDS].copy().view("<u8")
        ids = np.array([self.id(int(k)) for k in keys.ravel()], np.int64).reshape(
            keys.shape
        )
        flags = (
            R[:, 56:64].copy().view("<i4").astype(np.int64)
        )  # signed, so every lane fits 32 bits
        floats = cmv.ordered(R[:, 64:].copy().view("<f4"))
        q = np.concatenate([ids, flags, floats], 1)
        coding, r = cmv.code(q, base, base2, False)
        start = len(self.out.parts)
        self.out.u8(coding)
        cmv.put_ints(self.out, r)
        self.raw[part] += sum(len(p) for p in self.out.parts[start:])
        return q

    @timed
    def frame(self, view, records, repeat=1, cameras=()):
        self.roll()
        if self.real:
            self.real.frame(view, records, repeat, list(cameras))
        self.out.u8(cmv.FRAME)
        self.out.u32(repeat)
        vq = cmv.ordered(np.frombuffer(view, "<f4").copy())[None]
        coding, r = cmv.code(vq, self.prev_view, self.prev_view2, False)
        start = len(self.out.parts)
        self.out.u8(coding)
        cmv.put_ints(self.out, r)
        self.raw["views"] += sum(len(p) for p in self.out.parts[start:])
        self.prev_view2, self.prev_view = self.prev_view, vq
        q = self.records(records, "records", self.prev_records, self.prev_records2)
        self.prev_records2, self.prev_records = self.prev_records, q
        self.out.u32(len(cameras))
        for cid, w, h, cview, crecords in cameras:
            for x in (cid, w, h):
                self.out.u32(x)
            self.out.bytes_(cview)
            self.records(crecords, "records")
        self.frames += repeat

    def note(self, json_text):
        self.roll()
        if self.real:
            self.real.note(json_text)
        self.out.u8(cmv.NOTE)
        self.out.bytes_(json_text.encode())
        self.raw["notes"] += len(json_text)

    def sound(self, file):
        self.roll()
        if self.real:
            self.real.sound(file)
        self.out.u8(cmv.SOUND)
        self.out.bytes_(file)
        self.raw["sound"] += len(file)

    def end(self, failed=False):
        if self.real:
            self.real.end(failed)
        self.out.u8(cmv.END)
        self.out.u8(int(failed))
        self.flush()
        EXPORTERS.append(self)

    def drain(self):
        return self.real.drain() if self.real else b""


REAL = _engine.Recorder
EXPORTERS: list[Exporter] = []


class Shim:
    Recorder = Exporter

    def __getattr__(self, name):
        return getattr(_engine, name)


def film_video(take: str) -> list[tuple[bytes, bytes, int, int]]:
    """The take drawn by ManimGX's headless player, every frame, as one H.264 segment a second."""
    replay = _engine.Replay(Path(take).read_bytes())
    w, h = replay.size
    chunks = []
    for first in range(0, replay.frames, S.fps):
        n = min(S.fps, replay.frames - first)
        frames = b"".join(
            np.frombuffer(replay.render(f), np.uint8)
            .reshape(h, w, 4)[..., :3]
            .tobytes()
            for f in range(first, first + n)
        )
        out = cmv.Out()
        out.u8(1)
        cmv.put_segment(
            out, 0, first, cmv.h264(frames, w, h, "rgb24", S.crf, S.fps), []
        )
        chunks.append((b"", out.getvalue(), first, n))
    return chunks


def film(meta: dict, chunks) -> bytes:
    index, at = [], 0
    for draw, video, first, n in chunks:
        index.append((at, len(draw), len(video), first, n))
        at += len(draw) + len(video)
    meta = dict(meta, frames=sum(c[3] for c in chunks), chunks=len(chunks))
    return cmv.header(meta, index) + b"".join(
        draw + video for draw, video, _, _ in chunks
    )


def load_scene(path: Path, name: str | None, ce: bool) -> type:
    """The Scene class `name` of the file at `path` (its first if None)."""
    if ce:
        from . import ce as ce_shim

        ce_shim.install()
    sys.path[:0] = [str(path.parent), *(str(Path(p).resolve()) for p in S.paths)]
    os.chdir(path.parent)  # scenes read their assets relative to their folder
    spec = importlib.util.spec_from_file_location("scene", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["scene"] = module
    spec.loader.exec_module(module)
    if name:
        return getattr(module, name)
    scenes = [
        v
        for v in vars(module).values()
        if isinstance(v, type) and issubclass(v, m.Scene) and v.__module__ == "scene"
    ]
    if not scenes:
        raise ValueError(f"{path.name} defines no Scene")
    return scenes[0]


def export(
    scene: str,
    out: str,
    name: str | None = None,
    ce: bool = False,
    settings: Settings | None = None,
) -> dict:
    """Run the scene and write its film to `out`. Returns what was written: the form, both
    forms' sizes (auto), the drawn form's bytes by part, times. Runs once per process: ManimGX's
    recorder and feeder are replaced for good."""
    global S, Q, Z
    S = settings or Settings()
    Q = {
        "geometry": S.q_geometry,
        "surface": S.q_surface,
        "uv": 65536.0,
        "normals": 16384.0,
        "points": S.q_points,
        "rows": S.q_rows,
    }
    Z = zstandard.ZstdCompressor(level=S.level, threads=-1)
    config.pixel_width, config.pixel_height, config.frame_rate = (
        S.width,
        S.height,
        S.fps,
    )
    feed.Feeder.make_record, feed.Feeder.mesh = make_record, mesh
    film_module._engine = Shim()

    src, out_path = Path(scene).resolve(), Path(out).resolve()
    with tempfile.TemporaryDirectory() as tmp:
        take = str(Path(S.take).resolve()) if S.take else str(Path(tmp) / "scene.take")
        kind = load_scene(src, name, ce)
        t0 = time.perf_counter()
        with open(take, "wb") as f:
            kind().render(take=f.write)
        render_s = time.perf_counter() - t0
        ex = EXPORTERS[-1]
        forms, video_s = {}, None
        if S.form in ("drawn", "auto"):
            engine = {
                "name": "manimgx",
                "version": importlib.metadata.version("manimgx"),
                "take": cmv.TAKE_VERSION,
            }
            tracks = [
                {"width": v.w, "height": v.h, "alpha": True} for v in ex.video_list
            ]
            forms["drawn"] = film(
                dict(
                    ex.meta,
                    form="drawn",
                    scene=kind.__name__,
                    tracks=tracks,
                    q=Q,
                    engine=engine,
                ),
                ex.chunks,
            )
        if S.form in ("video", "auto"):
            t1 = time.perf_counter()
            tracks = [{"width": S.width, "height": S.height, "alpha": False}]
            forms["video"] = film(
                dict(ex.meta, form="video", scene=kind.__name__, tracks=tracks),
                film_video(take),
            )
            video_s = time.perf_counter() - t1
        take_mb = Path(take).stat().st_size / 1e6
    form = min(forms, key=lambda k: len(forms[k]))
    out_path.write_bytes(forms[form])
    draw_bytes = sum(len(c[0]) for c in ex.chunks)
    raw_total = sum(ex.raw.values()) or 1
    return {
        "scene": kind.__name__,
        "frames": ex.frames,
        "seconds": round(ex.frames / S.fps, 1),
        "form": form,
        "MB": round(len(forms[form]) / 1e6, 3),
        **{f"{k}_MB": round(len(v) / 1e6, 3) for k, v in forms.items()},
        "drawn_parts_MB": {
            k: round(draw_bytes * v / raw_total / 1e6, 3)
            for k, v in ex.raw.most_common()
        },
        "drawn_image_tracks_MB": round(sum(len(c[1]) for c in ex.chunks) / 1e6, 3),
        "take_MB": round(take_mb, 2),
        "render_s": round(render_s, 2),
        "encode_s": round(ex.encode_s, 2),
        "video_s": round(video_s, 2) if video_s else None,
    }
