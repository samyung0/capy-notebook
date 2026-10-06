#!/usr/bin/env python3
"""Deterministic PPTX for the size ladder (gen_office_ladder.py), the same
bytes run to run. One master, one layout and a minimal theme, then per slide
a title and, by shape:

- `text`: a body of 12 bullet paragraphs of mixed Latin and CJK, plus a
  two-column note box under it;
- `picture`: two different 480x270 pictures (~380 KB each, see ladder_media).

usage: gen_large_pptx.py <out.pptx> [slides] [text|picture]
"""

import random
import sys
import zipfile
from xml.sax.saxutils import escape

from ladder_media import noise_png

out = sys.argv[1]
SLIDES = int(sys.argv[2]) if len(sys.argv) > 2 else 84
SHAPE = sys.argv[3] if len(sys.argv) > 3 else "text"
if SHAPE not in ("text", "picture"):
    sys.exit(f"unknown shape {SHAPE}")
rng = random.Random(20261006)

# 16:9 at 13.333 x 7.5 in.
CX, CY = 12192000, 6858000
LATIN = (
    "Attention weights decide which earlier tokens each position reads. "
    "Scaling the model and the data together keeps the loss falling smoothly. "
    "Instruction tuning aligns the outputs with what the reader asked for. "
    "Evaluation sets must stay out of the training mix to mean anything. "
    "Mixed precision halves the memory of activations without hurting accuracy. "
    "Retrieval adds documents the model never saw to the prompt at answer time."
).split(". ")
CJK = [
    "大規模言語モデルは次の単語を予測するように学習される。",
    "事前学習の後に指示データで追加学習を行う。",
    "評価データは学習データと分けて管理する必要がある。",
    "計算資源とデータ量を同時に増やすと損失は滑らかに下がる。",
    "注意機構は各位置がどの過去の単語を参照するかを決める。",
]

P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'


def sentence():
    return rng.choice(LATIN).strip() + "." if rng.random() < 0.6 else rng.choice(CJK)


def xfrm(x, y, w, h):
    return f'<a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>'


def text_box(shape_id, name, box, paragraphs, size=1800, ph="", bullets=False):
    nv = f'<p:nvSpPr><p:cNvPr id="{shape_id}" name="{name}"/><p:cNvSpPr txBox="{0 if ph else 1}"/><p:nvPr>{ph}</p:nvPr></p:nvSpPr>'
    ppr = '<a:pPr marL="285750" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>' if bullets else ""
    body = "".join(
        f'<a:p>{ppr}<a:r><a:rPr lang="en-US" sz="{size}" dirty="0"/><a:t>{escape(text)}</a:t></a:r></a:p>' for text in paragraphs
    )
    return (
        f'<p:sp>{nv}<p:spPr>{xfrm(*box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
        f'<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>{body}</p:txBody></p:sp>'
    )


