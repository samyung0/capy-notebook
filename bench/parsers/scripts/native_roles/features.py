"""Per-line features from native PDF primitives (no pixels).

`extract_page` reads one page once (text lines, drawings, images). `book_stats`
summarises a whole book (font-size and style shares, band repetition) from the
extracted pages. `featurize` turns one page into an (n_lines, n_features)
matrix; the geometry and neighbour parts are numpy, the text parts a short
Python loop.
"""

import re
from collections import Counter

import numpy as np
import pymupdf
from scipy import ndimage

FLAGS = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
BAND = 0.15  # top/bottom fraction of the page where running furniture lives (LaTeX heads sit near 0.13)

MATHFONT = re.compile(r"CMMI|CMSY|CMEX|CMR\d|Math|Symbol|STIX|MTExtra|MT Extra|Euclid|MSBM|MSAM|rsfs|Cambria|LMRoman.*Math|txsy|txmi|esint", re.I)
MONO = re.compile(r"Mono|Courier|Consol|CMTT|Menlo|Code|Inconsolata|Typewriter|SFTT|LMTypewriter|Lucida Console", re.I)
OPS = set("=+−×÷<>±≤≥∑∫√∞≈≠^*·∂∆∇∈∉⊂⊆∪∩∀∃→←↔⇒⇔¬∧∨")
NUMBERING = re.compile(r"^\s*((\d+(\.\d+)*\.?)|([A-Z](\.\d+)*\.)|([IVX]+\.)|Chapter|CHAPTER|Section|SECTION|§|Part|PART|Unit|UNIT|Appendix|APPENDIX|Lesson|Module)\s")
BULLET = re.compile(r"^\s*([•◦▪▫‣⁃●○■□–\-\*·➢➤✓✔]|\(?\d{1,2}\)|\(?[a-z]\)|\(?[ivx]{1,4}\))\s")
CAPTION = re.compile(r"^\s*(Figure|Fig\.|FIGURE|Table|TABLE|Exhibit|Chart|Image|Photo|Plate|Listing|Diagram|Map|Source:|Note:)\s*[\dA-Z.:]?", re.I)
CODEISH = re.compile(r"[;{}]\s*$|^\s*(def |class |return\b|import |from \S+ import|#include|for \(|if \(|while \(|public |private |>>|\$ |//|%|print\()")
FOLIO = re.compile(r"^(page\s+)?([1-9]\d{0,3}|[ivxlc]{1,7})(\s+of\s+\d+)?$", re.I)


def extract_page(page: pymupdf.Page) -> dict:
    """Text lines with span facts, drawing rects (with fill flag) and image rects."""
    lines = []
    for bi, blk in enumerate(page.get_text("dict", flags=FLAGS)["blocks"]):
        if blk.get("type") != 0:
            continue
        nl = len(blk["lines"])
        for li, ln in enumerate(blk["lines"]):
            spans = [(s["size"], s["flags"], s["font"], len(s["text"].strip()), s["text"]) for s in ln["spans"] if s["text"].strip()]
            if not spans:
                continue
            raw = "".join(s["text"] for s in ln["spans"])
            lines.append(dict(bbox=tuple(ln["bbox"]), text=raw.strip(), lead=len(raw) - len(raw.lstrip()),
                              spans=spans, block=bi, line_in_block=li, block_lines=nl))
    draws = [(*d["rect"], d.get("fill") is not None) for d in page.get_cdrawings()]
    imgs = [tuple(i["bbox"]) for i in page.get_image_info()]
    return dict(lines=lines, draws=draws, imgs=imgs, w=page.rect.width, h=page.rect.height, n=page.number)


def rep_key(text: str) -> str:
    t = text.strip().lower()
    if FOLIO.match(t):
        return "#folio"
    return re.sub(r"\d+", "#", re.sub(r"\s+", " ", t))[:60]


def rep_id(ln: dict, h: float):
    """Repetition key of a band line: text with digits folded, band and font size."""
    b = band_of(ln["bbox"], h)
    if "....." in ln["text"]:  # contents lines share a folded key across pages
        return None
    return (rep_key(ln["text"]), b, round(max(s[0] for s in ln["spans"]))) if b else None


def repeat_min(pages: int) -> int:
    """Pages a band key must recur on to count as running furniture."""
    return 3


def _number(text: str):
    m = re.search(r"\d+", text)
    return int(m.group()) if m else None


def repetition(bs: dict, ln: dict, h: float, page_no: int) -> tuple[int, int, bool]:
    """(pages with the folded key, pages with the exact text, whether the line's number
    tracks the page number like a folio)."""
    k = rep_id(ln, h)
    if not k:
        return 0, 0, False
    n = _number(ln["text"])
    track = k in bs["tracks"] and n is not None and n - page_no == bs["tracks"][k]
    return bs["bands"].get(k, 0), bs["exact"].get((ln["text"].strip().lower(), k[1], k[2]), 0), track


