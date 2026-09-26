"""Generate realistic Office test files with zipfile and hand-written OOXML.

Outputs into ./files/:
  book-30p.docx, book-300p.docx      text-only, book-like (headings, paragraphs, a few lists)
  images-10.docx                      ~10 PNG/JPEG images totalling a few MB, plus text
  opaque-objects.docx                 charts, mc:AlternateContent text boxes, w:pict, w:object
  cells-1k.xlsx ... cells-100k.xlsx   10 columns: numbers, text, dates, 10% formulas, 5 styles
  deck-50.pptx                        50 text-heavy slides on the python-pptx default template
Deterministic (seeded RNG).
"""

import io
import random
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image, ImageDraw

ROOT = Path(__file__).parent
OUT = ROOT / "files"
OUT.mkdir(exist_ok=True)
LESSON_DOCX = Path("C:/WEB/capy-notebook/e2e/fixtures/files/basic/lesson.docx")
LESSON_PPTX = Path("C:/WEB/capy-notebook/e2e/fixtures/files/basic/lesson.pptx")
GRADES_XLSX = Path("C:/WEB/capy-notebook/e2e/fixtures/files/basic/grades.xlsx")

WORDS = [
    "the",
    "of",
    "and",
    "to",
    "in",
    "is",
    "that",
    "for",
    "it",
    "as",
    "was",
    "with",
    "be",
    "by",
    "on",
    "not",
    "he",
    "this",
    "are",
    "or",
    "his",
    "from",
    "at",
    "which",
    "but",
    "have",
    "an",
    "they",
    "you",
    "were",
    "her",
    "she",
    "there",
    "been",
    "one",
    "all",
    "we",
    "their",
    "has",
    "would",
    "when",
    "if",
    "so",
    "what",
    "out",
    "up",
    "more",
    "about",
    "into",
    "them",
    "can",
    "other",
    "some",
    "could",
    "time",
    "these",
    "two",
    "may",
    "then",
    "do",
    "first",
    "any",
    "like",
    "my",
    "now",
    "over",
    "such",
    "our",
    "man",
    "me",
    "even",
    "most",
    "made",
    "after",
    "also",
    "did",
    "many",
    "before",
    "must",
    "through",
    "back",
    "years",
    "where",
    "much",
    "your",
    "way",
    "well",
    "down",
    "should",
    "because",
    "each",
    "just",
    "those",
    "people",
    "how",
    "too",
    "little",
    "state",
    "good",
    "very",
    "make",
    "world",
    "still",
    "own",
    "see",
    "men",
    "work",
    "long",
    "get",
    "here",
    "between",
    "both",
    "life",
    "being",
    "under",
    "never",
    "day",
    "same",
    "another",
    "know",
    "while",
    "last",
    "might",
    "us",
    "great",
    "old",
    "year",
    "off",
    "come",
    "since",
    "against",
    "go",
    "came",
    "right",
    "used",
    "take",
    "three",
    "states",
    "himself",
    "few",
    "house",
    "use",
    "during",
    "without",
    "again",
    "place",
    "around",
    "however",
    "home",
    "small",
    "found",
    "thought",
    "went",
    "say",
    "part",
    "once",
    "general",
    "high",
    "upon",
    "school",
    "every",
    "does",
    "got",
    "united",
    "left",
    "number",
    "course",
    "war",
    "until",
    "always",
    "away",
    "something",
    "fact",
    "though",
    "water",
    "less",
    "public",
    "put",
    "think",
    "almost",
    "hand",
    "enough",
    "far",
    "took",
    "head",
    "yet",
    "government",
    "system",
    "better",
    "set",
    "told",
    "nothing",
    "night",
    "end",
    "why",
    "called",
    "didn't",
    "eyes",
    "find",
    "going",
    "look",
    "asked",
    "later",
    "knew",
    "point",
    "next",
    "program",
    "city",
    "business",
    "give",
    "group",
    "toward",
    "young",
    "days",
    "let",
    "room",
    "president",
    "side",
    "social",
    "given",
    "present",
    "several",
    "order",
    "national",
    "possible",
    "rather",
    "second",
    "face",
    "per",
    "among",
    "form",
    "important",
    "often",
    "things",
    "looked",
    "early",
    "white",
    "case",
    "john",
    "become",
    "large",
    "big",
    "need",
    "four",
    "within",
    "felt",
    "along",
    "children",
    "saw",
    "best",
    "church",
    "ever",
    "least",
    "power",
    "development",
    "light",
    "thing",
    "seemed",
    "family",
    "interest",
    "want",
    "members",
    "mind",
    "country",
    "area",
    "others",
    "done",
    "turned",
    "although",
    "open",
    "god",
    "service",
    "certain",
    "kind",
    "problem",
    "began",
    "different",
    "door",
    "thus",
    "help",
    "sense",
    "means",
    "whole",
    "matter",
    "perhaps",
    "itself",
    "york",
    "times",
    "law",
    "human",
    "line",
    "above",
    "name",
    "example",
    "action",
    "company",
    "hands",
    "local",
    "show",
    "whether",
    "five",
    "history",
    "gave",
    "today",
    "either",
    "act",
    "feet",
    "across",
    "taken",
    "past",
    "quite",
    "anything",
    "seen",
    "having",
    "death",
    "week",
    "experience",
    "body",
    "word",
    "half",
    "really",
    "field",
    "am",
    "car",
    "words",
    "already",
    "themselves",
    "information",
    "tell",
    "college",
    "shall",
    "money",
    "period",
    "held",
    "keep",
    "sure",
    "probably",
    "free",
    "seems",
    "political",
    "real",
    "cannot",
    "behind",
    "miss",
    "question",
    "air",
    "office",
    "making",
    "brought",
    "whose",
    "special",
    "heard",
    "major",
    "problems",
    "ago",
    "became",
    "federal",
    "moment",
    "study",
    "available",
    "known",
    "result",
    "street",
    "economic",
    "boy",
    "position",
    "reason",
    "change",
    "south",
    "board",
    "individual",
    "job",
    "areas",
    "society",
    "west",
    "close",
    "turn",
    "love",
    "community",
    "true",
    "court",
    "force",
    "full",
    "seem",
    "wife",
    "age",
    "future",
    "voice",
    "center",
    "woman",
    "control",
    "common",
    "policy",
    "necessary",
    "following",
    "front",
    "sometimes",
    "six",
    "girl",
    "clear",
    "further",
    "land",
    "run",
    "students",
    "provide",
    "feel",
    "party",
    "able",
    "mother",
    "music",
    "education",
    "university",
    "child",
    "effect",
    "level",
    "stood",
    "military",
    "town",
    "short",
    "morning",
    "total",
    "outside",
    "rate",
    "figure",
    "class",
    "art",
    "century",
    "washington",
    "north",
    "usually",
    "plan",
    "leave",
    "therapy",
    "evidence",
    "photosynthesis",
    "membrane",
    "enzyme",
    "cellular",
    "organism",
    "gradient",
    "theorem",
    "hypothesis",
    "variable",
    "equation",
    "derivative",
    "integral",
    "function",
    "velocity",
    "momentum",
    "reaction",
    "molecule",
    "protein",
]
NAMES = [
    "Chloroplast",
    "Mitochondria",
    "Newton",
    "Faraday",
    "Kyoto",
    "Amazon",
    "Riemann",
    "Curie",
    "Darwin",
    "Mendel",
]


