"""Pictures for the picture-heavy ladder fixtures: noise PNGs, a different one
per seed and the same bytes run to run. Noise does not compress, like the
JPEG photos real decks and documents carry, so a fixture's zipped size grows
with its pictures as theirs does."""

import random
import struct
import zlib


def noise_png(width, height, seed):
    rng = random.Random(seed)
    # One filter byte (none) per row of RGB pixels.
    raw = b"".join(b"\x00" + rng.randbytes(width * 3) for _ in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 1))
        + chunk(b"IEND", b"")
    )
