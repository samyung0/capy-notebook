#!/usr/bin/env python3
"""An Office file's size, split the way the size limit counts it (Epo,
2026-10-06: the unzipped bytes of the XML parts only; media stays under the
upload cap): zipped bytes, and the unzipped bytes of its XML parts (what the
engines parse and lay out), its media (pictures, audio, video: what they
mostly pass through) and anything else (embedded fonts, OLE and VBA .bin
parts, embedded packages). One JSON object per file.

The rule, once: a part is media when its extension is a picture, audio or
video one (SVG included: it is a picture, even with an XML content type);
otherwise it is XML when its extension is .xml, .rels or .vml (legacy
drawings, XLSX comments and form controls) or its content type in
[Content_Types].xml (Override by part name, else Default by extension) ends
in +xml or /xml; everything else is other.

usage: office_sizes.py <file>...
"""

import json
import os
import re
import sys
import zipfile

MEDIA = {
    ".bmp", ".emf", ".gif", ".jpeg", ".jpg", ".m4a", ".mov", ".mp3", ".mp4",
    ".png", ".svg", ".tif", ".tiff", ".wav", ".wdp", ".webp", ".wmf", ".wmv",
}
XML = {".xml", ".rels", ".vml"}


def content_types(z):
    """Part name (no leading slash) and extension to content type."""
    try:
        text = z.read("[Content_Types].xml").decode("utf-8", "replace")
    except KeyError:
        return {}, {}
    overrides = {
        part.lstrip("/"): kind
        for part, kind in re.findall(r'<Override[^>]*PartName="([^"]+)"[^>]*ContentType="([^"]+)"', text)
    }
    defaults = {
        ext.lower(): kind
        for ext, kind in re.findall(r'<Default[^>]*Extension="([^"]+)"[^>]*ContentType="([^"]+)"', text)
    }
    return overrides, defaults


def kind(name, overrides, defaults):
    # From the basename's last dot: splitext gives the root "_rels/.rels" none.
    base = name.rpartition("/")[2]
    extension = base[base.rfind(".") :].lower() if "." in base else ""
    if extension in MEDIA:
        return "media"
    if extension in XML:
        return "xml"
    declared = overrides.get(name) or defaults.get(extension.lstrip("."), "")
    return "xml" if declared.endswith(("+xml", "/xml")) else "other"


def sizes(path):
    out = {"file": os.path.basename(path), "zippedBytes": os.path.getsize(path)}
    split = {"xml": [0, 0, 0], "media": [0, 0, 0], "other": [0, 0, 0]}
    with zipfile.ZipFile(path) as z:
        overrides, defaults = content_types(z)
        for info in z.infolist():
            if info.is_dir():
                continue
            parts = split[kind(info.filename, overrides, defaults)]
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