def sentence(rng: random.Random, lo=8, hi=24) -> str:
    n = rng.randint(lo, hi)
    words = [rng.choice(WORDS) for _ in range(n)]
    if rng.random() < 0.3:
        words[rng.randrange(n)] = rng.choice(NAMES)
    if n > 12 and rng.random() < 0.4:
        words[rng.randrange(3, n - 3)] += ","
    s = " ".join(words)
    return s[0].upper() + s[1:] + rng.choice([".", ".", ".", ".", "?", ";"])


def paragraph_text(rng: random.Random, words_lo=60, words_hi=160) -> str:
    target = rng.randint(words_lo, words_hi)
    out, count = [], 0
    while count < target:
        s = sentence(rng)
        out.append(s)
        count += len(s.split())
    return " ".join(out)


def zip_write(path: Path, parts: dict) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for name, data in parts.items():
            if isinstance(data, str):
                data = data.encode("utf-8")
            # Media is stored like Word does (already compressed formats).
            if name.endswith((".png", ".jpeg", ".jpg")):
                z.writestr(
                    zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)),
                    data,
                    compress_type=zipfile.ZIP_STORED,
                )
            else:
                z.writestr(
                    zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)),
                    data,
                    compress_type=zipfile.ZIP_DEFLATED,
                )
    print(f"{path.name}: {path.stat().st_size} bytes")


# ---------------------------------------------------------------- DOCX parts
W_NS = (
    'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" '
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
    'xmlns:o="urn:schemas-microsoft-com:office:office" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" '
    'xmlns:v="urn:schemas-microsoft-com:vml" '
    'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:w10="urn:schemas-microsoft-com:office:word" '
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
    'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" '
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
    'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
    'mc:Ignorable="w14 wp14"'
)

