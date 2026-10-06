#!/usr/bin/env python3
"""Deterministic large XLSX for the Office perf spec: a school gradebook with
eight class sheets of 2,000 students each (scores, then per-row SUM, AVERAGE
and nested IF formulas) and a Summary sheet of cross-sheet COUNTA, AVERAGE,
MAX and COUNTIF formulas. Every formula carries its cached value, frozen
header rows, shared strings for names.

The shape, for the size ladder (gen_office_ladder.py): `formula` (the
default, large-gradebook.xlsx at 8 sheets of 2,000 rows), `values` (the same
cells, every formula replaced by its cached value) or `style` (the values,
each cell in one of 512 distinct formats: fill, font colour, border, number
format).

usage: gen_large_xlsx.py <out.xlsx> [sheets] [rows] [formula|values|style]
"""

import random
import re
import sys
import zipfile
from xml.sax.saxutils import escape

out = sys.argv[1]
SHEETS = int(sys.argv[2]) if len(sys.argv) > 2 else 8
ROWS = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
SHAPE = sys.argv[4] if len(sys.argv) > 4 else "formula"
if SHAPE not in ("formula", "values", "style"):
    sys.exit(f"unknown shape {SHAPE}")
rng = random.Random(20261004)
# The style shape's formats, after the three base ones.
STYLES = 512

FIRST = ["Aiko", "Ben", "Chen", "Dana", "Eli", "Fatima", "Grace", "Hiro", "Ivan", "Jia",
         "Kofi", "Lena", "Mei", "Noah", "Omar", "Priya", "Quinn", "Rosa", "Sven", "Tara"]
LAST = ["Wong", "Smith", "Tanaka", "Okafor", "Garcia", "Kim", "Novak", "Haddad", "Silva", "Lee",
        "Brown", "Ito", "Khan", "Moreau", "Rossi", "Chan", "Park", "Nguyen", "Fischer", "Ali"]
GROUPS = ["Morning", "Afternoon", "Evening"]
TESTS = 8
HEAD = ["ID", "Name", "Group"] + [f"Test {n}" for n in range(1, TESTS + 1)] + ["Total", "Average", "Grade"]
# Test columns D..K, then Total L, Average M, Grade N.
COLS = [chr(ord("A") + i) for i in range(len(HEAD))]
FIRST_TEST, LAST_TEST = COLS[3], COLS[3 + TESTS - 1]

strings, index = [], {}


def sst(text):
    if text not in index:
        index[text] = len(strings)
        strings.append(text)
    return index[text]


def st(style):
    return f' s="{style}"' if style else ""


def s(ref, text, style=0):
    return f'<c r="{ref}" t="s"{st(style)}><v>{sst(text)}</v></c>'


def n(ref, value, style=0):
    return f'<c r="{ref}"{st(style)}><v>{value}</v></c>'


def f(ref, formula, value, style=0, text=False):
    if SHAPE != "formula":
        # The cached value alone, as a plain cell.
        return s(ref, value, style) if text else n(ref, value, style)
    t = ' t="str"' if text else ""
    return f'<c r="{ref}"{t}{st(style)}><f>{escape(formula)}</f><v>{value}</v></c>'


def styled(cells, r):
    """The style shape: every cell of row r in its own format."""
    if SHAPE != "style":
        return cells
    return [
        re.sub(r'^<c r="([A-Z]+\d+)"(?: s="\d+")?', f'<c r="\\1" s="{3 + (r * 13 + c * 7) % STYLES}"', cell, count=1)
        for c, cell in enumerate(cells)
    ]


def grade(avg):
    return "A" if avg >= 80 else "B" if avg >= 65 else "C" if avg >= 50 else "D"


def fmt(x):
    # Excel's cached doubles; repr round-trips exactly.
    return repr(float(x)) if x != int(x) else str(int(x))


