"""Font-scoped PDF repairs before Java, which reads ToUnicode maps as written:

- a CJK ToUnicode map contradicting the embedded Type1 encoding array is rebuilt
  from that array (only the observed literal array is read; no PostScript runs);
- ToUnicode entries contradicting the font's own /Differences glyph names are
  rebuilt (Quartz re-saves of TeX output map /minus to U+0000, /delta to "d");
  TeX's /negationslash maps to U+0338 and ``compose_negations`` later joins it
  with the relation it negates;
- two-byte bfranges crossing a last-byte block (mPDF's <0000> <FFFF>) are split
  into the per-block ranges the spec allows, since veraPDF reads them strictly;
- TeX Type1 fonts with no ToUnicode (pdfTeX or dvips without glyphtounicode)
  get one from their built-in encoding array and a checked TeX glyph list.

The input PDF bytes are never changed in place."""

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
        for font in selected:
            xref = doc.get_new_xref()
            doc.update_object(xref, "<<>>")
            doc.update_stream(xref, font["unicode_cmap"])
            doc.xref_set_key(font["xref"], "ToUnicode", f"{xref} 0 R")
        repaired = (
            len(selected)
            + repair_named_glyphs(doc)
            + split_wide_ranges(doc)
            + map_tex_fonts(doc)
        )
        if not repaired:
            return data, 0
        return doc.tobytes(), repaired


def _font_xrefs(doc: pymupdf.Document) -> list[int]:
    return sorted({font[0] for page in doc for font in page.get_fonts(full=True)})


# One bfrange entry: <lo> <hi> followed by a destination string or an array of
# strings. Arrays are matched whole so their elements are never read as ranges.
_RANGE = re.compile(
    r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]*>)"
)


def split_wide_ranges(doc: pymupdf.Document) -> int:
    """Split two-byte bfranges that cross a last-byte block into per-block ranges.

    A block is rewritten only when its entries account for all of it, so a form
    this parser does not read is left as written. Returns the CMaps changed.
    """
    fixed, seen = 0, set()
    for font in _font_xrefs(doc):
        key = doc.xref_get_key(font, "ToUnicode")
        if key[0] != "xref" or key[1] in seen:
            continue
        seen.add(key[1])
        xref = int(key[1].split()[0])
        stream = doc.xref_stream(xref)
        if not stream:
            continue
        cmap = stream.decode("latin-1")
        parts, last = [], 0
        for match in re.finditer(r"\d+\s+beginbfrange(.*?)endbfrange", cmap, re.DOTALL):
            entries = "".join(m[0] for m in _RANGE.finditer(match[1]))
            if re.sub(r"\s+", "", entries) != re.sub(r"\s+", "", match[1]):
                continue
            lines, wide = [], False
            for a, b, dst in _RANGE.findall(match[1]):
                low, high = int(a, 16), int(b, 16)
                if (
                    len(a) != 4
                    or len(b) != 4
                    or low >> 8 == high >> 8
                    or not dst.startswith("<")
                    or len(dst) != 6
                ):
                    lines.append(f"<{a}> <{b}> {dst}")
                    continue
                wide, start, base = True, low, int(dst[1:-1], 16)
                while start <= high:
                    end = min(high, start | 0xFF)
                    lines.append(
                        f"<{start:04X}> <{end:04X}> <{base + start - low:04X}>"
                    )
                    start = end + 1
            if not wide:
                continue
            parts.append(cmap[last : match.start()])
            parts.append(
                "\n".join(
                    f"{len(lines[i : i + 100])} beginbfrange\n"
                    + "\n".join(lines[i : i + 100])
                    + "\nendbfrange"
                    for i in range(0, len(lines), 100)
                )
            )
            last = match.end()
        if parts:
            parts.append(cmap[last:])
            doc.update_stream(xref, "".join(parts).encode("latin-1"))
            fixed += 1
    return fixed


# TeX's extension pieces (pypdf maps them to private use) and its \not slash, a
# combining overlay that compose_negations joins with the following relation.
_TEX_GLYPHS = {
    "parenlefttp": "⎛",
    "parenleftex": "⎜",
    "parenleftbt": "⎝",
    "parenrighttp": "⎞",
    "parenrightex": "⎟",
    "parenrightbt": "⎠",
    "bracketlefttp": "⎡",
    "bracketleftex": "⎢",
    "bracketleftbt": "⎣",
    "bracketrighttp": "⎤",
    "bracketrightex": "⎥",
    "bracketrightbt": "⎦",
    "bracelefttp": "⎧",
    "braceleftmid": "⎨",
    "braceleftbt": "⎩",
    "bracerighttp": "⎫",
    "bracerightmid": "⎬",
    "bracerightbt": "⎭",
    "braceex": "⎪",
    "radicalbt": "⎷",
    "negationslash": "\u0338",
}