LATENT_BASE = (
    ["Normal"]
    + [f"heading {i}" for i in range(1, 10)]
    + [f"index {i}" for i in range(1, 10)]
    + [f"toc {i}" for i in range(1, 10)]
    + [
        "Normal Indent",
        "footnote text",
        "annotation text",
        "header",
        "footer",
        "index heading",
        "caption",
        "table of figures",
        "envelope address",
        "envelope return",
        "footnote reference",
        "annotation reference",
        "line number",
        "page number",
        "endnote reference",
        "endnote text",
        "table of authorities",
        "macro",
        "toa heading",
        "List",
        "List Bullet",
        "List Number",
        "List 2",
        "List 3",
        "List 4",
        "List 5",
        "List Bullet 2",
        "List Bullet 3",
        "List Bullet 4",
        "List Bullet 5",
        "List Number 2",
        "List Number 3",
        "List Number 4",
        "List Number 5",
        "Title",
        "Closing",
        "Signature",
        "Default Paragraph Font",
        "Body Text",
        "Body Text Indent",
        "List Continue",
        "List Continue 2",
        "List Continue 3",
        "List Continue 4",
        "List Continue 5",
        "Message Header",
        "Subtitle",
        "Salutation",
        "Date",
        "Body Text First Indent",
        "Body Text First Indent 2",
        "Note Heading",
        "Body Text 2",
        "Body Text 3",
        "Body Text Indent 2",
        "Body Text Indent 3",
        "Block Text",
        "Hyperlink",
        "FollowedHyperlink",
        "Strong",
        "Emphasis",
        "Document Map",
        "Plain Text",
        "E-mail Signature",
        "HTML Top of Form",
        "HTML Bottom of Form",
        "Normal (Web)",
        "HTML Acronym",
        "HTML Address",
        "HTML Cite",
        "HTML Code",
        "HTML Definition",
        "HTML Keyboard",
        "HTML Preformatted",
        "HTML Sample",
        "HTML Typewriter",
        "HTML Variable",
        "Normal Table",
        "annotation subject",
        "No List",
        "Outline List 1",
        "Outline List 2",
        "Outline List 3",
        "Table Simple 1",
        "Table Simple 2",
        "Table Simple 3",
        "Table Classic 1",
        "Table Classic 2",
        "Table Classic 3",
        "Table Classic 4",
        "Table Colorful 1",
        "Table Colorful 2",
        "Table Colorful 3",
        "Table Columns 1",
        "Table Columns 2",
        "Table Columns 3",
        "Table Columns 4",
        "Table Columns 5",
        "Table Grid 1",
        "Table Grid 2",
        "Table Grid 3",
        "Table Grid 4",
        "Table Grid 5",
        "Table Grid 6",
        "Table Grid 7",
        "Table Grid 8",
        "Table List 1",
        "Table List 2",
        "Table List 3",
        "Table List 4",
        "Table List 5",
        "Table List 6",
        "Table List 7",
        "Table List 8",
        "Table 3D effects 1",
        "Table 3D effects 2",
        "Table 3D effects 3",
        "Table Contemporary",
        "Table Elegant",
        "Table Professional",
        "Table Subtle 1",
        "Table Subtle 2",
        "Table Web 1",
        "Table Web 2",
        "Table Web 3",
        "Balloon Text",
        "Table Grid",
        "Table Theme",
        "Placeholder Text",
        "No Spacing",
        "Revision",
        "List Paragraph",
        "Quote",
        "Intense Quote",
        "Subtle Emphasis",
        "Intense Emphasis",
        "Subtle Reference",
        "Intense Reference",
        "Book Title",
        "Bibliography",
        "TOC Heading",
        "Plain Table 1",
        "Plain Table 2",
        "Plain Table 3",
        "Plain Table 4",
        "Plain Table 5",
        "Grid Table Light",
        "Mention",
        "Smart Hyperlink",
        "Hashtag",
        "Unresolved Mention",
        "Smart Link",
    ]
)
ACCENTS = [""] + [f" Accent {i}" for i in range(1, 7)]
LATENT = (
    LATENT_BASE
    + [
        f"{k}{a}"
        for k in [
            "Light Shading",
            "Light List",
            "Light Grid",
            "Medium Shading 1",
            "Medium Shading 2",
            "Medium List 1",
            "Medium List 2",
            "Medium Grid 1",
            "Medium Grid 2",
            "Medium Grid 3",
            "Dark List",
            "Colorful Shading",
            "Colorful List",
            "Colorful Grid",
        ]
        for a in ACCENTS
    ]
    + [
        f"{k}{a}"
        for k in [
            "Grid Table 1 Light",
            "Grid Table 2",
            "Grid Table 3",
            "Grid Table 4",
            "Grid Table 5 Dark",
            "Grid Table 6 Colorful",
            "Grid Table 7 Colorful",
            "List Table 1 Light",
            "List Table 2",
            "List Table 3",
            "List Table 4",
            "List Table 5 Dark",
            "List Table 6 Colorful",
            "List Table 7 Colorful",
        ]
        for a in ACCENTS
    ]
)


def docx_styles() -> str:
    latent = "".join(
        f'<w:lsdException w:name="{n}" w:semiHidden="1" w:uiPriority="{i % 99 + 1}" w:unhideWhenUsed="1"/>'
        for i, n in enumerate(LATENT)
    )
    heading = lambda i, sz, color: (
        f'<w:style w:type="paragraph" w:styleId="Heading{i}"><w:name w:val="heading {i}"/><w:basedOn w:val="Normal"/>'
        f'<w:next w:val="Normal"/><w:link w:val="Heading{i}Char"/><w:uiPriority w:val="9"/><w:qFormat/>'
        f'<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="{360 - i * 80}" w:after="80"/><w:outlineLvl w:val="{i - 1}"/></w:pPr>'
        f'<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/>'
        f'<w:color w:val="{color}" w:themeColor="accent1" w:themeShade="BF"/><w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/></w:rPr></w:style>'
        f'<w:style w:type="character" w:customStyle="1" w:styleId="Heading{i}Char"><w:name w:val="Heading {i} Char"/>'
        f'<w:basedOn w:val="DefaultParagraphFont"/><w:link w:val="Heading{i}"/><w:uiPriority w:val="9"/>'
        f'<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/>'
        f'<w:color w:val="{color}" w:themeColor="accent1" w:themeShade="BF"/><w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/></w:rPr></w:style>'
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f"<w:styles {W_NS}>"
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" '
        'w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:kern w:val="2"/><w:sz w:val="22"/><w:szCs w:val="22"/>'
        '<w:lang w:val="en-US" w:eastAsia="ja-JP" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>'
        '<w:spacing w:after="160" w:line="278" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
        f'<w:latentStyles w:defLockedState="0" w:defUIPriority="99" w:defSemiHidden="0" w:defUnhideWhenUsed="0" '
        f'w:defQFormat="0" w:count="{len(LATENT)}">{latent}</w:latentStyles>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
        + heading(1, 40, "0F4761")
        + heading(2, 32, "0F4761")
        + heading(3, 28, "0F4761")
        + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/>'
        '<w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
        '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/>'
        '<w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/>'
        '<w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
        '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
        '<w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr>'
        '<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/>'
        '<w:spacing w:val="-10"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>'
        '<w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
        '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
        '<w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:spacing w:before="160"/><w:jc w:val="center"/></w:pPr>'
        '<w:rPr><w:i/><w:iCs/><w:color w:val="404040" w:themeColor="text1" w:themeTint="BF"/></w:rPr></w:style>'
        '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:basedOn w:val="DefaultParagraphFont"/>'
        '<w:uiPriority w:val="22"/><w:qFormat/><w:rPr><w:b/><w:bCs/></w:rPr></w:style>'
        "</w:styles>"
    )


DOCX_NUMBERING = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    f'<w:numbering {W_NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
    + "".join(
        f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="{"•o▪"[i % 3]}"/>'
        f'<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="{720 * (i + 1)}" w:hanging="360"/></w:pPr>'
        f'<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>'
        for i in range(9)
    )
    + '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
)

