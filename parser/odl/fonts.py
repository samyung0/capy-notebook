"""Font-scoped PDF repair: rebuild a contradictory ToUnicode map from the
embedded Type1 encoding array. Only the observed literal array is read; no
PostScript is executed. The input PDF bytes are never changed in place."""

from __future__ import annotations

import re
import unicodedata

import pymupdf


def explicit_encoding(program: bytes) -> dict[int, str]:
    """Only the observed literal Type1 array, never execute PostScript."""
    header = program.split(b"currentfile eexec", 1)[0].decode("latin1")
    match = re.search(r"/Encoding 256 array\s+(.*?)readonly def", header, re.DOTALL)
    if not match:
        return {}
    body = match[1]
    if not re.match(r"0 1 255 \{1 index exch /\.notdef put\} for", body):
        return {}
    body = re.sub(r"^0 1 255 \{1 index exch /\.notdef put\} for", "", body)
    pairs = re.findall(r"dup (\d+) /([A-Za-z0-9_.]+) put", body)
    if re.sub(r"dup \d+ /[A-Za-z0-9_.]+ put", "", body).strip():
        return {}
    return {int(code): name for code, name in pairs}


def contradiction(encoding: dict[int, str], cmap: str) -> dict:
    """Narrow gate: a whole-byte CJK map contradicts explicit Latin glyphs."""
    ranges = re.findall(
        r"beginbfrange\s*<00>\s*<FF>\s*<([0-9a-fA-F]{4})>\s*endbfrange", cmap
    )
    base = int(ranges[0], 16) if len(ranges) == 1 else None
    latin = [
        (code, name)
        for code, name in encoding.items()
        if len(name) == 1 and name.isascii() and name.isalpha()
    ]
    return {
        "eligible": base is not None and 0x4E00 <= base <= 0x9EFF and len(latin) >= 8,
        "cmap_base": base,
        "latin_glyph_count": len(latin),
    }


def unicode_cmap(encoding: dict[int, str]) -> bytes:
    from pypdf._codecs import adobe_glyphs

    pairs = []
    for code, name in sorted(encoding.items()):
        text = adobe_glyphs.get("/" + name)
        if text is None:
            raise ValueError(f"embedded glyph has no Adobe Unicode mapping: {name}")
        # Expand presentation ligatures, preserving punctuation and all other glyphs.
        if text in "ﬀﬁﬂﬃﬄ":
            text = unicodedata.normalize("NFKC", text)
        pairs.append(f"<{code:02X}> <{text.encode('utf-16-be').hex().upper()}>")
    return (
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        "/CIDSystemInfo << /Registry (CapyBench) /Ordering (EmbeddedGlyphs) /Supplement 0 >> def\n"
        "/CMapName /EmbeddedGlyphs def /CMapType 2 def\n"
        "1 begincodespacerange <00> <FF> endcodespacerange\n"
        f"{len(pairs)} beginbfchar\n"
        + "\n".join(pairs)
        + "\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end\n"
    ).encode()


def eligible_fonts(doc: pymupdf.Document) -> list[dict]:
    """Fonts whose embedded encoding array contradicts their ToUnicode map."""
    fonts: dict[int, dict] = {}
    for page in doc:
        for xref in sorted({font[0] for font in page.get_fonts(full=True)}):
            if xref in fonts:
                continue
            name, extension, kind, program = doc.extract_font(xref)
            record = {"xref": xref, "name": name, "eligible": False}
            fonts[xref] = record
            if (
                kind != "Type1"
                or extension != "pfa"
                or doc.xref_get_key(xref, "Encoding")[0] != "null"
            ):
                continue
            encoding = explicit_encoding(program)
            unicode_key = doc.xref_get_key(xref, "ToUnicode")
            if not encoding or unicode_key[0] != "xref":
                continue
            cmap_xref = int(unicode_key[1].split()[0])
            cmap_bytes = doc.xref_stream(cmap_xref)
            record.update(contradiction(encoding, cmap_bytes.decode("latin1")))
            if record["eligible"]:
                try:
                    record["unicode_cmap"] = unicode_cmap(encoding)
                except ValueError:
                    # An unsupported glyph makes this optional repair unsafe,
                    # even if that encoding slot is unused on the page.
                    record["eligible"] = False
                    continue
                record["encoding"] = encoding
    return [font for font in fonts.values() if font["eligible"]]


def repair_fonts(data: bytes) -> tuple[bytes, int]:
    """Return the PDF the parser should read and how many fonts were rebuilt.

    A document without an eligible font is returned untouched, byte for byte,
    so its artifact geometry is measured on the uploaded bytes.
    """
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        selected = eligible_fonts(doc)
        if not selected:
            return data, 0
        for font in selected:
            xref = doc.get_new_xref()
            doc.update_object(xref, "<<>>")
            doc.update_stream(xref, font["unicode_cmap"])
            doc.xref_set_key(font["xref"], "ToUnicode", f"{xref} 0 R")
        return doc.tobytes(), len(selected)