def is_running(bs: dict, ln: dict, h: float, page_no: int, pages: int) -> bool:
    """Running furniture: the folded key recurs, and the exact text recurs on 3 pages or
    its number follows the page number. Short fragments ("=", "2") must track the page.
    A numbered heading ("Practice Problems 2.2")
    near the page top folds to a recurring key but fails both."""
    folded, exact, track = repetition(bs, ln, h, page_no)
    wordy = sum(c.isalnum() for c in ln["text"]) >= 4  # not a lone "=" or "2" of a formula
    return folded >= repeat_min(pages) and ((exact >= 3 and wordy) or track)


def band_of(bbox, h) -> int:
    """1 for the top band, 2 for the bottom band, 0 for the body."""
    if bbox[3] <= BAND * h:
        return 1
    if bbox[1] >= (1 - BAND) * h:
        return 2
    return 0


def family(font: str) -> str:
    return re.sub(r"[-,+].*$", "", font.split("+")[-1])[:20]


def dominant_style(spans):
    best = max(spans, key=lambda s: s[3])
    return (round(best[0] * 2) / 2, bool(best[1] & 16), family(best[2]))


def book_stats(pages: list[dict]) -> dict:
    sizes, styles, bands, exact = Counter(), Counter(), Counter(), Counter()
    offsets = {}
    for pg in pages:
        seen = set()
        for ln in pg["lines"]:
            for s in ln["spans"]:
                sizes[round(s[0] * 2) / 2] += s[3]
            styles[dominant_style(ln["spans"])] += sum(s[3] for s in ln["spans"])
            k = rep_id(ln, pg["h"])
            if k:
                seen.add(k)
                exact[(ln["text"].strip().lower(), k[1], k[2])] += 1
                n = _number(ln["text"])
                if n is not None:
                    offsets.setdefault(k, Counter())[n - pg["n"]] += 1
        bands.update(seen)
    total = sum(sizes.values()) or 1
    body = sizes.most_common(1)[0][0] if sizes else 10.0
    # share of book characters set larger than each size: small for heading sizes
    order = sorted(sizes)
    larger, acc = {}, 0
    for s in reversed(order):
        larger[s] = acc / total
        acc += sizes[s]
    return dict(body=body, larger=larger, styles={k: v / total for k, v in styles.items()},
                bands=dict(bands), pages=len(pages), exact=dict(exact),
                # folded keys whose number follows the page number on most of their pages
                tracks={k: c.most_common(1)[0][0] for k, c in offsets.items() if c.most_common(1)[0][1] >= max(3, 0.5 * bands[k])})