DOCX_SETTINGS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    f'<w:settings {W_NS}><w:zoom w:percent="100"/><w:proofState w:spelling="clean" w:grammar="clean"/>'
    '<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat>'
    '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>'
    '</w:compat><w:rsids><w:rsidRoot w:val="00A1B2C3"/><w:rsid w:val="00A1B2C3"/></w:rsids>'
    '<m:mathPr><m:mathFont m:val="Cambria Math"/></m:mathPr><w:themeFontLang w:val="en-US" w:eastAsia="ja-JP"/>'
    '<w:decimalSymbol w:val="."/><w:listSeparator w:val=","/></w:settings>'
)

DOCX_FONTS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + "".join(
        f'<w:font w:name="{n}"><w:panose1 w:val="020F0502020204030204"/><w:charset w:val="00"/>'
        f'<w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>'
        for n in ["Aptos", "Aptos Display", "Times New Roman", "Symbol", "Courier New"]
    )
    + "</w:fonts>"
)


def docx_package(body: str, extra_rels="", extra_types="", extra_parts=None) -> dict:
    lesson = zipfile.ZipFile(LESSON_DOCX)
    theme = lesson.read("word/theme/theme1.xml")
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f"<w:document {W_NS}><w:body>{body}"
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" '
        'w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:space="720"/>'
        '<w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>'
    )
    types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
        '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>'
        '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        f"{extra_types}</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>'
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>'
        '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
        f"{extra_rels}</Relationships>"
    )
    parts = {
        "[Content_Types].xml": types,
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>"
        ),
        "docProps/core.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Probe</dc:title><dc:creator>Capy probe</dc:creator>'
            '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>'
        ),
        "docProps/app.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
            "<Application>Microsoft Office Word</Application><AppVersion>16.0000</AppVersion></Properties>"
        ),
        "word/document.xml": document,
        "word/styles.xml": docx_styles(),
        "word/numbering.xml": DOCX_NUMBERING,
        "word/settings.xml": DOCX_SETTINGS,
        "word/fontTable.xml": DOCX_FONTS,
        "word/theme/theme1.xml": theme,
        "word/_rels/document.xml.rels": rels,
    }
    parts.update(extra_parts or {})
    return parts


class ParaIds:
    def __init__(self, rng):
        self.rng = rng
        self.seen = set()

    def next(self) -> str:
        while True:
            v = f"{self.rng.randrange(1, 0x7FFFFFFF):08X}"
            if v not in self.seen:
                self.seen.add(v)
                return v


def w_par(ids: ParaIds, runs: str, style: str | None = None, num: bool = False) -> str:
    ppr = ""
    if style or num:
        ppr = "<w:pPr>" + (f'<w:pStyle w:val="{style}"/>' if style else "")
        ppr += (
            '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' if num else ""
        )
        ppr += "</w:pPr>"
    return f'<w:p w14:paraId="{ids.next()}" w14:textId="77777777" w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3">{ppr}{runs}</w:p>'


def w_run(text: str, bold=False, italic=False) -> str:
    rpr = ""
    if bold or italic:
        rpr = (
            "<w:rPr>"
            + ("<w:b/><w:bCs/>" if bold else "")
            + ("<w:i/><w:iCs/>" if italic else "")
            + "</w:rPr>"
        )
    return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def rich_runs(rng: random.Random, text: str) -> str:
    # Mostly plain; ~30% of paragraphs carry one bold or italic phrase.
    if rng.random() < 0.3:
        words = text.split(" ")
        if len(words) > 12:
            a = rng.randrange(1, len(words) - 6)
            b = a + rng.randint(2, 5)
            return (
                w_run(" ".join(words[:a]) + " ")
                + w_run(" ".join(words[a:b]), bold=rng.random() < 0.5, italic=True)
                + w_run(" " + " ".join(words[b:]))
            )
    return w_run(text)


def book_body(rng: random.Random, pages: int) -> tuple[str, int]:
    ids = ParaIds(rng)
    out = [
        w_par(ids, w_run("A Field Guide to Everything, Volume " + str(pages)), "Title")
    ]
    words = 0
    chapter = 0
    target_words = pages * 480
    while words < target_words:
        chapter += 1
        out.append(
            w_par(
                ids,
                w_run(f"Chapter {chapter}: " + sentence(rng, 3, 7).rstrip(".?;")),
                "Heading1",
            )
        )
        for section in range(rng.randint(3, 5)):
            out.append(
                w_par(
                    ids,
                    w_run(
                        f"{chapter}.{section + 1} " + sentence(rng, 3, 8).rstrip(".?;")
                    ),
                    "Heading2",
                )
            )
            for _ in range(rng.randint(4, 8)):
                text = paragraph_text(rng)
                words += len(text.split())
                out.append(w_par(ids, rich_runs(rng, text)))
            if rng.random() < 0.25:
                for _ in range(rng.randint(3, 6)):
                    text = sentence(rng, 6, 16)
                    words += len(text.split())
                    out.append(w_par(ids, w_run(text), "ListParagraph", num=True))
    return "".join(out), words


# ---------------------------------------------------------------- images
def photo(rng: random.Random, w: int, h: int) -> Image.Image:
    base = Image.linear_gradient("L").resize((w, h)).convert("RGB")
    tint = Image.new(
        "RGB",
        (w, h),
        (rng.randrange(80, 200), rng.randrange(80, 200), rng.randrange(80, 200)),
    )
    img = Image.blend(base, tint, 0.5)
    draw = ImageDraw.Draw(img)
    for _ in range(60):
        x, y = rng.randrange(w), rng.randrange(h)
        r = rng.randrange(20, 200)
        draw.ellipse(
            (x - r, y - r, x + r, y + r),
            fill=(rng.randrange(256), rng.randrange(256), rng.randrange(256)),
        )
    noise = Image.effect_noise((w, h), 28).convert("RGB")
    return Image.blend(img, noise, 0.22)


