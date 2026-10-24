"""Regenerate the image compression fixtures and manifest.json: the outputs
both compressors must agree on (src/lib/fitImage.ts in the browser and
pipeline/pipeline/ingest/images.py on the import worker), by format and size,
not bytes. "office" is the Office rule (long side within 2,400 px, JPEG for
photos, PNG for transparency or flat graphics); "source" is an image file
uploaded as a source (at most 5 megapixels; a PNG, JPEG, GIF or WebP within
that is kept as it is, anything else re-saved).

Run: uv run python e2e/fixtures/files/images/generate_images.py
(needs Pillow, and ffmpeg with libx265 for the HEIC).
"""

import json
import struct
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

OUT = Path(__file__).parent


def gradient(width, height, mode="RGB"):
    """A smooth two-way gradient: thousands of colours, so a photo."""
    image = Image.new(mode, (width, height))
    image.putdata(
        [
            (x * 255 // width, y * 255 // height, 128, 255 * x // width)[: len(mode)]
            for y in range(height)
            for x in range(width)
        ]
    )
    return image


def rows(width, height):
    """One colour per row: a photo by its colour count, tiny when deflated."""
    image = Image.new("RGB", (width, height))
    image.putdata(
        [(y % 256, (y // 256) * 30, 90) for y in range(height) for _ in range(width)]
    )
    return image


def flat(width, height, colours):
    image = Image.new("RGB", (width, height))
    image.putdata(
        [
            colours[(x // 50 + y // 50) % len(colours)]
            for y in range(height)
            for x in range(width)
        ]
    )
    return image


def box(kind, *payload):
    body = b"".join(payload)
    return struct.pack(">I", 8 + len(body)) + kind + body


def full(kind, version, flags, *payload):
    return box(kind, struct.pack(">I", version << 24 | flags), *payload)


def heic(image, path):
    """A one-image HEIC: x265 encodes the picture in an MP4, whose hvcC and
    sample become the HEIF item."""
    with tempfile.TemporaryDirectory() as temp:
        png, mp4 = Path(temp) / "in.png", Path(temp) / "out.mp4"
        image.save(png)
        subprocess.run(
            [
                "ffmpeg",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(png),
                "-frames:v",
                "1",
                "-c:v",
                "libx265",
                "-x265-params",
                "log-level=error",
                "-crf",
                "32",
                "-pix_fmt",
                "yuv420p",
                "-tag:v",
                "hvc1",
                str(mp4),
            ],
            check=True,
        )
        data = mp4.read_bytes()
    at = data.index(b"hvcC") - 4
    hvcc = data[at : at + struct.unpack(">I", data[at : at + 4])[0]]
    at = data.index(b"mdat") - 4
    sample = data[at + 8 : at + struct.unpack(">I", data[at : at + 4])[0]]
    width, height = image.size

    def meta(offset):
        return full(
            b"meta",
            0,
            0,
            full(b"hdlr", 0, 0, b"\0" * 4, b"pict", b"\0" * 12, b"\0"),
            full(b"pitm", 0, 0, struct.pack(">H", 1)),
            full(
                b"iloc",
                0,
                0,
                bytes([0x44, 0]),
                struct.pack(">HHHHII", 1, 1, 0, 1, offset, len(sample)),
            ),
            full(
                b"iinf",
                0,
                0,
                struct.pack(">H", 1),
                full(b"infe", 2, 0, struct.pack(">HH", 1, 0), b"hvc1", b"\0"),
            ),
            box(
                b"iprp",
                box(
                    b"ipco",
                    hvcc,
                    full(b"ispe", 0, 0, struct.pack(">II", width, height)),
                ),
                full(b"ipma", 0, 0, struct.pack(">IHB", 1, 1, 2), bytes([0x81, 0x02])),
            ),
        )

    ftyp = box(b"ftyp", b"heic", struct.pack(">I", 0), b"mif1heic")
    head = ftyp + meta(0)
    path.write_bytes(ftyp + meta(len(head) + 8) + box(b"mdat", sample))


def main():
    photo = gradient(3000, 2000)
    photo.save(OUT / "photo.jpg", quality=85)
    gradient(2600, 1300).save(OUT / "photo.png", optimize=True)
    gradient(2600, 1300, "RGBA").save(OUT / "alpha.png", optimize=True)
    flat(1200, 800, [(20, 40, 200), (250, 250, 250), (230, 30, 30), (0, 0, 0)]).save(
        OUT / "flat.png", optimize=True
    )
    flat(600, 3000, [(255, 255, 255), (10, 10, 10)]).save(
        OUT / "tall.png", optimize=True
    )
    gradient(800, 600).save(OUT / "small.jpg", quality=60)
    # Within 5 MP, but not a format servers measure: re-saved (Q344).
    gradient(800, 600).save(OUT / "small.tif", compression="tiff_adobe_deflate")
    rows(3000, 2000).save(OUT / "photo.tif", compression="tiff_adobe_deflate")
    photo.save(OUT / "photo.jp2", quality_mode="rates", quality_layers=[200])
    heic(photo, OUT / "photo.heic")
    # The same file with its picture's bytes gone: libheif reads the header
    # and fails on the item.
    whole = (OUT / "photo.heic").read_bytes()
    (OUT / "corrupt.heic").write_bytes(whole[: whole.index(b"mdat") + 64])

    source = (2738, 1825)
    manifest = {
        "office": {
            "photo.jpg": ["jpeg", 2400, 1600],
            "photo.png": ["jpeg", 2400, 1200],
            "alpha.png": ["png", 2400, 1200],
            "flat.png": ["png", 1200, 800],
            "tall.png": ["png", 480, 2400],
            "small.jpg": ["jpeg", 800, 600],
        },
        "source": {
            "photo.jpg": ["jpeg", *source],
            "photo.png": ["png", 2600, 1300],
            "alpha.png": ["png", 2600, 1300],
            "small.jpg": ["jpeg", 800, 600],
            "small.tif": ["jpeg", 800, 600],
            "photo.tif": ["jpeg", *source],
            "photo.jp2": ["jpeg", *source],
            "photo.heic": ["jpeg", *source],
        },
        "unreadable": ["corrupt.heic"],
    }
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", newline="\n"
    )


if __name__ == "__main__":
    main()