def picture(shape_id, rid, box):
    return (
        f'<p:pic><p:nvPicPr><p:cNvPr id="{shape_id}" name="Picture {shape_id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
        f'<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        f'<p:spPr>{xfrm(*box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
    )


def tree(shapes, head=""):
    """A slide's shape tree; `head` goes first in cSld (a master's background)."""
    return (
        f"<p:cSld>{head}<p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        f"{shapes}</p:spTree></p:cSld>"
    )


TITLE_BOX = (457200, 228600, CX - 914400, 914400)
slides, media = [], []
for number in range(1, SLIDES + 1):
    title = text_box(2, "Title 1", TITLE_BOX, [f"{number}. {sentence()}"], 3200, '<p:ph type="title"/>')
    rels = [f'<Relationship Id="rId1" Type="{R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>']
    if SHAPE == "text":
        body = text_box(3, "Content 2", (457200, 1257300, CX - 914400, 3886200), [sentence() for _ in range(12)], 1600, '<p:ph idx="1"/>', True)
        notes = text_box(4, "Note 3", (457200, 5257800, CX - 914400, 1143000), [" ".join(sentence() for _ in range(3)) for _ in range(2)], 1200)
        shapes = title + body + notes
    else:
        shapes = title
        for i in range(2):
            media.append(noise_png(480, 270, len(media) + 1))
            rels.append(f'<Relationship Id="rId{2 + i}" Type="{R}/image" Target="../media/image{len(media)}.png"/>')
            shapes += picture(3 + i, f"rId{2 + i}", (457200 + i * (CX // 2), 1600200, CX // 2 - 914400, (CX // 2 - 914400) * 9 // 16))
    slides.append(
        (
            f'{HEAD}<p:sld {P}>{tree(shapes)}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
            f'{HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{"".join(rels)}</Relationships>',
        )
    )

COLOURS = [
    ("dk1", '<a:sysClr val="windowText" lastClr="000000"/>'),
    ("lt1", '<a:sysClr val="window" lastClr="FFFFFF"/>'),
    ("dk2", '<a:srgbClr val="1F3864"/>'),
    ("lt2", '<a:srgbClr val="E7E6E6"/>'),
    ("accent1", '<a:srgbClr val="4472C4"/>'),
    ("accent2", '<a:srgbClr val="ED7D31"/>'),
    ("accent3", '<a:srgbClr val="A5A5A5"/>'),
    ("accent4", '<a:srgbClr val="FFC000"/>'),
    ("accent5", '<a:srgbClr val="5B9BD5"/>'),
    ("accent6", '<a:srgbClr val="70AD47"/>'),
    ("hlink", '<a:srgbClr val="0563C1"/>'),
    ("folHlink", '<a:srgbClr val="954F72"/>'),
]
FONT = '<a:latin typeface="{0}"/><a:ea typeface=""/><a:cs typeface=""/>'
FILL = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
LINE = '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
theme = (
    f'{HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Ladder"><a:themeElements>'
    f'<a:clrScheme name="Ladder">{"".join(f"<a:{name}>{value}</a:{name}>" for name, value in COLOURS)}</a:clrScheme>'
    f'<a:fontScheme name="Ladder"><a:majorFont>{FONT.format("Calibri Light")}</a:majorFont><a:minorFont>{FONT.format("Calibri")}</a:minorFont></a:fontScheme>'
    f'<a:fmtScheme name="Ladder"><a:fillStyleLst>{FILL * 3}</a:fillStyleLst><a:lnStyleLst>{LINE * 3}</a:lnStyleLst>'
    f'<a:effectStyleLst>{"<a:effectStyle><a:effectLst/></a:effectStyle>" * 3}</a:effectStyleLst><a:bgFillStyleLst>{FILL * 3}</a:bgFillStyleLst></a:fmtScheme>'
    "</a:themeElements></a:theme>"
)
CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
master_shapes = text_box(2, "Title Placeholder 1", TITLE_BOX, ["Title"], 3200, '<p:ph type="title"/>') + text_box(
    3, "Text Placeholder 2", (457200, 1257300, CX - 914400, 4572000), ["Text"], 1800, '<p:ph type="body" idx="1"/>'
)
BACKGROUND = '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
master = (
    f"{HEAD}<p:sldMaster {P}>{tree(master_shapes, BACKGROUND)}{CLR_MAP}"
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle>'
    '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>'
    "</p:sldMaster>"
)
layout = (
    f'{HEAD}<p:sldLayout {P} type="obj" preserve="1">{tree(master_shapes)}'
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
)
presentation = (
    f'{HEAD}<p:presentation {P} saveSubsetFonts="1">'
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>'
    + "<p:sldIdLst>"
    + "".join(f'<p:sldId id="{255 + i}" r:id="rIdSlide{i}"/>' for i in range(1, SLIDES + 1))
    + "</p:sldIdLst>"
    + f'<p:sldSz cx="{CX}" cy="{CY}"/><p:notesSz cx="{CY}" cy="{CX}"/></p:presentation>'
)
presentation_rels = (
    f'{HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    f'<Relationship Id="rIdMaster" Type="{R}/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
    f'<Relationship Id="rIdTheme" Type="{R}/theme" Target="theme/theme1.xml"/>'
    + "".join(f'<Relationship Id="rIdSlide{i}" Type="{R}/slide" Target="slides/slide{i}.xml"/>' for i in range(1, SLIDES + 1))
    + "</Relationships>"
)
master_rels = (
    f'{HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    f'<Relationship Id="rId1" Type="{R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
    f'<Relationship Id="rId2" Type="{R}/theme" Target="../theme/theme1.xml"/></Relationships>'
)
layout_rels = (
    f'{HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    f'<Relationship Id="rId1" Type="{R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>'
)
PML = "application/vnd.openxmlformats-officedocument.presentationml"
content_types = (
    f'{HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
    f'<Override PartName="/ppt/presentation.xml" ContentType="{PML}.presentation.main+xml"/>'
    f'<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="{PML}.slideMaster+xml"/>'
    f'<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="{PML}.slideLayout+xml"/>'
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + "".join(f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="{PML}.slide+xml"/>' for i in range(1, SLIDES + 1))
    + "</Types>"
)
root_rels = (
    f'{HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    f'<Relationship Id="rId1" Type="{R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>'
)


def put(z, name, data):
    # A fixed timestamp keeps the output byte-identical run to run.
    info = zipfile.ZipInfo(name, date_time=(2026, 10, 6, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, data)


with zipfile.ZipFile(out, "w") as z:
    put(z, "[Content_Types].xml", content_types)
    put(z, "_rels/.rels", root_rels)
    put(z, "ppt/presentation.xml", presentation)
    put(z, "ppt/_rels/presentation.xml.rels", presentation_rels)
    put(z, "ppt/slideMasters/slideMaster1.xml", master)
    put(z, "ppt/slideMasters/_rels/slideMaster1.xml.rels", master_rels)
    put(z, "ppt/slideLayouts/slideLayout1.xml", layout)
    put(z, "ppt/slideLayouts/_rels/slideLayout1.xml.rels", layout_rels)
    put(z, "ppt/theme/theme1.xml", theme)
    for i, (slide, rels) in enumerate(slides, start=1):
        put(z, f"ppt/slides/slide{i}.xml", slide)
        put(z, f"ppt/slides/_rels/slide{i}.xml.rels", rels)
    for i, png in enumerate(media, start=1):
        put(z, f"ppt/media/image{i}.png", png)
print(out, SLIDES, "slides", len(media), "pictures")
