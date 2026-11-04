"""Make a quiz's layout client: which regions become boxes, the crop a pick
makes, and the service's answers, busy and failed (pipeline.retrieval.layout)."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from pipeline.retrieval import layout
from pipeline.retrieval.layout import Region

JPEG = b"\xff\xd8jpeg"


def _region(label: str, box: list[float], score: float = 0.9) -> Region:
    return Region(label, score, box)


def test_figure_boxes_keep_pictures_and_charts_in_reading_order():
    """Pictures and charts at 0.5 or more stay, top to bottom, then left to
    right; of two nearly equal boxes the higher score stays."""
    right = _region("chart", [500, 100, 800, 300])
    left = _region("image", [100, 100, 400, 300])
    lower = _region("image", [100, 500, 400, 700])
    same = _region("chart", [100, 500, 400, 690], score=0.6)
    faint = _region("image", [100, 800, 400, 900], score=0.49)
    words = _region("text", [100, 320, 800, 480])
    title = _region("figure_title", [100, 310, 400, 330])
    found = layout.figure_boxes((lower, same, right, left, faint, words, title))
    assert found == [left, right, lower]


def test_a_box_holding_a_smaller_box_and_text_of_its_own_goes():
    """2022 Paper 2 Q14: the figure, and a box around it and its options. With
    no text of its own the outer box stays, as another choice."""
    inner = _region("image", [100, 100, 500, 300])
    outer = _region("image", [90, 90, 900, 600])
    options = _region("text", [100, 400, 500, 550])
    assert layout.figure_boxes((inner, outer, options)) == [inner]
    assert layout.figure_boxes((inner, outer)) == [outer, inner]


def test_a_crop_takes_all_its_boxes_an_adjacent_caption_and_a_one_percent_pad():
    first = [100.0, 100.0, 300.0, 300.0]
    second = [320.0, 110.0, 500.0, 290.0]
    regions = (
        _region("figure_title", [200, 310, 400, 325]),
        # Too far below, off to one side and too faint.
        _region("figure_title", [200, 400, 400, 420]),
        _region("figure_title", [600, 310, 800, 325]),
        _region("figure_title", [200, 60, 400, 80], score=0.4),
    )
    assert layout.crop_box([first, second], regions) == [90.0, 90.0, 510.0, 335.0]
    assert layout.crop_box([[0.0, 2.0, 1000.0, 995.0]], ()) == [
        0.0,
        0.0,
        1000.0,
        1000.0,
    ]


def _images(count: int = 1) -> list:
    async def image() -> str:
        return "data:image/jpeg;base64,/9hqcGVn"

    return [image] * count


@pytest.fixture
def service(monkeypatch):
    """The service as a handler; the requests it saw come back."""
    monkeypatch.setattr(layout.cfg, "layout_url", "http://10.77.0.2:8092")
    monkeypatch.setattr(layout.cfg, "layout_token", "t" * 40)
    monkeypatch.setattr(layout, "BUSY_WAIT_S", (0.0, 0.0))
    client = httpx.AsyncClient

    def install(handler) -> list[httpx.Request]:
        seen: list[httpx.Request] = []

        async def handle(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return await handler(request, len(seen))

        monkeypatch.setattr(
            layout.httpx,
            "AsyncClient",
            lambda **kwargs: client(transport=httpx.MockTransport(handle), **kwargs),
        )
        return seen

    return install


ANSWER = {"regions": [{"label": "image", "score": 0.97, "box": [1, 2, 3, 4]}]}


async def test_a_page_goes_as_its_jpeg_and_comes_back_as_regions(service):
    async def handler(request, _):
        return httpx.Response(200, json=ANSWER)

    seen = service(handler)
    [regions] = await layout.read_regions(_images())
    assert regions == (Region("image", 0.97, [1.0, 2.0, 3.0, 4.0]),)
    assert str(seen[0].url) == "http://10.77.0.2:8092/regions"
    assert seen[0].headers["authorization"] == "Bearer " + "t" * 40
    assert seen[0].content == JPEG


async def test_a_busy_service_is_tried_again_within_the_bound(service):
    async def handler(request, count):
        if count < layout.BUSY_TRIES:
            return httpx.Response(429, json={"error": "busy"})
        return httpx.Response(200, json=ANSWER)

    seen = service(handler)
    [regions] = await layout.read_regions(_images())
    assert len(seen) == layout.BUSY_TRIES
    assert len(regions) == 1


async def test_a_service_that_stays_busy_leaves_the_page_without_regions(service):
    async def handler(request, _):
        return httpx.Response(429, json={"error": "busy"})

    seen = service(handler)
    assert await layout.read_regions(_images()) == [()]
    assert len(seen) == layout.BUSY_TRIES


async def test_a_failed_page_leaves_the_others_their_regions(service):
    async def handler(request, count):
        if count == 1:
            raise httpx.ConnectError("refused")
        if count == 2:
            return httpx.Response(500)
        if count == 3:
            return httpx.Response(200, text="not json")
        return httpx.Response(200, json=ANSWER)

    service(handler)
    found = await layout.read_regions(_images(4))
    assert sorted(len(regions) for regions in found) == [0, 0, 0, 1]


async def test_pages_that_run_out_of_time_have_no_regions(service, monkeypatch):
    monkeypatch.setattr(layout, "ALL_PAGES_TIMEOUT_S", 0.05)
    monkeypatch.setattr(layout, "PAGES_IN_FLIGHT", 1)

    async def handler(request, count):
        if count > 1:
            await asyncio.sleep(5)
        return httpx.Response(200, json=ANSWER)

    service(handler)
    found = await layout.read_regions(_images(2))
    assert [len(regions) for regions in found] == [1, 0]


async def test_with_no_url_no_page_is_sent(service, monkeypatch):
    async def handler(request, _):
        return httpx.Response(200, json=ANSWER)

    seen = service(handler)
    monkeypatch.setattr(layout.cfg, "layout_url", "")
    assert await layout.read_regions(_images(2)) == [(), ()]
    assert seen == []