def diagram(
    rng: random.Random, w: int, h: int, noise_level: float = 0.008
) -> Image.Image:
    # Screenshot-like PNG: flat shapes plus a little sensor noise.
    img = Image.new("RGB", (w, h), (250, 250, 247))
    draw = ImageDraw.Draw(img)
    for _ in range(40):
        x0, y0 = rng.randrange(w - 100), rng.randrange(h - 60)
        draw.rectangle(
            (x0, y0, x0 + rng.randrange(60, 300), y0 + rng.randrange(30, 160)),
            outline=(20, 40, 90),
            width=3,
            fill=(rng.randrange(150, 255), rng.randrange(150, 255), 230),
        )
        draw.line(
            (x0, y0, rng.randrange(w), rng.randrange(h)), fill=(90, 20, 20), width=2
        )
        draw.text((x0 + 6, y0 + 6), sentence(rng, 2, 4), fill=(0, 0, 0))
    noise = Image.effect_noise((w, h), 12).convert("RGB")
    return Image.blend(img, noise, noise_level)


def inline_image(rel_id: str, doc_pr: int, cx: int, cy: int, name: str) -> str:
    return (
        '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" '
        f'wp14:anchorId="{doc_pr:08X}" wp14:editId="{doc_pr * 7:08X}"><wp:extent cx="{cx}" cy="{cy}"/>'
        f'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{doc_pr}" name="Picture {doc_pr}" descr="{name}"/>'
        '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        f'<pic:nvPicPr><pic:cNvPr id="{doc_pr}" name="{name}"/><pic:cNvPicPr/></pic:nvPicPr>'
        f'<pic:blipFill><a:blip r:embed="{rel_id}"><a:extLst><a:ext uri="{{28A0092B-C50C-407E-A947-70E740481C1C}}">'
        '<a14:useLocalDpi xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" val="0"/></a:ext></a:extLst>'
        '</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/>'
        f'<a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
    )


def images_docx(rng: random.Random) -> None:
    ids = ParaIds(rng)
    body, rels, media = [w_par(ids, w_run("Illustrated field notes"), "Title")], [], {}
    total = 0
    for i in range(10):
        body.append(
            w_par(ids, w_run(f"Figure {i + 1}: " + sentence(rng, 4, 8)), "Heading2")
        )
        for _ in range(3):
            body.append(w_par(ids, rich_runs(rng, paragraph_text(rng))))
        buf = io.BytesIO()
        if i % 5 < 3:
            photo(rng, 1600, 1067).save(buf, "JPEG", quality=85)
            name = f"image{i + 1}.jpeg"
        else:
            diagram(rng, 1400, 900).save(buf, "PNG", optimize=True)
            name = f"image{i + 1}.png"
        data = buf.getvalue()
        total += len(data)
        media[f"word/media/{name}"] = data
        rid = f"rId{100 + i}"
        rels.append(
            f'<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{name}"/>'
        )
        body.append(w_par(ids, inline_image(rid, i + 1, 5486400, 3657600, name)))
    print(f"images-10: {total} image bytes")
    zip_write(
        OUT / "images-10.docx",
        docx_package("".join(body), "".join(rels), extra_parts=media),
    )


# ---------------------------------------------------------------- charts and opaque drawings
def chart_xml(rng: random.Random, title: str, ext_rel: str) -> str:
    cats = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]
    series = []
    for s in range(3):
        col = "BCD"[s]
        vals = [round(rng.uniform(10, 90), 1) for _ in cats]
        series.append(
            f'<c:ser><c:idx val="{s}"/><c:order val="{s}"/><c:tx><c:strRef><c:f>Sheet1!${col}$1</c:f><c:strCache>'
            f'<c:ptCount val="1"/><c:pt idx="0"><c:v>Series {s + 1}</c:v></c:pt></c:strCache></c:strRef></c:tx>'
            f'<c:spPr><a:solidFill><a:schemeClr val="accent{s + 1}"/></a:solidFill><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>'
            '<c:invertIfNegative val="0"/>'
            f'<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$7</c:f><c:strCache><c:ptCount val="6"/>'
            + "".join(
                f'<c:pt idx="{i}"><c:v>{c}</c:v></c:pt>' for i, c in enumerate(cats)
            )
            + f"</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!${col}$2:${col}$7</c:f><c:numCache>"
            '<c:formatCode>General</c:formatCode><c:ptCount val="6"/>'
            + "".join(
                f'<c:pt idx="{i}"><c:v>{v}</c:v></c:pt>' for i, v in enumerate(vals)
            )
            + '</c:numCache></c:numRef></c:val><c:extLst><c:ext uri="{C3380CC4-5D6E-409C-BE32-E72D297353CC}" '
            f'xmlns:c16="http://schemas.microsoft.com/office/drawing/2014/chart"><c16:uniqueId val="{{0000000{s}-2C3D-4E5F-8A9B-0C1D2E3F4A5B}}"/>'
            "</c:ext></c:extLst></c:ser>"
        )
    txpr = (
        '<c:txPr><a:bodyPr rot="-60000000" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="square" '
        'anchor="ctr" anchorCtr="1"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900" b="0" i="0" u="none" strike="noStrike" '
        'kern="1200" baseline="0"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/>'
        '</a:schemeClr></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>'
        '</a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>'
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich>'
        f'<a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>{escape(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>'
        '<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>'
        '<c:varyColors val="0"/>'
        + "".join(series)
        + '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/>'
        '<c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls><c:gapWidth val="219"/><c:overlap val="-27"/>'
        '<c:axId val="111111111"/><c:axId val="222222222"/></c:barChart>'
        '<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>'
        '<c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/>'
        '<c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>'
        + txpr
        + '<c:crossAx val="222222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/>'
        '<c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="222222222"/><c:scaling>'
        '<c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr>'
        '<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/>'
        '<a:lumOff val="85000"/></a:schemeClr></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr></c:majorGridlines>'
        '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>'
        '<c:tickLblPos val="nextTo"/>'
        + txpr
        + '<c:crossAx val="111111111"/><c:crosses val="autoZero"/>'
        '<c:crossBetween val="between"/></c:valAx><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>'
        '</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/>'
        + txpr
        + "</c:legend>"
        '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:schemeClr val="bg1"/>'
        '</a:solidFill><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1">'
        '<a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill><a:round/></a:ln><a:effectLst/>'
        f'</c:spPr><c:externalData r:id="{ext_rel}"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>'
    )


