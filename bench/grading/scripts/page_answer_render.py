"""Render a synthetic handwritten answer page (A4) at a given long edge."""
import random, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

LINES = [
    "Name: Cara Lim        Physics/Maths homework   P1",
    "",
    "1 (a)  v = u + at",
    "        = 0 + 9.8 x 3",
    "        = 29.4 m/s",
    "   (b)  s = ut + 1/2 a t^2",
    "        = 1/2 x 9.8 x 3^2 = 44.1 m",
    "",
    "2 (a)  Plants need light because light energy is",
    "       absorbed by chlorophyll and used to split",
    "       water, making the energy for glucose.",
    "   (b)  more light -> faster rate until CO2 or",
    "        temperature becomes the limiting factor",
    "",
    "3   x^2 - 5x + 6 = 0",
    "    (x - 2)(x - 3) = 0",
    "    x = 2  or  x = 3",
    "",
    "4   Area = 1/2 x base x height = 1/2 x 8 x 5",
    "         = 20 cm^2",
]

def render(long_edge: int, out: str, crop_q3: bool = False):
    w, h = 2480, 3508  # A4 at 300 dpi
    img = Image.new("RGB", (w, h), (246, 244, 238))
    d = ImageDraw.Draw(img)
    for y in range(300, h - 150, 110):  # ruled lines
        d.line([(120, y), (w - 120, y)], fill=(185, 200, 225), width=3)
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf", 84)
    rnd = random.Random(7)
    y = 205
    boxes = {}
    for i, line in enumerate(LINES):
        x = 170 + rnd.randint(-10, 10)
        d.text((x, y + rnd.randint(-6, 6)), line, font=font, fill=(30, 40, 90))
        if line.startswith("3 "):
            boxes["q3_top"] = y - 40
        if line.startswith("4 "):
            boxes["q3_bottom"] = y - 30
        y += 110 if line else 90
    img = img.rotate(0.8, fillcolor=(230, 228, 222), resample=Image.BICUBIC)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    if crop_q3:
        img = img.crop((0, boxes["q3_top"], w, boxes["q3_bottom"]))
    scale = long_edge / max(img.size)
    img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    img.save(out, "JPEG", quality=75)
    print(out, img.size)

if __name__ == "__main__":
    render(int(sys.argv[1]), sys.argv[2], crop_q3=len(sys.argv) > 3)
