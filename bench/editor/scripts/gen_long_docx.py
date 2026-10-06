#!/usr/bin/env python3
"""Deterministic ~60-page DOCX for editor perf probes: mixed Latin and CJK
paragraphs, headings, a TOC field, PAGE/NUMPAGES footer fields, a header,
bullet lists, tables and inline pictures (the exchange-plan PNGs).

The shape picks what the sections hold, for the size ladder
(gen_office_ladder.py): `text` (the default, long-handbook.docx at 24
sections), `table` (two 24-row tables per section) or `picture` (two
different 320x240 pictures per section, ~230 KB each).

usage: gen_long_docx.py <exchange-plan.docx> <out.docx> [sections] [text|table|picture]
"""

import os
import random
import sys
import zipfile
from xml.sax.saxutils import escape

from ladder_media import noise_png

src, out = sys.argv[1], sys.argv[2]
SECTIONS = int(sys.argv[3]) if len(sys.argv) > 3 else 24
SHAPE = sys.argv[4] if len(sys.argv) > 4 else "text"
if SHAPE not in ("text", "table", "picture"):
    sys.exit(f"unknown shape {SHAPE}")
rng = random.Random(20261002)

LATIN = (
    "The exchange committee reviews every application against the published criteria before the "
    "spring deadline. Students should prepare a study plan, a budget and two references. "
    "Housing is arranged through the partner university, and the stipend covers tuition, travel "
    "and a monthly allowance. Course credits transfer when the home department approves the "
    "syllabus in advance. Late submissions are considered only when places remain after the "
    "first round of interviews."
).split(". ")
TC = [
    "交換學生計畫每年春季開放申請，申請人須提交學習計畫與預算表。",
    "合作大學提供宿舍，獎學金涵蓋學費、交通費及每月生活津貼。",
    "學分抵免須事先經系所審核課程大綱，並於返國後一個月內完成登記。",
    "面試委員會將依學業成績、語言能力與學習動機進行綜合評估。",
    "出發前請參加行前說明會，了解當地法規、保險與緊急聯絡方式。",
    "若名額尚有剩餘，委員會將於第二輪受理逾期申請。",
]
SC = [
    "本学期的课程安排包括语言强化训练和专业选修课。",
    "学生须在抵达后一周内完成注册，并提交健康证明。",
    "图书馆和实验室对交换学生全天开放，需凭学生证进入。",
    "期末考试成绩将直接转入本校成绩系统。",
]

NS = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
)


def run(text, rpr=""):
    return f'<w:r>{f"<w:rPr>{rpr}</w:rPr>" if rpr else ""}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def para(runs, ppr=""):
    return f'<w:p>{f"<w:pPr>{ppr}</w:pPr>" if ppr else ""}{runs}</w:p>'


def latin_sentences(n):
    return ". ".join(rng.choice(LATIN) for _ in range(n)) + "."


def mixed_paragraph():
    kind = rng.random()
    if kind < 0.35:
        return para(run(latin_sentences(rng.randint(4, 7))))
    if kind < 0.6:
        return para(run("".join(rng.choice(TC) for _ in range(rng.randint(3, 6)))))
    if kind < 0.7:
        return para(run("".join(rng.choice(SC) for _ in range(rng.randint(3, 5))), '<w:lang w:eastAsia="zh-CN"/>'))
    parts = []
    for _ in range(rng.randint(3, 5)):
        parts.append(run(latin_sentences(1) + " "))
        parts.append(run(rng.choice(TC), "<w:b/>" if rng.random() < 0.3 else ""))
    return para("".join(parts))


bookmark = 0
toc_entries = []


def heading(level, text):
    global bookmark
    bookmark += 1
    name = f"_Toc{100000 + bookmark}"
    toc_entries.append((level, text, name))
    return para(
        f'<w:bookmarkStart w:id="{bookmark}" w:name="{name}"/>{run(text)}<w:bookmarkEnd w:id="{bookmark}"/>',
        f'<w:pStyle w:val="Heading{level}"/>',
    )


