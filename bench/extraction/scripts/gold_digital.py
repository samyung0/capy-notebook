"""Gold figure boxes for born-digital papers, from the PDF itself: the
drawings, images and words inside each figure's hand-set seed region
(fixtures/digital/seeds.json), as a box on the 0-1000 page grid.

    python -I bench/extraction/scripts/gold_digital.py <references>/born-digital [--render <dir>]

Writes fixtures/digital/figures.json; with --render, each page with its gold
boxes for a check by eye.
"""

import json
import sys
from pathlib import Path

import pymupdf

HERE = Path(__file__).resolve().parents[1] / "fixtures" / "digital"


def gold_box(page: pymupdf.Page, seed: list[float]) -> list[int]:
    w, h = page.rect.width, page.rect.height
    region = pymupdf.Rect(
        seed[0] * w / 1000, seed[1] * h / 1000, seed[2] * w / 1000, seed[3] * h / 1000
    )
    parts = [pymupdf.Rect(d["rect"]) for d in page.get_drawings()]
    parts += [pymupdf.Rect(i["bbox"]) for i in page.get_image_info()]
    parts += [pymupdf.Rect(word[:4]) for word in page.get_text("words")]
    box = pymupdf.Rect()
    for r in parts:
        # Thin rules longer than the region (answer lines, frames) are not the figure.
        if r.width > region.width * 1.05 or r.height > region.height * 1.05:
            continue
        centre = pymupdf.Point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)
        if region.contains(centre):
            box = r if box.is_empty and box.width == 0 else box | r
    return [
        round(box.x0 / w * 1000),
        round(box.y0 / h * 1000),
        round(box.x1 / w * 1000),
        round(box.y1 / h * 1000),
    ]


def main() -> None:
    refs = Path(sys.argv[1])
    render = (
        Path(sys.argv[sys.argv.index("--render") + 1])
        if "--render" in sys.argv
        else None
    )
    seeds = json.loads((HERE / "seeds.json").read_text())
    out = []
    docs = {}
    for fig in seeds["figures"]:
        doc = docs.setdefault(
            fig["paper"], pymupdf.open(refs / fig["paper"] / "paper.pdf")
        )
        out.append(
            {
                **{k: fig[k] for k in ("paper", "page", "label", "description")},
                "box": gold_box(doc[fig["page"] - 1], fig["seed"]),
            }
        )
    (HERE / "figures.json").write_text(json.dumps({"figures": out}, indent=1) + "\n")
    if render:
        from PIL import Image, ImageDraw

        render.mkdir(parents=True, exist_ok=True)
        pages: dict[tuple[str, int], list[dict]] = {}
        for fig in out:
            pages.setdefault((fig["paper"], fig["page"]), []).append(fig)
        for (paper, number), figs in pages.items():
            page = docs[paper][number - 1]
            s = 1100 / page.rect.height
            pix = page.get_pixmap(matrix=pymupdf.Matrix(s, s))
            im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            d = ImageDraw.Draw(im)
            for fig in figs:
                b = fig["box"]
                d.rectangle(
                    [
                        b[0] * pix.width / 1000,
                        b[1] * pix.height / 1000,
                        b[2] * pix.width / 1000,
                        b[3] * pix.height / 1000,
                    ],
                    outline=(0, 170, 0),
                    width=2,
                )
            im.save(render / f"{paper[:14]}-{number:02d}.png")
    print(len(out), "figures")


if __name__ == "__main__":
    main()