def figure_regions(draws, W, H, cell=4.0):
    """Drawing clusters as in the parser's vector-figure gate (pictures._figure_clusters),
    approximated on a 4 pt grid dilated by 8 pt: regions with >= 12 paths and >= 3% of the page."""
    keep = [d for d in draws if not ((d[2] - d[0] < 0.5 and d[3] - d[1] < 0.5) or
                                     (d[2] - d[0] >= 0.9 * W and d[3] - d[1] >= 0.9 * H) or
                                     (d[3] - d[1] <= 1.5 and d[2] - d[0] >= 0.3 * W) or
                                     (d[2] - d[0] <= 1.5 and d[3] - d[1] >= 0.3 * H))]
    if len(keep) < 12:
        return np.zeros((0, 4))
    gw, gh = int(W / cell) + 2, int(H / cell) + 2
    grid = np.zeros((gh, gw), bool)
    ix = np.clip((np.array([d[:4] for d in keep]) / cell).astype(int), 0, [gw - 1, gh - 1, gw - 1, gh - 1])
    for x0, y0, x1, y1 in ix:
        grid[y0:y1 + 1, x0:x1 + 1] = True
    lab, n = ndimage.label(ndimage.binary_dilation(grid, iterations=2))
    counts = np.bincount(lab[(ix[:, 1] + ix[:, 3]) // 2, (ix[:, 0] + ix[:, 2]) // 2], minlength=n + 1)
    out = []
    for k, sl in enumerate(ndimage.find_objects(lab), 1):
        r = (sl[1].start * cell, sl[0].start * cell, sl[1].stop * cell, sl[0].stop * cell)
        if counts[k] >= 12 and (r[2] - r[0]) * (r[3] - r[1]) >= 0.03 * W * H:
            out.append(r)
    return np.array(out).reshape(-1, 4)


def _overlap(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Pairwise intersection areas of boxes a (n,4) and b (m,4)."""
    w = np.clip(np.minimum(a[:, None, 2], b[None, :, 2]) - np.maximum(a[:, None, 0], b[None, :, 0]), 0, None)
    h = np.clip(np.minimum(a[:, None, 3], b[None, :, 3]) - np.maximum(a[:, None, 1], b[None, :, 1]), 0, None)
    return w * h


NAMES = [
    "x0", "y0", "x1", "y1", "width", "height_rel", "center_off", "indent", "right_gap", "band", "page_frac",
    "size_rel", "size_max_rel", "size_min_rel", "size_larger_share", "style_share", "bold", "italic", "mono", "math",
    "superscript", "n_spans", "n_fonts", "chars", "words", "digit", "alpha", "upper", "ops", "pua", "greek", "punct",
    "title_case", "numbering", "bullet", "caption_cue", "code_cue", "folio", "ends_period", "ends_colon", "has_eq",
    "lead_spaces", "rep_pages", "rep_share", "rep_exact", "rep_track", "gap_above", "gap_below", "above_size", "below_size", "above_bold",
    "below_bold", "above_x0", "below_x0", "same_row", "prev_size", "next_size", "prev_style_same", "next_style_same",
    "block_lines", "line_in_block", "block_last", "draw_near", "draw_cover", "fill_cover", "draw_wide", "page_draws",
    "in_image", "page_images", "page_lines", "page_math", "page_mono", "page_size_max",
    "in_figure", "page_figures", "dup_text",
]


def featurize(pg: dict, bs: dict, page_count: int) -> np.ndarray:
    ls = pg["lines"]
    n = len(ls)
    if not n:
        return np.zeros((0, len(NAMES)), np.float32)
    W, H, body = pg["w"], pg["h"], bs["body"]
    bb = np.array([ln["bbox"] for ln in ls], np.float64)
    x0, y0, x1, y1 = bb.T
    lh = np.maximum(y1 - y0, 0.5)
    left, right = np.percentile(x0, 10), np.percentile(x1, 90)

    rows = []
    for ln in ls:
        sp = ln["spans"]
        sz = np.array([s[0] for s in sp])
        wt = np.array([s[3] for s in sp], np.float64)
        tot = wt.sum() or 1.0
        frac = lambda m: float((wt * m).sum() / tot)
        fl = np.array([s[1] for s in sp])
        fonts = [s[2] for s in sp]
        text = ln["text"]
        chars = [c for c in text if not c.isspace()]
        nc = max(1, len(chars))
        words = text.split()
        smax = round(sz.max() * 2) / 2
        rows.append([
            float((sz * wt).sum() / tot) / body, sz.max() / body, sz.min() / body,
            bs["larger"].get(smax, 0.0), bs["styles"].get(dominant_style(sp), 0.0),
            frac((fl & 16) > 0), frac((fl & 2) > 0),
            frac(np.array([bool(MONO.search(f)) or bool(x & 8) for f, x in zip(fonts, fl)])),
            frac(np.array([bool(MATHFONT.search(f)) for f in fonts])), frac((fl & 1) > 0),
            len(sp), len(set(fonts)), len(text), len(words),
            sum(c.isdigit() for c in chars) / nc, sum(c.isalpha() for c in chars) / nc,
            sum(c.isupper() for c in chars) / nc, sum(c in OPS for c in chars) / nc,
            sum(0xE000 <= ord(c) <= 0xF8FF for c in chars) / nc, sum(0x370 <= ord(c) <= 0x3FF for c in chars) / nc,
            sum(not c.isalnum() for c in chars) / nc,
            sum(w[:1].isupper() for w in words) / max(1, len(words)),
            bool(NUMBERING.match(text)), bool(BULLET.match(text)), bool(CAPTION.match(text)),
            bool(CODEISH.search(text)), bool(FOLIO.match(text)), text.endswith("."), text.endswith(":"),
            "=" in text, ln["lead"],
        ])
    T = np.array(rows, np.float64)
    size_rel = T[:, 0]

    band = np.array([band_of(ln["bbox"], H) for ln in ls])
    reps = [repetition(bs, ln, H, pg["n"]) for ln in ls]
    rep = np.array([r[0] for r in reps], np.float64)
    rep_exact = np.array([r[1] for r in reps], np.float64)
    rep_track = np.array([r[2] for r in reps], np.float64)

    # vertical neighbours that share some horizontal extent
    xo = (np.minimum(x1[:, None], x1[None, :]) - np.maximum(x0[:, None], x0[None, :])) > 0
    dy_above = y0[:, None] - y1[None, :]  # [i, j]: gap from j's bottom to i's top
    above = xo & (dy_above >= -1) & ~np.eye(n, dtype=bool)
    below = xo & (dy_above.T >= -1) & ~np.eye(n, dtype=bool)
    ga = np.where(above, dy_above, np.inf)
    gb = np.where(below, dy_above.T, np.inf)
    ia, ib = ga.argmin(1), gb.argmin(1)
    has_a, has_b = np.isfinite(ga.min(1)), np.isfinite(gb.min(1))
    gap_a = np.where(has_a, ga.min(1), H) / body
    gap_b = np.where(has_b, gb.min(1), H) / body
    yo = np.minimum(y1[:, None], y1[None, :]) - np.maximum(y0[:, None], y0[None, :])
    same_row = (yo > 0.5 * lh[:, None]).sum(1) - 1
    bold = T[:, 5]
    styles = [dominant_style(ln["spans"]) for ln in ls]
    prev_same = np.array([0.0] + [float(styles[i] == styles[i - 1]) for i in range(1, n)])
    next_same = np.array([float(styles[i] == styles[i + 1]) for i in range(n - 1)] + [0.0])

    # drawings and images
    d = np.array([r[:4] for r in pg["draws"]], np.float64).reshape(-1, 4)
    fill = np.array([r[4] for r in pg["draws"]], bool)
    area = (x1 - x0) * lh
    if len(d):
        d[:, 2] = np.maximum(d[:, 2], d[:, 0] + 0.5)
        d[:, 3] = np.maximum(d[:, 3], d[:, 1] + 0.5)
        infl = np.stack([x0 - lh, y0 - lh, x1 + lh, y1 + lh], 1)
        near = (_overlap(infl, d) > 0).sum(1)
        ov = _overlap(np.stack([x0, y0, x1, y1], 1), d)
        cover = np.minimum(1, ov.sum(1) / area)
        fcover = np.minimum(1, ov[:, fill].sum(1) / area) if fill.any() else np.zeros(n)
        wide = np.stack([x0 - 4 * lh, y0 - 4 * lh, x1 + 4 * lh, y1 + 4 * lh], 1)
        dwide = (_overlap(wide, d) > 0).sum(1)
    else:
        near = cover = fcover = dwide = np.zeros(n)
    im = np.array(pg["imgs"], np.float64).reshape(-1, 4)
    in_img = (_overlap(np.stack([x0, y0, x1, y1], 1), im).max(1) / area) if len(im) else np.zeros(n)

    figs = figure_regions(pg["draws"], W, H)
    in_fig = (_overlap(np.stack([x0, y0, x1, y1], 1), figs).max(1) / area) if len(figs) else np.zeros(n)
    texts = Counter(ln["text"] for ln in ls)
    dup = np.array([texts[ln["text"]] - 1 for ln in ls], np.float64)

    blk_lines = np.array([ln["block_lines"] for ln in ls], np.float64)
    lib = np.array([ln["line_in_block"] for ln in ls], np.float64)
    G = np.column_stack([
        x0 / W, y0 / H, x1 / W, y1 / H, (x1 - x0) / W, lh / body, ((x0 + x1) / 2 - (left + right) / 2) / W,
        (x0 - left) / W, (right - x1) / W, band, np.full(n, pg["n"] / max(1, page_count)),
    ])
    N = np.column_stack([
        np.log1p(rep), rep / max(1, bs["pages"]), np.log1p(rep_exact), rep_track,
        np.minimum(gap_a, 50), np.minimum(gap_b, 50),
        np.where(has_a, size_rel[ia], 0), np.where(has_b, size_rel[ib], 0),
        np.where(has_a, bold[ia], -1), np.where(has_b, bold[ib], -1),
        np.where(has_a, (x0[ia] - x0) / W, 0), np.where(has_b, (x0[ib] - x0) / W, 0), same_row,
        np.r_[0, size_rel[:-1]], np.r_[size_rel[1:], 0], prev_same, next_same,
        blk_lines, lib, lib == blk_lines - 1,
        np.log1p(near), cover, fcover, np.log1p(dwide), np.full(n, np.log1p(len(d))), in_img, np.full(n, len(im)),
        np.full(n, n), np.full(n, (T[:, 8] * T[:, 12]).sum() / max(1, T[:, 12].sum())),
        np.full(n, (T[:, 7] * T[:, 12]).sum() / max(1, T[:, 12].sum())), np.full(n, size_rel.max()),
        np.minimum(in_fig, 1), np.full(n, len(figs)), np.log1p(dup),
    ])
    X = np.column_stack([G, T, N]).astype(np.float32)
    assert X.shape[1] == len(NAMES), (X.shape, len(NAMES))
    return X
