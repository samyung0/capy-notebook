"""Offline checks for the matched source images used by both engines."""

import base64
import json

import compare_selective_recovery as runner
import pymupdf


def main():
    frozen = runner.BASE / "r2"
    rows = [
        json.loads(line)
        for line in (frozen / "batch/input.jsonl").read_text().splitlines()
    ]
    assert len(rows) == 16
    for row in rows:
        image_path = frozen / "images" / f"{row['custom_id']}.png"
        uri = row["body"]["messages"][0]["content"][0]["image_url"]["url"]
        assert base64.b64decode(uri.split(",", 1)[1]) == image_path.read_bytes()
        original = pymupdf.Pixmap(str(image_path))
        with pymupdf.open(image_path.with_suffix(".pdf")) as document:
            assert not document[0].get_text().strip()
            images = document[0].get_images()
            assert len(images) == 1
            embedded = pymupdf.Pixmap(document, images[0][0])
            assert (embedded.width, embedded.height, embedded.samples) == (
                original.width,
                original.height,
                original.samples,
            )

    print("Matched image checks passed")


if __name__ == "__main__":
    main()