def table(rows, cols):
    grid = "".join('<w:gridCol w:w="1800"/>' for _ in range(cols))
    body = []
    for r in range(rows):
        cells = []
        for c in range(cols):
            text = ["項目", "Budget", "說明", "Status", "備註"][c % 5] if r == 0 else (
                rng.choice(TC)[: rng.randint(4, 14)] if c % 2 else f"{rng.randint(100, 99999):,} TWD"
            )
            shade = '<w:shd w:val="clear" w:color="auto" w:fill="DCE6F2"/>' if r == 0 else ""
            cells.append(
                f'<w:tc><w:tcPr><w:tcW w:w="1800" w:type="dxa"/>{shade}</w:tcPr>'
                f'{para(run(text, "<w:b/>" if r == 0 else ""))}</w:tc>'
            )
        body.append(f'<w:tr>{"".join(cells)}</w:tr>')
    borders = "".join(
        f'<w:{side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
        for side in ("top", "left", "bottom", "right", "insideH", "insideV")
    )
    return (
        f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>{borders}</w:tblBorders></w:tblPr>'
        f'<w:tblGrid>{grid}</w:tblGrid>{"".join(body)}</w:tbl>'
    )


picture_id = 0


def picture(rid):
    global picture_id
    picture_id += 1
    cx, cy = 4572000, 2743200
    return para(
        f'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>'
        f'<wp:docPr id="{picture_id}" name="Picture {picture_id}"/>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        f'<pic:nvPicPr><pic:cNvPr id="{picture_id}" name="image"/><pic:cNvPicPr/></pic:nvPicPr>'
        f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>'
        "</wp:inline></w:drawing></w:r>",
        '<w:jc w:val="center"/>',
    )


