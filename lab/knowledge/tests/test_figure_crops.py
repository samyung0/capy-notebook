"""Stored library figure crops (Epo 2026-11-04): which figures the loader crops
and under which key, today's render byte for byte, the object a crop is
rendered from, the refusal when a crop is missing after the upload, and an
excluded figure painted white inside a crop."""

import io
import shutil
from types import SimpleNamespace

import knowledge_base_library as library
import pymupdf
import pytest
from knowledge_base_common import PilotError
from PIL import Image

from pipeline.retrieval import capture
from pipeline.retrieval.library import blanked, figure_key
from pipeline.store import blobstore


def _figure(bbox, page=1, **flags) -> dict:
    return {"page": page, "bbox": bbox, "decorative": False, "excluded": False, **flags}


def _pdf(path, fill) -> tuple:
    """A one-page book of one colour, and its SHA-256."""
    with pymupdf.open() as doc:
        page = doc.new_page(width=400, height=600)
        page.draw_rect(page.rect, color=fill, fill=fill)
        doc.save(path)
    return path, library.file_sha256(path)


class Bucket:
    """The knowledge-base bucket: listed with the read key, written with the
    writer key, and its books downloaded with the read key. ``keep=False``
    loses every PUT."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.books: dict[str, str] = {}
        self.keep = True

    def put_object(self, Bucket, Key, Body, ContentType):
        assert ContentType == "image/jpeg"
        if self.keep:
            self.objects[Key] = Body

    def listed(self, prefix: str) -> set[str]:
        return {key for key in self.objects if key.startswith(prefix)}

    def download(self, key, path, max_bytes):
        shutil.copyfile(self.books[key], path)
        return 1, "sha"


@pytest.fixture
def bucket(monkeypatch):
    bucket = Bucket()
    monkeypatch.setattr(library, "stored_crops", bucket.listed)
    monkeypatch.setattr(library, "writer_client", lambda: bucket)
    monkeypatch.setattr(blobstore, "library_download_file", bucket.download)
    return bucket


@pytest.fixture
def black(tmp_path):
    return _pdf(tmp_path / "black.pdf", (0, 0, 0))


@pytest.fixture
def white(tmp_path):
    return _pdf(tmp_path / "white.pdf", (1, 1, 1))


def _pixel(crop: bytes, x: float, y: float) -> tuple:
    """The crop's pixel at fractions of its width and height."""
    with Image.open(io.BytesIO(crop)) as image:
        return image.getpixel((int(image.width * x), int(image.height * y)))


def test_only_shown_figures_get_a_crop_keyed_by_page_and_box():
    figures = [
        _figure([100, 100, 400, 400], page=3),
        # Fractions round as the library's int[] column stores them.
        _figure([-5.2, 10.4, 300.5, 1004.6], page=3),
        _figure([500, 500, 600, 600], page=3, decorative=True),
        _figure([600, 600, 700, 700], page=3, excluded=True),
        _figure([610, 610, 700, 690], page=3),  # inside the excluded box
        _figure([100, 100, 100.4, 300], page=3),  # no width once rounded
        _figure([100, 100, 400, 400], page=4),  # a withheld page
        _figure([0, 0, 1000, 1000], page=3),  # a whole-page record
    ]
    assert library.crop_jobs("books/abc.pdf", figures, [4]) == {
        "figures/abc/3_100_100_400_400.jpg": (3, [100, 100, 400, 400], []),
        "figures/abc/3_-5_10_300_1005.jpg": (3, [-5, 10, 300, 1005], []),
    }
    assert library.unrenderable(figures, [4]) == 1
    # The reader keys the crop by the stored box, which it reads as floats.
    assert figure_key("books/abc.pdf", 3, [-5.0, 10.0, 300.0, 1005.0], []) == (
        "figures/abc/3_-5_10_300_1005.jpg"
    )


def test_a_crop_is_todays_render_and_a_republish_uploads_none(bucket, black):
    pdf, sha = black
    key = f"books/{sha}.pdf"
    jobs = library.crop_jobs(key, [_figure([0, 0, 1000, 500])], [])

    assert library.ensure_crops(key, jobs, pdf, 0) == {"crops": 1, "uploaded": 1}
    assert bucket.objects == {
        f"figures/{sha}/1_0_0_1000_500.jpg": capture.render(
            pdf, 1, [0, 0, 1000, 500], 1568
        )[0]
    }
    assert library.ensure_crops(key, jobs, pdf, 0) == {"crops": 1, "uploaded": 0}


