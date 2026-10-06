#!/usr/bin/env python3
"""An Office file's size, split the way the size limits are discussed
(opt-survey PLAN.md section 4): zipped bytes, and the unzipped bytes of its
XML parts (.xml and .rels: what the engines parse and lay out), its media
(pictures, audio, video: what they mostly pass through) and anything else
(fonts, embedded objects, binary parts). One JSON object per file.

usage: office_sizes.py <file>...
"""

import json
import os
import sys
import zipfile

MEDIA = {
    ".bmp", ".emf", ".gif", ".jpeg", ".jpg", ".m4a", ".mov", ".mp3", ".mp4",
    ".png", ".svg", ".tif", ".tiff", ".wav", ".wdp", ".webp", ".wmf", ".wmv",
}


def kind(name):
    extension = os.path.splitext(name)[1].lower()
    if extension in (".xml", ".rels"):
        return "xml"
    return "media" if extension in MEDIA else "other"


def sizes(path):
    out = {"file": os.path.basename(path), "zippedBytes": os.path.getsize(path)}
    split = {"xml": [0, 0, 0], "media": [0, 0, 0], "other": [0, 0, 0]}
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            parts = split[kind(info.filename)]
            parts[0] += info.file_size
            parts[1] += info.compress_size
            parts[2] += 1
    for name, (unzipped, compressed, count) in split.items():
        out[f"{name}Bytes"] = unzipped
        out[f"{name}ZippedBytes"] = compressed
        out[f"{name}Parts"] = count
    out["unzippedBytes"] = sum(unzipped for unzipped, _, _ in split.values())
    return out


if __name__ == "__main__":
    for path in sys.argv[1:]:
        print(json.dumps(sizes(path)))
