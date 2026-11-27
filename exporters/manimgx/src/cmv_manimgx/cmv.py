"""CMV, a container for ManimGX films that a page plays without running the scene.

A film takes one of two forms, chosen per scene when it is exported (header "form"):

    drawn   what the engine was asked to draw: shapes, surfaces, point clouds, colour rows and
            images uploaded once, then per frame a view and its records. ManimGX's own player
            draws them (WebGPU). Images that change every frame ride along as video tracks.
    video   the film already drawn: every frame as H.264, the whole picture (one track). A video
            decoder shows it; nothing is drawn.

File layout (little-endian), the same for both forms:

    "CMV0" | header length u32 | header JSON | chunk index | chunk 0 | chunk 1 | …
    chunk index: per chunk, offset u64, draw bytes u32, video bytes u32, first frame u32, frames u32
    chunk:       one second of film, everything that second needs:
                   draw part   one zstd frame of messages (drawn form only; 0 bytes in video form)
                   video part  segments count u8, then per segment: track u32, first frame of
                               the track u32, frames n u32, n colour frame sizes u32, n alpha frame
                               sizes u32 (tracks with alpha), then the colour frames, then the
                               alpha frames. Frames are H.264 access units (Annex-B, no B-frames),
                               the first a keyframe, so each segment decodes on its own.

Header JSON: "cmv" (this format's version, 1), "form", "width", "height", "fps", "frames",
"chunks", "tracks" (per video track: width, height, alpha), "scene"; a drawn film also has "q"
(the quantization steps) and "engine" ({"name": "manimgx", "version", "take"}: the ManimGX player
that draws it and its take format's version).

A player can fetch any chunk by its byte range and play from there (drawn form: from the chunk
before it, since arrays are coded against the previous second's).

Draw messages: an op (u8), then its fields. Arrays are integer lanes (x's, then y's, …): floats
quantized (each kind at its own step, in the header) and coded against the array the same object
drew last (its base), whichever is smallest of

    ALONE   the array (points: each against the one before it)
    FIRST   minus the base
    SECOND  minus the straight-line prediction from the base and the base's base
    TAIL    the base is its start; only the rest is stored

A base is only an array written in the same chunk or the one before, so a reader holds about two
seconds of arrays. Colour rows that repeat in place (a lattice cell's row on each of its refined
vertices) are stored once per cell with their repeat count. Records (a frame's objects) and views
are stored losslessly: float32 bit patterns made order-preserving integers, minus the last
frame's. Surfaces are stored as their sample grids and refined again by the reader, exactly as
ManimGX's feeder refines them. A VIDEO_FRAME message stands where an image upload would be and
names its track and frame; the pixels are in the same chunk's video part.
"""

import json
import re
import struct
import subprocess

import numpy as np

MAGIC = b"CMV0"

# ops
(
    PATH,
    POINTS,
    MESH,
    GRID,
    ROWS,
    TEXTURE,
    GROW,
    FRAME,
    NOTE,
    SOUND,
    ENVIRONMENT,
    VIDEO_FRAME,
    END,
) = range(1, 14)
# codings
ALONE, FIRST, SECOND, TAIL, RAW = range(5)

VERSION = 1  # the "cmv" header field
TAKE_VERSION = 1  # ManimGX's take format, which a drawn film's player is fed
RECORD_BYTES = 336
KEY_FIELDS = 7  # u64 keys at the start of a record (then flags u64, then 68 float32)


# ── small writers / readers ─────────────────────────────────────────────────────────────────
class Out:
    def __init__(self):
        self.parts: list[bytes] = []

    def u8(self, v):
        self.parts.append(struct.pack("<B", v))

    def u32(self, v):
        self.parts.append(struct.pack("<I", v))

    def f32s(self, vs):
        self.parts.append(struct.pack(f"<{len(vs)}f", *vs))

    def bytes_(self, b: bytes):
        self.u32(len(b))
        self.parts.append(bytes(b))

    def raw(self, b: bytes):
        self.parts.append(bytes(b))

    def getvalue(self) -> bytes:
        return b"".join(self.parts)


class In:
    def __init__(self, data: bytes):
        self.data, self.at = memoryview(data), 0

    def u8(self):
        v = self.data[self.at]
        self.at += 1
        return v

    def u32(self):
        v = struct.unpack_from("<I", self.data, self.at)[0]
        self.at += 4
        return v

    def f32s(self, n):
        v = struct.unpack_from(f"<{n}f", self.data, self.at)
        self.at += 4 * n
        return v

    def take(self, n) -> memoryview:
        if self.at + n > len(self.data):
            raise IndexError("a field runs past the end")
        v = self.data[self.at : self.at + n]
        self.at += n
        return v

    def bytes_(self) -> memoryview:
        return self.take(self.u32())

    def done(self) -> bool:
        return self.at >= len(self.data)


