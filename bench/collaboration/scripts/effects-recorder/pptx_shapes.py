"""Shape boxes of one PPTX slide, for clicking on the editor's canvas.

  python pptx_shapes.py <file.pptx> <slide number, 1-based>

JSON {width, height, shapes: [{kind, name, text, x, y, cx, cy}]} in EMU;
placeholders without their own xfrm take their layout's, then master's.
"""

import json
import posixpath
import sys
import zipfile
from xml.etree import ElementTree as ET

A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def rels(z, part):
    folder, name = posixpath.split(part)
    path = posixpath.join(folder, "_rels", name + ".rels")
    if path not in z.namelist():
        return {}
    out = {}
    for r in ET.fromstring(z.read(path)).iter(PR + "Relationship"):
        target = r.get("Target") or ""
        if r.get("TargetMode") == "External":
            continue
        out[r.get("Id")] = (r.get("Type", "").rsplit("/", 1)[-1],
                            target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(folder, target)))
    return out


def xfrm(node):
    for path in (f"{P}spPr/{A}xfrm", f"{P}xfrm", f"{P}grpSpPr/{A}xfrm"):
        x = node.find(path)
        if x is not None and x.find(A + "off") is not None:
            off, ext = x.find(A + "off"), x.find(A + "ext")
            return [int(off.get("x")), int(off.get("y")), int(ext.get("cx")), int(ext.get("cy"))]
    return None


def placeholder(node):
    for nv in (f"{P}nvSpPr/{P}nvPr/{P}ph", f"{P}nvPicPr/{P}nvPr/{P}ph", f"{P}nvGraphicFramePr/{P}nvPr/{P}ph"):
        ph = node.find(nv)
        if ph is not None:
            return ph.get("type") or "body", ph.get("idx")
    return None


def inherited(tree, ph):
    if tree is None or ph is None:
        return None
    kind, idx = ph
    candidates = []
    for sp in tree.iter(P + "sp"):
        other = placeholder(sp)
        if other is None:
            continue
        box = xfrm(sp)
        if box is None:
            continue
        if idx is not None and other[1] == idx:
            return box
        if other[0] == kind or (kind in ("ctrTitle", "title") and other[0] in ("ctrTitle", "title")):
            candidates.append(box)
    return candidates[0] if candidates else None


def main():
    path, number = sys.argv[1], int(sys.argv[2])
    z = zipfile.ZipFile(path)
    pres = ET.fromstring(z.read("ppt/presentation.xml"))
    size = pres.find(P + "sldSz")
    pres_rels = rels(z, "ppt/presentation.xml")
    slide_part = pres_rels[list(pres.iter(P + "sldId"))[number - 1].get(R + "id")][1]
    slide = ET.fromstring(z.read(slide_part))
    layout_part = next((t for kind, t in rels(z, slide_part).values() if kind == "slideLayout"), None)
    layout = ET.fromstring(z.read(layout_part)) if layout_part else None
    master_part = next((t for kind, t in rels(z, layout_part).values() if kind == "slideMaster"), None) if layout_part else None
    master = ET.fromstring(z.read(master_part)) if master_part else None
    shapes = []
    tree = slide.find(f"{P}cSld/{P}spTree")
    for node in tree:
        tag = node.tag.rsplit("}", 1)[-1]
        if tag not in ("sp", "pic", "graphicFrame", "grpSp", "cxnSp"):
            continue
        box = xfrm(node) or inherited(layout, placeholder(node)) or inherited(master, placeholder(node))
        name_node = node.find(".//" + P + "cNvPr")
        text = ["".join(t.text or "" for t in p.iter(A + "t")) for p in node.iter(A + "p")]
        shapes.append({
            "kind": "table" if node.find(f".//{A}tbl") is not None else tag,
            "name": name_node.get("name") if name_node is not None else "",
            "placeholder": placeholder(node),
            "text": text,
            "box": box,
        })
    json.dump({"width": int(size.get("cx")), "height": int(size.get("cy")), "shapes": shapes}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