def chart_run(rel_id: str, doc_pr: int) -> str:
    return (
        '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" '
        f'wp14:anchorId="{0x1000 + doc_pr:08X}" wp14:editId="{0x2000 + doc_pr:08X}"><wp:extent cx="5486400" cy="3200400"/>'
        f'<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{doc_pr}" name="Chart {doc_pr}"/>'
        '<wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
        f'<c:chart r:id="{rel_id}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    )


def textbox_alternate(rng: random.Random, ids: ParaIds, doc_pr: int) -> str:
    paras = "".join(w_par(ids, w_run(sentence(rng, 8, 16))) for _ in range(3))
    return (
        '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="45720" distB="45720" '
        'distL="114300" distR="114300" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" '
        f'layoutInCell="1" allowOverlap="1" wp14:anchorId="{0x3000 + doc_pr:08X}" wp14:editId="{0x4000 + doc_pr:08X}">'
        '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>3200400</wp:posOffset></wp:positionH>'
        '<wp:positionV relativeFrom="paragraph"><wp:posOffset>91440</wp:posOffset></wp:positionV><wp:extent cx="2360930" '
        'cy="1404620"/><wp:effectExtent l="0" t="0" r="22860" b="11430"/><wp:wrapSquare wrapText="bothSides"/>'
        f'<wp:docPr id="{doc_pr}" name="Text Box {doc_pr}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData '
        'uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1">'
        '<a:spLocks noChangeArrowheads="1"/></wps:cNvSpPr><wps:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/>'
        '<a:ext cx="2360930" cy="1404620"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill>'
        '<a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>'
        '<a:miter lim="800000"/><a:headEnd/><a:tailEnd/></a:ln></wps:spPr><wps:txbx><w:txbxContent>'
        + paras
        + '</w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" '
        'rIns="91440" bIns="45720" anchor="t" anchorCtr="0"><a:spAutoFit/></wps:bodyPr></wps:wsp></a:graphicData>'
        '</a:graphic><wp14:sizeRelH relativeFrom="margin"><wp14:pctWidth>40000</wp14:pctWidth></wp14:sizeRelH>'
        '<wp14:sizeRelV relativeFrom="margin"><wp14:pctHeight>20000</wp14:pctHeight></wp14:sizeRelV></wp:anchor>'
        '</w:drawing></mc:Choice><mc:Fallback><w:pict><v:shapetype id="_x0000_t202" coordsize="21600,21600" '
        'o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" '
        f'o:connecttype="rect"/></v:shapetype><v:shape id="Text Box {doc_pr}" o:spid="_x0000_s{1025 + doc_pr}" '
        'type="#_x0000_t202" style="position:absolute;margin-left:252pt;margin-top:7.2pt;width:185.9pt;height:110.6pt;'
        "z-index:251659264;visibility:visible;mso-wrap-style:square;mso-width-percent:400;mso-height-percent:200;"
        "mso-wrap-distance-left:9pt;mso-wrap-distance-top:3.6pt;mso-wrap-distance-right:9pt;mso-wrap-distance-bottom:3.6pt;"
        "mso-position-horizontal:absolute;mso-position-horizontal-relative:text;mso-position-vertical:absolute;"
        "mso-position-vertical-relative:text;mso-width-percent:400;mso-height-percent:200;mso-width-relative:margin;"
        'mso-height-relative:margin;v-text-anchor:top"><v:textbox style="mso-fit-shape-to-text:t"><w:txbxContent>'
        + paras
        + '</w:txbxContent></v:textbox><w10:wrap type="square"/></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>'
    )


def vml_pict(rng: random.Random, ids: ParaIds) -> str:
    return (
        '<w:r><w:pict><v:rect id="_x0000_s2050" style="position:absolute;margin-left:0;margin-top:0;width:200pt;'
        'height:60pt;z-index:251660288;mso-position-horizontal:center;mso-position-horizontal-relative:margin" '
        'fillcolor="#dbe5f1" strokecolor="#4f81bd" strokeweight="1pt"><v:textbox><w:txbxContent>'
        + w_par(ids, w_run(sentence(rng, 6, 10)))
        + '</w:txbxContent></v:textbox><w10:wrap type="topAndBottom"/></v:rect></w:pict></w:r>'
    )


def ole_object(img_rel: str, ole_rel: str) -> str:
    return (
        '<w:r><w:object w:dxaOrig="7185" w:dyaOrig="2340"><v:shapetype id="_x0000_t75" coordsize="21600,21600" '
        'o:spt="75" o:preferrelative="t" path="m@4@5l@4@11@9@11@9@5xe" filled="f" stroked="f"><v:stroke joinstyle="miter"/>'
        '<v:formulas><v:f eqn="if lineDrawn pixelLineWidth 0"/><v:f eqn="sum @0 1 0"/><v:f eqn="sum 0 0 @1"/>'
        '<v:f eqn="prod @2 1 2"/><v:f eqn="prod @3 21600 pixelWidth"/><v:f eqn="prod @3 21600 pixelHeight"/>'
        '<v:f eqn="sum @0 0 1"/><v:f eqn="prod @6 1 2"/><v:f eqn="prod @7 21600 pixelWidth"/><v:f eqn="sum @8 21600 0"/>'
        '<v:f eqn="prod @7 21600 pixelHeight"/><v:f eqn="sum @10 21600 0"/></v:formulas><v:path o:extrusionok="f" '
        'gradientshapeok="t" o:connecttype="rect"/><o:lock v:ext="edit" aspectratio="t"/></v:shapetype>'
        '<v:shape id="_x0000_i1025" type="#_x0000_t75" style="width:359.25pt;height:117pt" o:ole="">'
        f'<v:imagedata r:id="{img_rel}" o:title=""/></v:shape><o:OLEObject Type="Embed" ProgID="Excel.Sheet.12" '
        f'ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1780000001" r:id="{ole_rel}"/></w:object></w:r>'
    )


def small_workbook(rng: random.Random) -> bytes:
    rows = [["", "Series 1", "Series 2", "Series 3"]] + [
        [f"Q{i}", *(round(rng.uniform(10, 90), 1) for _ in range(3))]
        for i in range(1, 7)
    ]
    buf = io.BytesIO()
    zip_bytes(buf, xlsx_parts(rows, styled=False))
    return buf.getvalue()


def zip_bytes(buf, parts):
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(
                zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)),
                data,
                compress_type=zipfile.ZIP_DEFLATED,
            )