# ── integer arrays against their bases ──────────────────────────────────────────────────────
def code(
    q: np.ndarray, base: np.ndarray | None, base2: np.ndarray | None, points: bool
) -> tuple[int, np.ndarray]:
    """(coding, residual) for integer array q (n × lanes) against its bases."""
    options = [
        (
            ALONE,
            np.diff(q, axis=0, prepend=np.zeros((1, q.shape[1]), q.dtype))
            if points and len(q)
            else q,
        )
    ]
    if base is not None and base.shape[1] == q.shape[1]:
        if base.shape[0] == q.shape[0]:
            options.append((FIRST, q - base))
            if base2 is not None and base2.shape == q.shape:
                options.append((SECOND, q - 2 * base + base2))
        elif 0 < base.shape[0] < q.shape[0] and np.array_equal(
            q[: base.shape[0]], base
        ):
            rest = q[base.shape[0] :]
            start = base[-1:] if points else np.zeros((1, q.shape[1]), q.dtype)
            options.append(
                (TAIL, np.diff(rest, axis=0, prepend=start) if points else rest)
            )
    fits = [o for o in options if o[0] == ALONE or np.abs(o[1]).max(initial=0) < 2**31]
    return min(fits, key=lambda o: int(np.abs(o[1]).sum()))


def uncode(
    coding: int,
    r: np.ndarray,
    base: np.ndarray | None,
    base2: np.ndarray | None,
    points: bool,
) -> np.ndarray:
    if coding == ALONE:
        return np.cumsum(r, axis=0) if points else r
    if coding == FIRST:
        return base + r
    if coding == SECOND:
        return r + 2 * base - base2
    if coding == TAIL:
        rest = (np.cumsum(r, axis=0) + base[-1:]) if points else r
        return np.concatenate([base, rest])
    raise ValueError(coding)


def put_ints(out: Out, a: np.ndarray):
    """Lanes of an int64 array as int32 (callers keep values in range)."""
    out.u32(a.shape[0])
    out.u8(a.shape[1])
    out.raw(np.ascontiguousarray(a.T).astype("<i4").tobytes())


def get_ints(inp: In) -> np.ndarray:
    n, lanes = inp.u32(), inp.u8()
    return (
        np.frombuffer(inp.take(4 * n * lanes), "<i4")
        .reshape(lanes, n)
        .T.astype(np.int64)
    )


# ── float32 bit patterns as order-preserving integers (lossless) ────────────────────────────
def ordered(f32: np.ndarray) -> np.ndarray:
    i = f32.view("<i4").astype(np.int64)
    return np.where(i < 0, -(i & 0x7FFFFFFF) - 1, i)


def unordered(o: np.ndarray) -> np.ndarray:
    i = np.where(o < 0, -(o + 1) | np.int64(-0x80000000), o)
    return (i & 0xFFFFFFFF).astype("<u4").view("<f4")


def forget(arrays: dict, parent: dict, written: dict, chunk: int) -> None:
    """Before chunk `chunk`: only arrays written in it or the one before stay bases, so a reader
    holds about two seconds of arrays, however long the film."""
    for ref in [r for r, c in written.items() if c < chunk - 1]:
        arrays.pop(ref, None)
        parent.pop(ref, None)
        del written[ref]


def header(meta: dict, chunks: list[tuple[int, int, int, int, int]]) -> bytes:
    h = json.dumps(meta, separators=(",", ":")).encode()
    index = b"".join(struct.pack(INDEX, *c) for c in chunks)
    return MAGIC + struct.pack("<I", len(h)) + h + index


def read_header(data: bytes) -> tuple[dict, list[tuple[int, int, int, int, int]], int]:
    """(meta, chunks as (offset, draw bytes, video bytes, first frame, frames), body offset)."""
    assert data[:4] == MAGIC, "not a CMV file"
    n = struct.unpack_from("<I", data, 4)[0]
    meta = json.loads(data[8 : 8 + n])
    at, size = 8 + n, struct.calcsize(INDEX)
    chunks = [
        struct.unpack_from(INDEX, data, at + size * i) for i in range(meta["chunks"])
    ]
    return meta, chunks, at + size * meta["chunks"]


INDEX = "<QIIII"