def bullets(n):
    return "".join(
        para(run(rng.choice(TC) if i % 2 else latin_sentences(1)), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
        for i in range(n)
    )


body = [para(run("交換學生計畫手冊 Exchange Programme Handbook", '<w:sz w:val="48"/>'), '<w:jc w:val="center"/>')]
body.append(para(f'<w:fldSimple w:instr=" DATE \\@ &quot;yyyy-MM-dd&quot; ">{run("2026-10-02")}</w:fldSimple>', '<w:jc w:val="center"/>'))
# Body text above the TOC, so a probe click near the top of page 1 lands in it.
for _ in range(4):
    body.append(para(run(latin_sentences(5))))
    body.append(para(run("".join(rng.choice(TC) for _ in range(4)))))
toc_at = len(body)
pictures = []  # the picture shape's media, one per picture
for s in range(1, SECTIONS + 1):
    if SHAPE == "table":
        body.append(heading(1, f"{s}. 第{s}章 Chapter {s}"))
        body.append(mixed_paragraph())
        body.append(table(24, 5))
        body.append(heading(2, f"{s}.1 細則 Details"))
        body.append(table(24, 5))
        continue
    if SHAPE == "picture":
        body.append(heading(1, f"{s}. 第{s}章 Chapter {s}"))
        body.append(mixed_paragraph())
        for _ in range(2):
            pictures.append(noise_png(320, 240, len(pictures) + 1))
            body.append(picture(f"rIdPic{len(pictures)}"))
        continue
    body.append(heading(1, f"{s}. 第{s}章 Chapter {s}"))
    for sub in range(1, 3):
        body.append(heading(2, f"{s}.{sub} 細則 Details"))
        for _ in range(rng.randint(3, 5)):
            body.append(mixed_paragraph())
        if sub == 1:
            body.append(bullets(4))
    if s % 2 == 0:
        body.append(table(rng.randint(5, 9), 5))
    if s % 3 == 0 and not os.environ.get('NO_IMG'):
        body.append(picture(f"rIdImg{1 + s % 3}"))
    for _ in range(rng.randint(2, 4)):
        body.append(mixed_paragraph())

toc = [para(run("目錄 Contents", '<w:b/><w:sz w:val="32"/>'))]
for i, (level, text, name) in enumerate(toc_entries):
    begin = (
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        if i == 0
        else ""
    )
    entry = (
        f'<w:hyperlink w:anchor="{name}" w:history="1">{run(text)}<w:r><w:tab/></w:r>'
        f'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF {name} \\h </w:instrText></w:r>'
        f'<w:r><w:fldChar w:fldCharType="separate"/></w:r>{run(str(2 + i // 3))}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink>'
    )
    end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>' if i == len(toc_entries) - 1 else ""
    toc.append(para(begin + entry + end, f'<w:pStyle w:val="TOC{level}"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9350"/></w:tabs>'))
toc.append(para('<w:r><w:br w:type="page"/></w:r>'))
if not os.environ.get('NO_TOC'):
    body[toc_at:toc_at] = toc

sect = (
    '<w:sectPr>' + ('' if os.environ.get('NO_HF') else '<w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/>')
    + '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
)
document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document {NS}><w:body>{"".join(body)}{sect}</w:body></w:document>'

field = lambda instr, cached: (
    f'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> {instr} </w:instrText></w:r>'
    f'<w:r><w:fldChar w:fldCharType="separate"/></w:r>{run(cached)}<w:r><w:fldChar w:fldCharType="end"/></w:r>'
)
footer = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:ftr {NS}>{para(run("第 ") + field("PAGE", "1") + run(" 頁，共 ") + field("NUMPAGES", "60") + run(" 頁"), "<w:jc w:val=\"center\"/>")}</w:ftr>'
header = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:hdr {NS}>{para(run("Exchange Programme Handbook 交換學生計畫手冊", "<w:i/>"), "<w:jc w:val=\"right\"/>")}</w:hdr>'

styles = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles {NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="PMingLiU" w:hAnsi="Calibri" w:cs="Times New Roman"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Cambria" w:eastAsia="Microsoft JhengHei" w:hAnsi="Cambria"/><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TOC2"><w:name w:val="toc 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:ind w:left="220"/></w:pPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>"""

numbering = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering {NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>"""

R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
rels = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="{R}/styles" Target="styles.xml"/>
<Relationship Id="rIdNum" Type="{R}/numbering" Target="numbering.xml"/>
<Relationship Id="rIdHdr" Type="{R}/header" Target="header1.xml"/>
<Relationship Id="rIdFtr" Type="{R}/footer" Target="footer1.xml"/>
<Relationship Id="rIdImg1" Type="{R}/image" Target="media/image1.png"/>
<Relationship Id="rIdImg2" Type="{R}/image" Target="media/image2.png"/>
<Relationship Id="rIdImg3" Type="{R}/image" Target="media/image3.png"/>
{"".join(f'<Relationship Id="rIdPic{i}" Type="{R}/image" Target="media/pic{i}.png"/>' for i in range(1, len(pictures) + 1))}</Relationships>"""

ct = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>"""

root_rels = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{R}/officeDocument" Target="word/document.xml"/></Relationships>"""

def put(z, name, data):
    # A fixed timestamp keeps the output byte-identical run to run.
    info = zipfile.ZipInfo(name, date_time=(2026, 10, 2, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, data)


with zipfile.ZipFile(src) as source, zipfile.ZipFile(out, "w") as z:
    put(z, "[Content_Types].xml", ct)
    put(z, "_rels/.rels", root_rels)
    put(z, "word/_rels/document.xml.rels", rels)
    put(z, "word/document.xml", document)
    put(z, "word/styles.xml", styles)
    put(z, "word/numbering.xml", numbering)
    put(z, "word/header1.xml", header)
    put(z, "word/footer1.xml", footer)
    for i in (1, 2, 3):
        put(z, f"word/media/image{i}.png", source.read(f"word/media/image{i}.png"))
    for i, png in enumerate(pictures, start=1):
        put(z, f"word/media/pic{i}.png", png)
print(out, len(body), "blocks", len(toc_entries), "headings")