def test_a_run_pdf_unlike_the_published_object_is_not_rendered(bucket, black, white):
    """A capture copy is published in place of its source: its crops come
    from the object, downloaded, so a redaction stays in them."""
    source, _ = black
    published, sha = white
    key = f"books/{sha}.pdf"
    bucket.books[key] = published
    jobs = library.crop_jobs(key, [_figure([0, 0, 1000, 500])], [])

    library.ensure_crops(key, jobs, source, 0)
    [crop] = bucket.objects.values()
    assert crop == capture.render(published, 1, [0, 0, 1000, 500], 1568)[0]


class Written(Exception):
    """publish_book reached its transaction, where writing starts."""


class Database:
    """publish_book's pilot and library databases, answering as for a book's
    first publish."""

    def execute(self, sql, params=()):
        first = (0,) if "max(version)" in sql else None
        return SimpleNamespace(fetchone=lambda: first, fetchall=list)

    def transaction(self):
        raise Written


def test_publish_stores_the_verified_objects_crops_before_writing(
    bucket, black, white, monkeypatch, tmp_path
):
    """capture_privacy binds verify_object to its capture copy: the crops go
    under that copy's key, rendered from it, and a crop still missing refuses
    before anything is written."""
    source, source_sha = black
    copy, copy_sha = white
    bucket.books[f"books/{copy_sha}.pdf"] = copy
    monkeypatch.setattr(library, "verify_object", lambda sha: f"books/{copy_sha}.pdf")
    book = {
        "id": "b",
        "authors": ["A"],
        "sha256": source_sha,
        "pdf_path": str(source),
        "bytes": 0,
    }
    corpus = {
        "book": {"id": "b"},
        "source_id": "s",
        "chunks": [],
        "figures": [{"id": "f1", "page": 1, "bbox": [0, 0, 1000, 500], "excluded": False}],
    }
    args = dict(
        run=tmp_path,
        book=book,
        book_corpus=corpus,
        topics=[],
        tags={"tags": {}},
        captures={"captures": []},
        model_runs=[],
        identity="i",
        note="",
    )

    with pytest.raises(Written):
        library.publish_book(Database(), Database(), **args)
    assert bucket.objects == {
        f"figures/{copy_sha}/1_0_0_1000_500.jpg": capture.render(
            copy, 1, [0, 0, 1000, 500], 1568
        )[0]
    }

    bucket.objects.clear()
    bucket.keep = False
    with pytest.raises(PilotError, match="figure crops are not in the bucket"):
        library.publish_book(Database(), Database(), **args)


def test_a_republish_that_excludes_an_overlapping_figure_gets_a_fresh_crop(
    bucket, black
):
    pdf, sha = black
    key = f"books/{sha}.pdf"
    shown = _figure([0, 0, 1000, 500])
    first = library.crop_jobs(key, [shown], [])
    library.ensure_crops(key, first, pdf, 0)

    # Its bottom fifth is now another figure's, excluded by a rights review.
    excluded = _figure([0, 400, 1000, 1000], excluded=True)
    second = library.crop_jobs(key, [shown, excluded], [])
    assert library.ensure_crops(key, second, pdf, 0)["uploaded"] == 1
    [new] = set(second) - set(first)
    assert new == figure_key(
        key, 1, [0, 0, 1000, 500], blanked([0, 0, 1000, 500], [[0, 400, 1000, 1000]])
    ), "the reader keys it from the same rows"
    assert max(_pixel(bucket.objects[new], 0.5, 0.1)) < 15
    assert min(_pixel(bucket.objects[new], 0.5, 0.9)) > 240


def test_a_crop_paints_an_overlapping_excluded_figure_white(bucket, black):
    """An offset crop: the excluded box covers its lower left corner and
    reaches past its edges."""
    pdf, sha = black
    key = f"books/{sha}.pdf"
    figures = [
        _figure([200, 200, 800, 800]),
        _figure([100, 600, 500, 900], excluded=True),
    ]
    library.ensure_crops(key, library.crop_jobs(key, figures, []), pdf, 0)

    [crop] = bucket.objects.values()
    assert min(_pixel(crop, 0.25, 0.9)) > 240
    assert max(_pixel(crop, 0.75, 0.9)) < 15
    assert max(_pixel(crop, 0.25, 0.5)) < 15