# ── video segments ──────────────────────────────────────────────────────────────────────────
AUD = re.compile(rb"\x00\x00\x01\x09")  # an access unit delimiter starts each frame


def h264(
    frames: bytes, w: int, h: int, pix_fmt: str, crf: int, fps: int
) -> list[bytes]:
    """Raw frames (rgb24 or gray) as H.264, one access unit per frame, the first a keyframe."""
    out = subprocess.run(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-f",
            "rawvideo",
            "-pix_fmt",
            pix_fmt,
            "-s",
            f"{w}x{h}",
            "-r",
            str(fps),
            "-i",
            "-",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            str(crf),
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "0",
            "-x264-params",
            "aud=1",
            "-f",
            "h264",
            "-",
        ],
        input=frames,
        capture_output=True,
        check=True,
    ).stdout
    starts = [
        m.start() - (1 if m.start() > 0 and out[m.start() - 1] == 0 else 0)
        for m in AUD.finditer(out)
    ]
    units = [out[a:b] for a, b in zip(starts, starts[1:] + [len(out)])]
    assert len(units) == len(frames) // (w * h * (3 if pix_fmt == "rgb24" else 1)), (
        "one access unit per frame"
    )
    return units


def put_segment(
    out: Out, track: int, first: int, colour: list[bytes], alpha: list[bytes]
):
    for x in (track, first, len(colour)):
        out.u32(x)
    for unit in colour + alpha:
        out.u32(len(unit))
    out.raw(b"".join(colour + alpha))


def get_segments(
    data: bytes, tracks: list[dict]
) -> list[tuple[int, int, list[bytes], list[bytes]]]:
    """A chunk's video part: (track, first frame, colour units, alpha units) per segment."""
    if not data:
        return []
    inp, segments = In(data), []
    for _ in range(inp.u8()):
        track, first, n = inp.u32(), inp.u32(), inp.u32()
        sizes = [inp.u32() for _ in range(n * (2 if tracks[track]["alpha"] else 1))]
        units = [bytes(inp.take(k)) for k in sizes]
        segments.append((track, first, units[:n], units[n:]))
    return segments


def decode_h264(units: list[bytes], w: int, h: int, gray: bool) -> np.ndarray:
    """Access units back to frames (n × h × w × 3, or × 1 for gray)."""
    c = 1 if gray else 3
    out = subprocess.run(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-f",
            "h264",
            "-i",
            "-",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray" if gray else "rgb24",
            "-",
        ],
        input=b"".join(units),
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(out, np.uint8).reshape(-1, h, w, c)


# ── validation: the structure a server checks before it stores a film ───────────────────────
# Fast: the header, the index and each chunk's part headers are read; nothing is decompressed or
# decoded. The same rules as the app's server (server/internal/cmvfile).
LIMITS = {
    # 1080p either way round: the long side at most 1920, the short at most 1080
    "long_side": 1920,
    "short_side": 1080,
    "fps": 60,
    "tracks": 16,
    "header": 1 << 16,
    "draw_content": 64 << 20,
}
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


class Invalid(ValueError):
    pass


def fits(width, height) -> bool:
    """Whether a film or track size is within LIMITS (at least 16 px a side)."""
    sides = (width, height)
    return (
        all(isinstance(x, int) and not isinstance(x, bool) for x in sides)
        and min(sides) >= 16
        and max(sides) <= LIMITS["long_side"]
        and min(sides) <= LIMITS["short_side"]
    )


def _zstd_content_size(frame: bytes) -> int:
    """A zstd frame's declared content size (the encoder writes it), from its frame header."""
    if frame[:4] != ZSTD_MAGIC or len(frame) < 6:
        raise Invalid("a draw part is not a zstd frame")
    fhd = frame[4]
    fcs_flag, single, dict_flag = fhd >> 6, (fhd >> 5) & 1, fhd & 3
    at = 5 + (0 if single else 1) + (0, 1, 2, 4)[dict_flag]
    size = (1 if single else 0, 2, 4, 8)[fcs_flag]
    if size == 0:
        raise Invalid("a draw part does not declare its size")
    if len(frame) < at + size:
        raise Invalid("a draw part ends inside its header")
    value = int.from_bytes(frame[at : at + size], "little")
    return value + 256 if size == 2 else value


def _keyframe(unit: bytes) -> bool:
    """Whether an Annex-B access unit holds an IDR slice (NAL type 5)."""
    for m in re.finditer(rb"\x00\x00\x01", unit):
        if m.end() < len(unit) and unit[m.end()] & 31 == 5:
            return True
    return False