def opaque_docx(rng: random.Random) -> None:
    ids = ParaIds(rng)
    body = [
        w_par(
            ids,
            w_run("Report with charts, text boxes and an embedded workbook"),
            "Title",
        )
    ]
    rels, types, parts = [], [], {}
    for i in range(1, 3):
        body.append(w_par(ids, w_run(f"Section {i}"), "Heading1"))
        for _ in range(3):
            body.append(w_par(ids, rich_runs(rng, paragraph_text(rng))))
        rels.append(
            f'<Relationship Id="rIdChart{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart{i}.xml"/>'
        )
        types.append(
            f'<Override PartName="/word/charts/chart{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'
        )
        parts[f"word/charts/chart{i}.xml"] = chart_xml(
            rng, f"Quarterly results {i}", "rId1"
        )
        parts[f"word/charts/_rels/chart{i}.xml.rels"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" '
            f'Target="../embeddings/Microsoft_Excel_Worksheet{i}.xlsx"/></Relationships>'
        )
        parts[f"word/embeddings/Microsoft_Excel_Worksheet{i}.xlsx"] = small_workbook(
            rng
        )
        body.append(w_par(ids, chart_run(f"rIdChart{i}", 10 + i)))
        body.append(
            w_par(ids, textbox_alternate(rng, ids, 20 + i) + w_run(sentence(rng)))
        )
    body.append(w_par(ids, w_run("Legacy callout"), "Heading1"))
    body.append(w_par(ids, vml_pict(rng, ids)))
    body.append(w_par(ids, w_run("Embedded workbook object"), "Heading1"))
    preview = io.BytesIO()
    diagram(rng, 480, 156).save(preview, "PNG", optimize=True)
    parts["word/media/image_ole1.png"] = preview.getvalue()
    parts["word/embeddings/Microsoft_Excel_Worksheet3.xlsx"] = small_workbook(rng)
    rels.append(
        '<Relationship Id="rIdOleImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image_ole1.png"/>'
    )
    rels.append(
        '<Relationship Id="rIdOle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="embeddings/Microsoft_Excel_Worksheet3.xlsx"/>'
    )
    body.append(w_par(ids, ole_object("rIdOleImg", "rIdOle")))
    for _ in range(4):
        body.append(w_par(ids, rich_runs(rng, paragraph_text(rng))))
    types.append(
        '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>'
    )
    zip_write(
        OUT / "opaque-objects.docx",
        docx_package("".join(body), "".join(rels), "".join(types), parts),
    )


# ---------------------------------------------------------------- XLSX
def col_name(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def xlsx_parts(rows, styled=True, formulas=None) -> dict:
    """rows: list of lists; str -> shared string, number -> value; formulas: {(r,c): (f, cached)}."""
    formulas = formulas or {}
    strings, index = [], {}

    def sst(s):
        if s not in index:
            index[s] = len(strings)
            strings.append(s)
        return index[s]

    sheet_rows = []
    for r, row in enumerate(rows):
        cells = []
        for c, v in enumerate(row):
            ref = f"{col_name(c)}{r + 1}"
            style = styled and (
                1 if r == 0 else {1: 2, 5: 3, 6: 3, 7: 4, 4: 5}.get(c, 0)
            )
            s_attr = f' s="{style}"' if style else ""
            if (r, c) in formulas:
                f, cached = formulas[(r, c)]
                cells.append(f'<c r="{ref}"{s_attr}><f>{f}</f><v>{cached}</v></c>')
            elif isinstance(v, str):
                if v == "":
                    continue
                cells.append(f'<c r="{ref}"{s_attr} t="s"><v>{sst(v)}</v></c>')
            else:
                cells.append(f'<c r="{ref}"{s_attr}><v>{v}</v></c>')
        sheet_rows.append(
            f'<row r="{r + 1}" spans="1:{len(row)}">{"".join(cells)}</row>'
        )
    last = f"{col_name(len(rows[0]) - 1)}{len(rows)}"
    cols = "".join(
        f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>'
        for i, w in enumerate([8, 12, 12, 22, 10, 12, 14, 10, 8, 48][: len(rows[0])])
    )
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<dimension ref="A1:{last}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        f'<sheetFormatPr defaultRowHeight="15"/><cols>{cols}</cols><sheetData>{"".join(sheet_rows)}</sheetData>'
        '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
    )
    sst_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(strings)}" uniqueCount="{len(strings)}">'
        + "".join(f"<si><t>{escape(s)}</t></si>" for s in strings)
        + "</sst>"
    )
    styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>'
        '<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></font>'
        '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos Narrow"/><family val="2"/><scheme val="minor"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>'
        '<border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    )
    theme = zipfile.ZipFile(GRADES_XLSX).read("xl/theme/theme1.xml")
    return {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
            '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>"
        ),
        "docProps/core.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Capy probe</dc:creator>'
            '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>'
        ),
        "docProps/app.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
            "<Application>Microsoft Excel</Application><AppVersion>16.0300</AppVersion></Properties>"
        ),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300"/></bookViews>'
            '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>'
        ),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
            "</Relationships>"
        ),
        "xl/worksheets/sheet1.xml": sheet,
        "xl/sharedStrings.xml": sst_xml,
        "xl/styles.xml": styles,
        "xl/theme/theme1.xml": theme,
    }