SHEET_HEAD = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
)
FROZEN = (
    '<sheetViews><sheetView workbookViewId="0"{tab}><pane ySplit="1" topLeftCell="A2" '
    'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    '<sheetFormatPr defaultRowHeight="15"/>'
)


def class_sheet(number):
    rows = [f'<row r="1">{"".join(s(f"{c}1", h, 1) for c, h in zip(COLS, HEAD))}</row>']
    stats = {"count": 0, "sum": 0.0, "max": 0.0, "a": 0}
    for r in range(2, ROWS + 2):
        scores = [rng.randint(25, 100) for _ in range(TESTS)]
        total = sum(scores)
        avg = total / TESTS
        g = grade(avg)
        stats["count"] += 1
        stats["sum"] += avg
        stats["max"] = max(stats["max"], avg)
        stats["a"] += g == "A"
        cells = [
            n(f"A{r}", number * 10000 + r - 1),
            s(f"B{r}", f"{rng.choice(FIRST)} {rng.choice(LAST)}"),
            s(f"C{r}", rng.choice(GROUPS)),
            *(n(f"{COLS[3 + i]}{r}", v) for i, v in enumerate(scores)),
            f(f"L{r}", f"SUM({FIRST_TEST}{r}:{LAST_TEST}{r})", total),
            f(f"M{r}", f"AVERAGE({FIRST_TEST}{r}:{LAST_TEST}{r})", fmt(avg), 2),
            f(f"N{r}", f'IF(M{r}>=80,"A",IF(M{r}>=65,"B",IF(M{r}>=50,"C","D")))', g, text=True),
        ]
        cells = styled(cells, r)
        rows.append(f'<row r="{r}">{"".join(cells)}</row>')
    cols = '<cols><col min="1" max="1" width="9" customWidth="1"/><col min="2" max="2" width="18" customWidth="1"/></cols>'
    xml = (
        SHEET_HEAD
        + f'<dimension ref="A1:N{ROWS + 1}"/>'
        + FROZEN.format(tab=' tabSelected="1"' if number == 1 else "")
        + cols
        + f'<sheetData>{"".join(rows)}</sheetData></worksheet>'
    )
    return xml, stats


sheets, summary = [], []
for number in range(1, SHEETS + 1):
    xml, stats = class_sheet(number)
    sheets.append((f"Class {number}", xml))
    summary.append(stats)

last = ROWS + 1
srows = [f'<row r="1">{"".join(s(f"{c}1", h, 1) for c, h in zip("ABCDE", ["Class", "Students", "Mean average", "Best average", "Grade A"]))}</row>']
for i, stats in enumerate(summary, start=2):
    name = f"Class {i - 1}"
    q = f"'{name}'!"
    srows.append(
        f'<row r="{i}">'
        + s(f"A{i}", name)
        + f(f"B{i}", f"COUNTA({q}B2:B{last})", stats["count"])
        + f(f"C{i}", f"AVERAGE({q}M2:M{last})", fmt(stats["sum"] / stats["count"]), 2)
        + f(f"D{i}", f"MAX({q}M2:M{last})", fmt(stats["max"]), 2)
        + f(f"E{i}", f'COUNTIF({q}N2:N{last},"A")', stats["a"])
        + "</row>"
    )
sheets.append(("Summary", SHEET_HEAD + f'<dimension ref="A1:E{SHEETS + 1}"/>' + FROZEN.format(tab="")
               + f'<sheetData>{"".join(srows)}</sheetData></worksheet>'))

