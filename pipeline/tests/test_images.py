"""The import worker's image rules (images.py): the shared fixture manifest
the browser's compressor also meets, and an imported DOCX/PPTX/XLSX with its
pictures compressed and its EMF and WMF pictures removed."""

from __future__ import annotations

import io
import json
import re
import zipfile
from pathlib import Path

import pytest
from PIL import Image, UnidentifiedImageError

from pipeline.ingest import images

FIXTURES = Path(__file__).parents[2] / "e2e/fixtures/files"
MANIFEST = json.loads((FIXTURES / "images/manifest.json").read_text())
MB = 1 << 20
DECODED = 100_000_000


def _shape(data: bytes) -> list:
    with Image.open(io.BytesIO(data)) as image:
        return [image.format.lower(), *image.size]


@pytest.mark.parametrize("name", sorted(MANIFEST["office"]))
def test_office_rule_meets_the_shared_manifest(name):
    data = (FIXTURES / "images" / name).read_bytes()
    result = images.compress(data, 2 * MB, DECODED)
    assert _shape(data if result is None else result[0]) == MANIFEST["office"][name]


# Pillow here has no HEIF decoder (pillow-heif bundles the GPL x265): an
# imported HEIC is kept within 5 MP and refused past it (import_stage.py).
@pytest.mark.parametrize("name", sorted(set(MANIFEST["source"]) - {"photo.heic"}))
def test_source_rule_meets_the_shared_manifest(name):
    data = (FIXTURES / "images" / name).read_bytes()
    result = images.compress(data, 30 * MB, DECODED, max_pixels=5_000_000)
    assert _shape(data if result is None else result[0]) == MANIFEST["source"][name]


def test_heic_does_not_decode_here():
    with pytest.raises(UnidentifiedImageError):
        images.compress(
            (FIXTURES / "images/photo.heic").read_bytes(),
            30 * MB,
            DECODED,
            max_pixels=5_000_000,
        )


def _png(size, mode="RGB") -> bytes:
    """Gradients with a little noise (none when transparent): a photo by its
    colours, small enough as JPEG at 2,400 px."""
    ramp = Image.linear_gradient("L")
    noise = Image.effect_noise(size, 8) if mode == "RGB" else ramp.resize(size)
    image = Image.merge("RGB", [ramp.resize(size), ramp.rotate(90).resize(size), noise])
    if mode == "RGBA":
        image.putalpha(ramp.resize(size))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def _jpeg(size) -> bytes:
    buffer = io.BytesIO()
    Image.open(io.BytesIO(_png(size))).save(buffer, "JPEG", quality=95)
    return buffer.getvalue()


EMF = b"\x01\x00\x00\x00" + b"\x00" * 36 + b" EMF" + b"\x00" * 64
WMF = b"\xd7\xcd\xc6\x9a" + b"\x00" * 40


def _rel(rel_id, kind, target):
    return (
        f'<Relationship Id="{rel_id}" Type="http://schemas.openxmlformats.org/'
        f'officeDocument/2006/relationships/{kind}" Target="{target}"/>'
    )


def _package(name: str, edit) -> bytes:
    with zipfile.ZipFile(FIXTURES / "rich-content" / name) as archive:
        parts = {info.filename: archive.read(info) for info in archive.infolist()}
    edit(parts)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, data in parts.items():
            archive.writestr(path, data)
    return out.getvalue()


def _add(parts, path, before, text):
    parts[path] = parts[path].decode().replace(before, text + before, 1).encode()


def test_docx_photos_shrink_a_png_photo_turns_jpeg_and_a_wmf_equation_goes():
    # A small JPEG whose re-encode at quality 85 is larger: kept as it is.
    buffer = io.BytesIO()
    Image.effect_noise((300, 200), 60).convert("RGB").save(buffer, "JPEG", quality=60)
    small = buffer.getvalue()

    def edit(parts):
        parts["word/media/image1.png"] = _png((3000, 2000))
        parts["word/media/image2.png"] = _png((2600, 2600), "RGBA")
        parts["word/media/image3.png"] = small
        parts["word/media/photo.jpg"] = _jpeg((4000, 3000))
        parts["word/media/image9.wmf"] = WMF
        parts["word/embeddings/oleObject1.bin"] = b"\x01\x02"
        document = parts["word/document.xml"].decode()
        drawing = re.search(r"<w:drawing>.*?</w:drawing>", document).group(0)
        _add(
            parts,
            "word/document.xml",
            "<w:sectPr",
            "<w:p><w:r>"
            + re.sub(r'r:embed="\w+"', 'r:embed="rId100"', drawing)
            + '</w:r></w:p><w:p><w:r><w:object><v:shape><v:imagedata r:id="rId101"/></v:shape>'
            '<o:OLEObject Type="Embed" ProgID="Equation.3" r:id="rId102"/></w:object></w:r></w:p>',
        )
        _add(
            parts,
            "word/_rels/document.xml.rels",
            "</Relationships>",
            _rel("rId100", "image", "media/photo.jpg")
            + _rel("rId101", "image", "media/image9.wmf")
            + _rel("rId102", "oleObject", "embeddings/oleObject1.bin"),
        )
        _add(
            parts,
            "[Content_Types].xml",
            "</Types>",
            '<Default Extension="jpg" ContentType="image/jpeg"/>'
            '<Override PartName="/word/embeddings/oleObject1.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>',
        )

    package, removed = images.compress_office(
        _package("exchange-plan.docx", edit), 2 * MB, DECODED
    )
    assert removed == 1
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        names = archive.namelist()
        assert "word/media/image9.wmf" not in names
        assert "word/embeddings/oleObject1.bin" not in names
        assert "word/media/image1.png" not in names
        assert _shape(archive.read("word/media/image1.jpeg")) == ["jpeg", 2400, 1600]
        assert _shape(archive.read("word/media/image2.png")) == ["png", 2400, 2400]
        assert _shape(archive.read("word/media/photo.jpg")) == ["jpeg", 2400, 1800]
        assert archive.read("word/media/image3.png") == small
        rels = archive.read("word/_rels/document.xml.rels").decode()
        assert 'Target="media/image1.jpeg"' in rels
        assert "image9.wmf" not in rels and "oleObject1.bin" not in rels
        types = archive.read("[Content_Types].xml").decode()
        assert '<Default Extension="jpeg" ContentType="image/jpeg"/>' in types
        assert "oleObject1.bin" not in types
        assert "w:object" not in archive.read("word/document.xml").decode()
        assert all(
            len(archive.read(name)) <= 2 * MB for name in names if "/media/" in name
        )