def validate(data: bytes) -> dict:
    """The film's header if its structure holds; Invalid (with the reason) if not."""
    if data[:4] != MAGIC or len(data) < 8:
        raise Invalid("not a CMV film")
    n = struct.unpack_from("<I", data, 4)[0]
    if n > LIMITS["header"] or 8 + n > len(data):
        raise Invalid("the header is too long")
    try:
        meta = json.loads(data[8 : 8 + n])
    except ValueError as e:
        raise Invalid("the header is not JSON") from e
    if not isinstance(meta, dict) or meta.get("cmv") != VERSION:
        raise Invalid("not a CMV version this reads")
    form = meta.get("form")
    if form not in ("drawn", "video"):
        raise Invalid("the form is neither drawn nor video")
    num = lambda k, lo, hi: (
        isinstance(meta.get(k), (int, float))
        and not isinstance(meta.get(k), bool)
        and lo <= meta[k] <= hi
    )
    if not (
        fits(meta.get("width"), meta.get("height")) and num("fps", 1, LIMITS["fps"])
    ):
        raise Invalid("the size or frame rate is out of range")
    if not (
        isinstance(meta.get("frames"), int)
        and meta["frames"] >= 1
        and isinstance(meta.get("chunks"), int)
        and meta["chunks"] >= 1
    ):
        raise Invalid("no frames or no chunks")
    tracks = meta.get("tracks")
    if not isinstance(tracks, list) or len(tracks) > LIMITS["tracks"]:
        raise Invalid("the tracks are not a list")
    for t in tracks:
        if not (
            isinstance(t, dict)
            and isinstance(t.get("alpha"), bool)
            and fits(t.get("width"), t.get("height"))
        ):
            raise Invalid("a track's size is out of range")
    if form == "drawn":
        engine = meta.get("engine")
        if not (
            isinstance(engine, dict)
            and engine.get("name") == "manimgx"
            and engine.get("take") == TAKE_VERSION
        ):
            raise Invalid("a drawn film for a player this doesn't have")
        if not (
            isinstance(meta.get("q"), dict)
            and all(isinstance(v, (int, float)) and v > 0 for v in meta["q"].values())
        ):
            raise Invalid("the quantization steps are missing")
    elif len(tracks) != 1 or tracks[0]["alpha"]:
        raise Invalid("a video film has one track, without alpha")
    size = struct.calcsize(INDEX)
    body = 8 + n + size * meta["chunks"]
    if body > len(data):
        raise Invalid("the chunk index is cut short")
    at = frame = 0
    for i in range(meta["chunks"]):
        offset, draw, video, first, frames = struct.unpack_from(
            INDEX, data, 8 + n + size * i
        )
        if offset != at or first != frame or frames < 1:
            raise Invalid(f"chunk {i} is out of place")
        if (form == "video") != (draw == 0):
            raise Invalid(f"chunk {i}'s draw part doesn't match the form")
        start = body + offset
        if start + draw + video > len(data):
            raise Invalid(f"chunk {i} runs past the end")
        if (
            draw
            and _zstd_content_size(data[start : start + 18]) > LIMITS["draw_content"]
        ):
            raise Invalid(f"chunk {i}'s draw part is too large")
        if video:
            _check_video(
                data[start + draw : start + draw + video],
                tracks,
                form,
                first,
                frames,
                i,
            )
        elif form == "video":
            raise Invalid(f"chunk {i} has no video")
        at, frame = at + draw + video, frame + frames
    if body + at != len(data) or frame != meta["frames"]:
        raise Invalid("the chunks don't add up to the film")
    return meta


def _check_video(
    part: bytes, tracks: list, form: str, first: int, frames: int, chunk: int
):
    try:
        segments = get_segments(part, tracks)
    except (IndexError, struct.error) as e:
        raise Invalid(f"chunk {chunk}'s video part is malformed") from e
    used = 1 + sum(
        12 + 4 * (len(c) + len(a)) + sum(map(len, c)) + sum(map(len, a))
        for _, _, c, a in segments
    )
    if used != len(part) or not segments:
        raise Invalid(f"chunk {chunk}'s video part doesn't add up")
    for track, start, colour, alpha in segments:
        if (
            not colour
            or not all(colour)
            or not _keyframe(colour[0])
            or (alpha and not _keyframe(alpha[0]))
        ):
            raise Invalid(
                f"chunk {chunk} has a video segment that doesn't start with a keyframe"
            )
        if form == "video" and (
            len(segments) != 1 or start != first or len(colour) != frames
        ):
            raise Invalid(f"chunk {chunk}'s video doesn't cover its frames")