R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
workbook = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    f'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="{R}">'
    '<bookViews><workbookView activeTab="0"/></bookViews><sheets>'
    + "".join(f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>' for i, (name, _) in enumerate(sheets, start=1))
    + '</sheets><calcPr calcId="191029"/></workbook>'
)
workbook_rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + "".join(f'<Relationship Id="rId{i}" Type="{R}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets) + 1))
    + f'<Relationship Id="rIdStyles" Type="{R}/styles" Target="styles.xml"/>'
    + f'<Relationship Id="rIdStrings" Type="{R}/sharedStrings" Target="sharedStrings.xml"/>'
    + "</Relationships>"
)
# 0 default, 1 bold header on grey, 2 one decimal place; the style shape's
# formats after them.
PALETTE = ["FFF2CC", "DDEBF7", "E2EFDA", "FCE4D6", "EDEDED", "FFE699", "BDD7EE", "C6E0B4"]
FONT_COLOURS = ["FF000000", "FF1F4E79", "FF833C0B", "FF375623"]
NUMBER_FORMATS = ["0", "0.0", "0.00", "#,##0", "0%", "0.0%", "#,##0.00", "0.000"]


def style_parts():
    if SHAPE != "style":
        return "", "", "", ""
    fills = "".join(
        f'<fill><patternFill patternType="solid"><fgColor rgb="FF{PALETTE[i % 8]}"/></patternFill></fill>' for i in range(8)
    )
    fonts = "".join(
        f'<font>{"<b/>" if i % 2 else ""}<sz val="11"/><color rgb="{FONT_COLOURS[i // 2]}"/><name val="Calibri"/></font>'
        for i in range(8)
    )
    borders = '<border><left style="thin"><color rgb="FF808080"/></left><right style="thin"><color rgb="FF808080"/></right><top/><bottom style="hair"/><diagonal/></border>'
    xfs = "".join(
        f'<xf numFmtId="{165 + (i // 64) % 8}" fontId="{2 + (i // 8) % 8}" fillId="{3 + i % 8}" borderId="{1 + (i // 256)}" xfId="0" '
        'applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>'
        for i in range(STYLES)
    )
    return fills, fonts, borders * 2, xfs


extra_fills, extra_fonts, extra_borders, extra_xfs = style_parts()
formats = "".join(f'<numFmt numFmtId="{165 + i}" formatCode="{escape(code)}"/>' for i, code in enumerate(NUMBER_FORMATS))
styles = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + (f'<numFmts count="{1 + len(NUMBER_FORMATS)}"><numFmt numFmtId="164" formatCode="0.0"/>{formats}</numFmts>'
       if SHAPE == "style" else '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>')
    + f'<fonts count="{2 + (8 if extra_fonts else 0)}"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font>{extra_fonts}</fonts>'
    f'<fills count="{3 + (8 if extra_fills else 0)}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    f'<fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/></patternFill></fill>{extra_fills}</fills>'
    f'<borders count="{1 + (2 if extra_borders else 0)}"><border><left/><right/><top/><bottom/><diagonal/></border>{extra_borders}</borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    f'<cellXfs count="{3 + (STYLES if extra_xfs else 0)}"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    f'<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>{extra_xfs}</cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
)
shared = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" uniqueCount="{len(strings)}">'
    + "".join(f"<si><t>{escape(t)}</t></si>" for t in strings)
    + "</sst>"
)
ct = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + "".join(
        f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for i in range(1, len(sheets) + 1)
    )
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    "</Types>"
)
root_rels = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    f'<Relationship Id="rId1" Type="{R}/officeDocument" Target="xl/workbook.xml"/></Relationships>'
)


def put(z, name, data):
    # A fixed timestamp keeps the output byte-identical run to run.
    info = zipfile.ZipInfo(name, date_time=(2026, 10, 4, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, data)


with zipfile.ZipFile(out, "w") as z:
    put(z, "[Content_Types].xml", ct)
    put(z, "_rels/.rels", root_rels)
    put(z, "xl/workbook.xml", workbook)
    put(z, "xl/_rels/workbook.xml.rels", workbook_rels)
    put(z, "xl/styles.xml", styles)
    put(z, "xl/sharedStrings.xml", shared)
    for i, (_, xml) in enumerate(sheets, start=1):
        put(z, f"xl/worksheets/sheet{i}.xml", xml)