def _differences(encoding: str) -> dict[int, str]:
    match = re.search(r"/Differences\s*\[(.*?)\]", encoding, re.DOTALL)
    if not match:
        return {}
    names, code = {}, None
    for token in re.findall(r"\d+|/[^\s/\[\]()<>{}]+", match[1]):
        if token[0] == "/":
            if code is not None:
                names[code] = token[1:]
                code += 1
        else:
            code = int(token)
    return names


def _read_cmap(cmap: str) -> dict[int, str]:
    mapping = {}
    for block in re.findall(r"beginbfchar(.*?)endbfchar", cmap, re.DOTALL):
        for src, dst in re.findall(r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>", block):
            mapping[int(src, 16)] = bytes.fromhex(dst).decode("utf-16-be", "replace")
    for block in re.findall(r"beginbfrange(.*?)endbfrange", cmap, re.DOTALL):
        for a, b, dst in re.findall(
            r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>", block
        ):
            first = bytes.fromhex(dst).decode("utf-16-be", "replace")
            if len(first) == 1:
                for code in range(int(a, 16), int(b, 16) + 1):
                    mapping[code] = chr(ord(first) + code - int(a, 16))
    return mapping


def _glyph(name: str) -> str | None:
    from pypdf._codecs import adobe_glyphs

    if name in _TEX_GLYPHS:
        return _TEX_GLYPHS[name]
    value = adobe_glyphs.get("/" + name)
    if value is None and re.fullmatch(r"uni[0-9A-F]{4}", name):
        value = chr(int(name[3:], 16))
    if value is None or len(value) != 1 or 0xE000 <= ord(value) <= 0xF8FF:
        return None
    return value


# Computer Modern and AMS glyph names whose pypdf value is not the glyph TeX
# draws, checked against renders of the embedded fonts (turnstileleft is ⊢,
# circlecopyrt the big circle, CMMI's phi the stroked ϕ).
_TEX_NAMES = {
    "Delta": "Δ",
    "Omega": "Ω",
    "phi": "ϕ",
    "phi1": "φ",
    "lscript": "ℓ",
    "dotlessj": "ȷ",
    "triangle": "△",
    "triangleright": "▷",
    "turnstileleft": "⊢",
    "turnstileright": "⊣",
    "circlecopyrt": "◯",
    "diamond": "♢",
    "heart": "♡",
    "anticlockwise": "↺",
    "clockwise": "↻",
    # CMMI's old-style figures; pypdf maps them to private use.
    **{
        f"{name}oldstyle": str(digit)
        for digit, name in enumerate(
            ["zero", "one", "two", "three", "four"]
            + ["five", "six", "seven", "eight", "nine"]
        )
    },
}
# pdfTeX and dvips subset names: CMR10, CMMI10, CMSY10, CMEX10, MSAM10, ...
_TEX_FONT = re.compile(r"(?:[A-Z]{6}\+)?(?:CM[A-Z]{1,5}|MSAM|MSBM)\d+")


def map_tex_fonts(doc: pymupdf.Document) -> int:
    """Give embedded TeX Type1 fonts that have no ToUnicode and no /Encoding a
    map from their built-in encoding array (pdfTeX or dvips without
    glyphtounicode), which veraPDF would otherwise blank for TeX glyph names.
    Names without a checked Unicode value stay unmapped. Returns the fonts."""
    mapped = 0
    for xref in _font_xrefs(doc):
        if (
            doc.xref_get_key(xref, "Subtype")[1] != "/Type1"
            or doc.xref_get_key(xref, "ToUnicode")[0] != "null"
            or doc.xref_get_key(xref, "Encoding")[0] != "null"
            or not _TEX_FONT.fullmatch(doc.xref_get_key(xref, "BaseFont")[1][1:])
        ):
            continue
        _, extension, kind, program = doc.extract_font(xref)
        if kind != "Type1" or extension != "pfa":
            continue
        mapping = {}
        for code, glyph in explicit_encoding(program).items():
            value = _TEX_NAMES.get(glyph) or _glyph(glyph)
            if value and ord(value) >= 0x20:
                mapping[code] = value
        if mapping:
            _set_to_unicode(doc, xref, mapping, "TeXBuiltin")
            mapped += 1
    return mapped


def _contradicts(have: str, want: str) -> bool:
    if len(have) != 1 or unicodedata.normalize("NFKC", have) == (
        unicodedata.normalize("NFKC", want)
    ):
        return False
    # A control character, private use or U+FFFD is never a named glyph's meaning.
    if ord(have) < 0x20 or 0xE000 <= ord(have) <= 0xF8FF or have == "\ufffd":
        return True
    # Maths and Greek read as plain ASCII; quotes and dashes mapped to ASCII stay.
    maths = (
        unicodedata.category(want) == "Sm"
        or "\u0370" <= want <= "\u03ff"
        or "\u2190" <= want <= "\u23ff"
    )
    return have.isascii() and maths


def repair_named_glyphs(doc: pymupdf.Document) -> int:
    """Rebuild simple-font ToUnicode maps whose entries contradict the font's own
    /Differences glyph names. A font needs two contradicted entries, or one mapped
    to a control character or left unmapped. Returns the fonts rebuilt."""
    repaired = 0
    for xref in _font_xrefs(doc):
        if doc.xref_get_key(xref, "Subtype")[1] not in (
            "/Type1",
            "/TrueType",
            "/Type3",
        ):
            continue
        unicode_key = doc.xref_get_key(xref, "ToUnicode")
        encoding = doc.xref_get_key(xref, "Encoding")
        if unicode_key[0] != "xref" or encoding[0] not in ("dict", "xref"):
            continue
        names = _differences(
            encoding[1]
            if encoding[0] == "dict"
            else doc.xref_object(int(encoding[1].split()[0]))
        )
        stream = doc.xref_stream(int(unicode_key[1].split()[0]))
        if not names or not stream:
            continue
        try:
            cmap = _read_cmap(stream.decode("latin-1"))
        except ValueError:
            continue  # a malformed map reaches Java as written
        bad = {}
        for code, name in names.items():
            want, have = _glyph(name), cmap.get(code)
            if want is not None and have is not None and _contradicts(have, want):
                bad[code] = (have, want)
            # A \not slash left out of the map (Ghostscript) or mapped to ASCII:
            # veraPDF blanks the first, and the relation then reads un-negated.
            if name == "negationslash" and (have is None or have.isascii()):
                bad[code] = (have or "\ufffd", "\u0338")
        control = any(
            len(have) == 1 and (ord(have) < 0x20 or have == "\ufffd")
            for have, _ in bad.values()
        )
        if len(bad) < 2 and not control:
            continue
        mapping = {**cmap, **{code: want for code, (_, want) in bad.items()}}
        _set_to_unicode(
            doc,
            xref,
            {code: value for code, value in mapping.items() if value and code <= 0xFF},
            "GlyphNames",
        )
        repaired += 1
    return repaired


def _set_to_unicode(
    doc: pymupdf.Document, font: int, mapping: dict[int, str], name: str
) -> None:
    """Point a simple font at a new one-byte ToUnicode CMap."""
    pairs = [
        f"<{code:02X}> <{value.encode('utf-16-be').hex().upper()}>"
        for code, value in sorted(mapping.items())
    ]
    stream = (
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        f"/CIDSystemInfo << /Registry (Capy) /Ordering ({name}) /Supplement 0 >> def\n"
        f"/CMapName /Capy{name} def /CMapType 2 def\n"
        "1 begincodespacerange <00> <FF> endcodespacerange\n"
        + "".join(
            f"{len(pairs[i : i + 100])} beginbfchar\n"
            + "\n".join(pairs[i : i + 100])
            + "\nendbfchar\n"
            for i in range(0, len(pairs), 100)
        )
        + "endcmap CMapName currentdict /CMap defineresource pop end end\n"
    ).encode()
    new = doc.get_new_xref()
    doc.update_object(new, "<<>>")
    doc.update_stream(new, stream)
    doc.xref_set_key(font, "ToUnicode", f"{new} 0 R")


# TeX sets the \not slash before the relation it negates.
_NEGATED = dict(zip("=∈∋≡<>≤≥⊂⊃⊆⊇∼≈≃≅∥∣⊢⊨", "≠∉∌≢≮≯≰≱⊄⊅⊈⊉≁≉≄≇∦∤⊬⊭", strict=True))
_SLASH = re.compile("\u0338\\s*(" + "|".join(map(re.escape, _NEGATED)) + ")")


def compose_negations(blocks: list[dict]) -> list[dict]:
    """Join each U+0338 slash with the relation after it (≠ ∉ ∌ ≢ ...), in place."""

    def compose(text: str) -> str:
        return _SLASH.sub(lambda m: _NEGATED[m[1]], text)

    for block in blocks:
        for key in ("text", "table_body"):
            if isinstance(block.get(key), str) and "\u0338" in block[key]:
                block[key] = compose(block[key])
        items = block.get("list_items")
        if isinstance(items, list) and any("\u0338" in str(i) for i in items):
            block["list_items"] = [compose(str(i)) for i in items]
    return blocks
