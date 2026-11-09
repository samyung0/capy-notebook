"""A 10-page handwritten answer paper with planted mistakes, for whole-paper marking.

Questions, marking items, the expected mark of every part, and what each page
holds. Q6 runs over pages 5 and 6, Q10 is answered after Q11, Q7 is a sketch and
Q12 is left blank.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf"

# label, question text, [(marks, item)], expected mark
PARTS = [
    ("1a", "1 (a) Define osmosis.", [(1, "net movement of water molecules"), (1, "across a partially permeable membrane from a dilute to a more concentrated solution")], 2),
    ("1b", "1 (b) Name the organelle where aerobic respiration takes place.", [(1, "mitochondrion / mitochondria")], 0),
    ("2", "2. Solve $3x + 7 = 22$. Show your working.", [(1, "M1 subtracts 7 and divides by 3"), (1, "A1 $x = 5$")], 2),
    ("3a", "3 (a) Expand $(x+3)(x-2)$.", [(1, "M1 four correct terms"), (1, "A1 $x^2 + x - 6$")], 2),
    ("3b", "3 (b) Factorise $x^2 - 9$.", [(1, "$(x-3)(x+3)$")], 0),
    ("4a", "4. A car accelerates uniformly from rest to 24 m/s in 6 s. (a) Calculate its acceleration.", [(1, "M1 $a = (v-u)/t$"), (1, "A1 4 m/s²")], 2),
    ("4b", "4. A car accelerates uniformly from rest to 24 m/s in 6 s. (b) Calculate the distance it travels in the 6 s.", [(1, "M1 $s = \\frac{1}{2}(u+v)t$ or $s = \\frac{1}{2}at^2$"), (1, "A1 72 m")], 0),
    ("5", "5. Explain why the rate of photosynthesis stops increasing at high light intensity.", [(1, "another factor becomes limiting"), (1, "names carbon dioxide concentration or temperature"), (1, "light is no longer the limiting factor")], 3),
    ("6", "6. Describe the journey of blood from the right ventricle until it returns to the heart.", [(1, "pulmonary artery to the lungs"), (1, "gas exchange: blood is oxygenated in the lungs"), (1, "pulmonary vein to the left atrium"), (1, "left ventricle pumps it into the aorta")], 3),
    ("7", "7. Sketch the graph of $y = 2x + 1$ for $0 \\le x \\le 3$.", [(1, "straight line with positive gradient"), (1, "passes through (0, 1) and (3, 7)")], 2),
    ("8a", "8 (a) Calculate the mean of 4, 7, 9, 12.", [(1, "M1 sum divided by 4"), (1, "A1 8")], 2),
    ("8b", "8 (b) Find the median of 3, 9, 4, 7, 5.", [(1, "5")], 0),
    ("9", "9. State two differences between plant and animal cells.", [(1, "first correct difference, e.g. cell wall"), (1, "second correct difference, e.g. chloroplasts or permanent vacuole")], 2),
    ("10", "10. A lamp has 12 V across it and a current of 3 A. Calculate its resistance.", [(1, "M1 $R = V/I$"), (1, "A1 4 Ω")], 2),
    ("11", "11. State the function of red blood cells.", [(1, "carry oxygen")], 0),
    ("12", "12. State the unit of force.", [(1, "newton")], 0),
]

# Each page: lines of handwriting; "GRAPH" draws the Q7 sketch.
PAGES = [
    ["Name: Cara Moss    Science & Maths P1", "", "1 (a) Osmosis is the net movement of water", "      molecules across a partially permeable", "      membrane from a dilute solution to a", "      more concentrated one.", "", "  (b) nucleus"],
    ["2   3x + 7 = 22", "    3x = 15", "    x = 5", "", "3 (a) (x + 3)(x - 2)", "      = x^2 - 2x + 3x - 6", "      = x^2 + x - 6"],
    ["3 (b) x^2 - 9 = (x - 3)(x - 3)", "", "4 (a) a = (v - u) / t", "      = (24 - 0) / 6", "      = 4 m/s^2"],
    ["4 (b) s = v x t = 24 x 6 = 144 m", "", "5   Because carbon dioxide becomes the", "    limiting factor, so light is no longer", "    the limiting factor and more light", "    does not increase the rate."],
    ["6   The right ventricle pumps blood into the", "    pulmonary artery, which takes it to the", "    lungs. In the lungs the blood picks up", "    oxygen and gives out carbon dioxide", "    (gas exchange) so it becomes"],
    ["    oxygenated. It then goes back through", "    the pulmonary vein into the left atrium", "    of the heart.", "", "   (continued from page 5)"],
    ["7", "GRAPH"],
    ["8 (a) mean = (4 + 7 + 9 + 12) / 4", "         = 32 / 4 = 8", "", "  (b) median = 4", "", "9   cell wall, chloroplasts, vacuole", "", "11  red blood cells fight infection"],
    ["10  R = V / I", "      = 12 / 3", "      = 4 ohms", "", "    (Q10 answered here, after Q11)"],
    ["12", "", "", "    (rough working)", "    F = ma ?"],
]


def render(page: list[str], long_edge: int) -> Image.Image:
    w, h = 2480, 3508
    img = Image.new("RGB", (w, h), (246, 244, 238))
    d = ImageDraw.Draw(img)
    for y in range(300, h - 150, 110):
        d.line([(120, y), (w - 120, y)], fill=(185, 200, 225), width=3)
    font = ImageFont.truetype(FONT, 84)
    y = 205
    for line in page:
        if line == "GRAPH":
            ox, oy, unit = 500, 2300, 230  # origin and pixels per unit
            ink = (30, 40, 90)
            d.line([(ox - 60, oy), (ox + 4 * unit, oy)], fill=ink, width=7)
            d.line([(ox, oy + 60), (ox, oy - 8 * unit)], fill=ink, width=7)
            d.text((ox + 4 * unit + 20, oy - 40), "x", font=font, fill=ink)
            d.text((ox - 40, oy - 8 * unit - 110), "y", font=font, fill=ink)
            for i in range(1, 4):
                d.line([(ox + i * unit, oy - 15), (ox + i * unit, oy + 15)], fill=ink, width=5)
                d.text((ox + i * unit - 20, oy + 25), str(i), font=font, fill=ink)
            for j in (1, 3, 5, 7):
                d.line([(ox - 15, oy - j * unit), (ox + 15, oy - j * unit)], fill=ink, width=5)
                d.text((ox - 110, oy - j * unit - 45), str(j), font=font, fill=ink)
            d.line([(ox, oy - unit), (ox + 3 * unit, oy - 7 * unit)], fill=ink, width=9)
            d.text((ox + 3 * unit + 30, oy - 7 * unit - 40), "(3, 7)", font=font, fill=ink)
            d.text((ox + 30, oy - unit + 10), "(0, 1)", font=font, fill=ink)
            d.text((ox + 1 * unit, oy - 5 * unit), "y = 2x + 1", font=font, fill=ink)
            continue
        d.text((170, y), line, font=font, fill=(30, 40, 90))
        y += 110 if line else 90
    img = img.rotate(0.6, fillcolor=(230, 228, 222), resample=Image.BICUBIC)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    scale = long_edge / max(img.size)
    return img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for edge in (1024, 1568):
        for n, page in enumerate(PAGES, 1):
            render(page, edge).save(out / f"p{n:02d}_{edge}.jpg", "JPEG", quality=75)
    print("rendered", len(PAGES), "pages to", out)