REGIONS = ["North", "South", "East", "West", "Central", "Kanto", "Kansai", "Overseas"]
PRODUCTS = [
    f"{a} {b}"
    for a in ["Basic", "Pro", "Lab", "Field", "Studio"]
    for b in [
        "Notebook",
        "Pen",
        "Kit",
        "Sensor",
        "Scope",
        "Atlas",
        "Guide",
        "Case",
        "Board",
        "Lamp",
    ]
]


def cells_xlsx(rng: random.Random, cells: int) -> None:
    ncols = 10
    nrows = cells // ncols  # header row included
    rows = [
        [
            "ID",
            "Date",
            "Region",
            "Product",
            "Quantity",
            "Unit price",
            "Total",
            "Discount",
            "Rating",
            "Notes",
        ]
    ]
    formulas = {}
    for r in range(1, nrows):
        qty = rng.randint(1, 400)
        price = round(rng.uniform(0.5, 250), 2)
        rows.append(
            [
                1000 + r,
                45658 + rng.randint(0, 700),
                rng.choice(REGIONS),
                rng.choice(PRODUCTS),
                qty,
                price,
                0,
                round(rng.uniform(0, 0.3), 4),
                rng.randint(1, 5),
                sentence(rng, 3, 9),
            ]
        )
        formulas[(r, 6)] = (f"E{r + 1}*F{r + 1}", round(qty * price, 2))
    name = f"cells-{cells // 1000}k.xlsx"
    zip_write(OUT / name, xlsx_parts(rows, formulas=formulas))


# ---------------------------------------------------------------- PPTX
def deck_pptx(rng: random.Random, slides: int) -> None:
    lesson = zipfile.ZipFile(LESSON_PPTX)
    parts = {
        n: lesson.read(n) for n in lesson.namelist() if not n.startswith("ppt/slides/")
    }
    rels = [
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>',
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="printerSettings/printerSettings1.bin"/>',
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>',
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>',
        '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>',
        '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>',
    ]
    sld_ids, overrides = [], []
    for i in range(1, slides + 1):
        bullets = "".join(
            f'<a:p><a:pPr lvl="{1 if rng.random() < 0.25 else 0}"/><a:r><a:rPr lang="en-US" dirty="0"/>'
            f"<a:t>{escape(sentence(rng, 8, 18))}</a:t></a:r></a:p>"
            for _ in range(rng.randint(6, 8))
        )
        parts[f"ppt/slides/slide{i}.xml"] = (
            "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
            '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
            'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree>'
            '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
            '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
            '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>'
            f'<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>{i}. {escape(sentence(rng, 3, 7).rstrip(".?;"))}</a:t></a:r></a:p>'
            '</p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr>'
            '<a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody>'
            f'<a:bodyPr><a:normAutofit fontScale="70000" lnSpcReduction="20000"/></a:bodyPr><a:lstStyle/>{bullets}</p:txBody></p:sp>'
            "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
        )
        parts[f"ppt/slides/_rels/slide{i}.xml.rels"] = (
            "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" '
            'Target="../slideLayouts/slideLayout2.xml"/></Relationships>'
        )
        rels.append(
            f'<Relationship Id="rId{100 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i}.xml"/>'
        )
        sld_ids.append(f'<p:sldId id="{255 + i}" r:id="rId{100 + i}"/>')
        overrides.append(
            f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        )
    pres = lesson.read("ppt/presentation.xml").decode()
    start, end = (
        pres.index("<p:sldIdLst>"),
        pres.index("</p:sldIdLst>") + len("</p:sldIdLst>"),
    )
    parts["ppt/presentation.xml"] = (
        pres[:start] + "<p:sldIdLst>" + "".join(sld_ids) + "</p:sldIdLst>" + pres[end:]
    )
    parts["ppt/_rels/presentation.xml.rels"] = (
        "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(rels)
        + "</Relationships>"
    )
    types = lesson.read("[Content_Types].xml").decode()
    types = types.replace(
        '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
        "".join(overrides),
    )
    assert "/ppt/slides/slide50.xml" in types or slides < 50
    parts["[Content_Types].xml"] = types
    zip_write(OUT / f"deck-{slides}.pptx", parts)


if __name__ == "__main__":
    rng = random.Random(20260925)
    for pages in (30, 300):
        body, words = book_body(rng, pages)
        print(f"book-{pages}p: {words} words, {body.count('<w:p ')} paragraphs")
        zip_write(OUT / f"book-{pages}p.docx", docx_package(body))
    images_docx(rng)
    opaque_docx(rng)
    for cells in (1000, 10000, 50000, 100000):
        cells_xlsx(rng, cells)
    deck_pptx(rng, 50)