def test_pptx_emf_picture_goes_and_every_slide_follows_a_rename():
    def edit(parts):
        parts["ppt/media/image1.png"] = _png((3000, 2000))
        parts["ppt/media/image99.emf"] = EMF
        _add(
            parts,
            "ppt/slides/slide1.xml",
            "</p:spTree>",
            '<p:pic><p:nvPicPr><p:cNvPr id="900" name="Visio drawing"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
            '<p:blipFill><a:blip r:embed="rId100"/></p:blipFill><p:spPr/></p:pic>',
        )
        _add(
            parts,
            "ppt/slides/_rels/slide1.xml.rels",
            "</Relationships>",
            _rel("rId100", "image", "../media/image99.emf"),
        )

    package, removed = images.compress_office(
        _package("lecture.pptx", edit), 2 * MB, DECODED
    )
    assert removed == 1
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        assert "ppt/media/image99.emf" not in archive.namelist()
        assert "Visio drawing" not in archive.read("ppt/slides/slide1.xml").decode()
        for slide in ("slide2", "slide4"):
            assert (
                "../media/image1.jpeg"
                in archive.read(f"ppt/slides/_rels/{slide}.xml.rels").decode()
            )


def test_xlsx_emf_anchor_goes():
    def edit(parts):
        parts["xl/media/image2.emf"] = EMF
        anchor = (
            '<xdr:oneCellAnchor><xdr:pic><xdr:blipFill><a:blip r:embed="rId2"/></xdr:blipFill>'
            "</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>"
        )
        parts["xl/drawings/drawing1.xml"] = parts["xl/drawings/drawing1.xml"].replace(
            b"/>", (">" + anchor + "</xdr:wsDr>").encode(), 1
        )
        parts["xl/drawings/_rels/drawing1.xml.rels"] = (
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + _rel("rId2", "image", "../media/image2.emf")
            + "</Relationships>"
        ).encode()

    package, removed = images.compress_office(
        _package("course-guide.xlsx", edit), 2 * MB, DECODED
    )
    assert removed == 1
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        assert "xl/media/image2.emf" not in archive.namelist()
        assert "oneCellAnchor" not in archive.read("xl/drawings/drawing1.xml").decode()


def test_a_package_whose_pictures_cannot_shrink_is_kept():
    buffer = io.BytesIO()
    Image.effect_noise((300, 200), 60).convert("RGB").save(buffer, "JPEG", quality=60)

    def edit(parts):
        for name in ("image1", "image2", "image3"):
            parts[f"word/media/{name}.png"] = buffer.getvalue()

    assert images.compress_office(
        _package("exchange-plan.docx", edit), 2 * MB, DECODED
    ) == (
        None,
        0,
    )


def test_remove_pictures_takes_a_pptx_ole_frame_whole_and_counts_it_once():
    xml = (
        '<p:spTree><mc:AlternateContent><mc:Choice Requires="v"><p:graphicFrame><p:oleObj r:id="rId2"><p:embed/>'
        '</p:oleObj></p:graphicFrame></mc:Choice><mc:Fallback><p:graphicFrame><p:oleObj r:id="rId2"><p:embed/>'
        '<p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill></p:pic></p:oleObj></p:graphicFrame></mc:Fallback>'
        '</mc:AlternateContent><p:sp><p:spPr><a:blipFill><a:blip r:embed="rId3"/></a:blipFill></p:spPr>'
        "<p:txBody>kept</p:txBody></p:sp></p:spTree>"
    )
    out, refs, count = images.remove_pictures("ppt/slides/slide1.xml", xml, {"rId3"})
    assert (
        out
        == "<p:spTree><p:sp><p:spPr></p:spPr><p:txBody>kept</p:txBody></p:sp></p:spTree>"
    )
    assert count == 2
    assert sorted(refs) == ["rId2", "rId2", "rId3", "rId3"]


def test_resolve_target():
    assert images.resolve_target("word/", "media/image1.png") == "word/media/image1.png"
    assert (
        images.resolve_target("ppt/slides/", "../media/a%20b.png")
        == "ppt/media/a b.png"
    )
    assert images.resolve_target("xl/", "/xl/media/x.emf") == "xl/media/x.emf"
