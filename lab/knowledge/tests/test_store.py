from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import store


def test_ten_workers_claim_distinct_urls_and_recover_interrupted_claims():
    for i in range(10):
        store.enqueue_url(f"https://host{i}.test/book")
    barrier = Barrier(10)

    def claim(_):
        barrier.wait()
        return store.next_url(5)["url"]

    with ThreadPoolExecutor(max_workers=10) as workers:
        claimed = list(workers.map(claim, range(10)))
    assert len(set(claimed)) == 10
    assert store.next_url(0) is None
    assert store.startup_reset()["urls"] == 10
    assert store.url_counts()["by_status"] == {"pending": 10}


def test_concurrent_claims_reserve_host_delay_before_fetch(monkeypatch):
    monkeypatch.setattr(store.time, "time", lambda: 100)
    for i in range(10):
        store.enqueue_url(f"https://a.test/{i}")
    with ThreadPoolExecutor(max_workers=10) as workers:
        rows = list(workers.map(lambda _: store.next_url(5), range(10)))
    assert sum(row is not None for row in rows) == 1
    store.add_download({"pdf_url": "https://a.test/book.pdf"}, "queued")
    assert store.next_download(5) is None
    monkeypatch.setattr(store.time, "time", lambda: 106)
    assert store.next_download(5) is not None
    assert store.next_url(5) is None  # active download holds this host
    store.finish_download("https://a.test/book.pdf", "downloaded", 1)
    assert store.next_url(5) is None
    monkeypatch.setattr(store.time, "time", lambda: 112)
    assert store.next_url(5) is not None


def test_url_queue_dedupes_and_respects_host_delay_and_cap(monkeypatch):
    assert store.enqueue_url("https://a.test/1")
    assert not store.enqueue_url("https://a.test/1")
    assert store.enqueue_url(
        "https://a.test/2", depth=1, discovered_from="https://a.test/1"
    )
    assert store.enqueue_url("https://b.test/1")
    first = store.next_url(5)
    assert first["url"] == "https://a.test/1" and first["depth"] == 0
    store.mark_url(first["url"], "visited", {"relevant": True})
    # a.test was just touched: the next pick skips to b.test
    assert store.next_url(5)["url"] == "https://b.test/1"
    assert store.url_verdict("https://a.test/1") == {"relevant": True}
    monkeypatch.setattr(store, "PENDING_PER_HOST", 1)  # a.test already has /2 pending
    assert not store.enqueue_url("https://a.test/3")
    store.remove_url("https://a.test/2")
    assert store.url_counts()["by_status"] == {"scraping": 1, "visited": 1}


def test_download_queue_claims_once_and_records_duplicates():
    row = {
        "pdf_url": "https://a.test/x.pdf",
        "landing_url": "https://a.test",
        "title": "X",
        "authors": ["A"],
    }
    assert store.add_download(row, "queued")
    assert not store.add_download(row, "queued")
    assert store.add_download(
        {"pdf_url": "https://a.test/y.pdf", "title": "Y"},
        "rejected",
        "NonCommercial licence",
    )
    claimed = store.next_download(5)
    assert claimed["pdf_url"] == "https://a.test/x.pdf" and claimed["authors"] == ["A"]
    assert store.next_download(5) is None
    store.finish_download(
        "https://a.test/x.pdf",
        "downloaded",
        1,
        None,
        sha256="s" * 64,
        path="p",
        bytes=3,
        pages=2,
    )
    assert store.download_by_sha("s" * 64)["pages"] == 2
    # a.test was just finished: its next PDF waits out the host delay while
    # another host's PDF is claimed at once; a page fetch on the host counts too
    store.add_download({"pdf_url": "https://a.test/z.pdf"}, "queued")
    store.add_download({"pdf_url": "https://b.test/x.pdf"}, "queued")
    assert store.next_download(5)["pdf_url"] == "https://b.test/x.pdf"
    assert store.next_download(5) is None
    assert store.next_download(0)["pdf_url"] == "https://a.test/z.pdf"
    store.finish_download("https://a.test/z.pdf", "failed", 1, "x")
    store.enqueue_url("https://a.test/page")
    store.mark_url("https://a.test/page", "visited")
    store.add_download({"pdf_url": "https://a.test/w.pdf"}, "queued")
    assert store.next_download(5) is None and store.next_download(0) is not None
    store.mark_duplicate("https://b.test/x.pdf", "s" * 64, 1)
    rows = {d["pdf_url"]: d for d in store.downloads()}
    assert rows["https://a.test/x.pdf"]["duplicate_urls"] == ["https://b.test/x.pdf"]
    assert rows["https://b.test/x.pdf"]["status"] == "rejected"
    assert rows["https://a.test/y.pdf"]["last_error"] == "NonCommercial licence"


def test_book_queue_orders_moves_and_refuses_removing_a_running_book():
    for i in range(3):
        store.add_book(str(i) * 64, f"b{i}", {"id": f"b{i}"}, f"runs/b{i}")
    assert [b["book_id"] for b in store.books()] == ["b0", "b1", "b2"]
    store.move_book("2" * 64, -1)
    assert [b["book_id"] for b in store.books()] == ["b0", "b2", "b1"]
    store.move_book("0" * 64, -1)  # already first
    assert store.next_queued_book()["book_id"] == "b0"
    store.set_book("0" * 64, status="running", stage="parse")
    assert store.next_queued_book()["book_id"] == "b2"
    try:
        store.remove_book("0" * 64)
    except ValueError as exc:
        assert "running" in str(exc)
    else:
        raise AssertionError("a running book was removed")
    store.remove_book("1" * 64)
    assert store.book_ids() == {"b0", "b2"}
    run_id = store.start_stage_run("0" * 64, "parse", "log")
    store.finish_stage_run(run_id, 0, {"x": 1})
    assert store.stage_runs("0" * 64)[0]["usage"] == {"x": 1}
    store.record_llm_call(
        stage="topics",
        sha256="0" * 64,
        model="m",
        endpoint="e",
        elapsed_ms=5,
        ok=1,
        input_tokens=10,
        output_tokens=2,
    )
    assert store.llm_usage(0)["e"]["input_tokens"] == 10
    assert store.setting("scrape") == "paused"
    store.set_setting("scrape", "running")
    assert store.setting("scrape") == "running"


def test_review_tasks_and_the_startup_reset():
    for i in range(3):
        store.add_book(str(i) * 64, f"b{i}", {"id": f"b{i}"}, f"runs/b{i}")
    store.set_review_task(
        "0" * 64,
        "transcribe",
        batch_id="batch-0",
        status="completed",
        submitted_at=1.0,
        checked_at=None,
        requests=9,
    )
    store.set_review_task(
        "0" * 64,
        "tag",
        batch_id="batch-1",
        status="validating",
        submitted_at=2.0,
        requests=3,
    )
    assert store.review_task("0" * 64, "tag")["batch_id"] == "batch-1"
    assert store.review_task("1" * 64, "tag") is None
    assert [t["stage"] for t in store.review_tasks("0" * 64)] == ["transcribe", "tag"]
    store.set_book("0" * 64, status="waiting", stage="tag")
    store.set_book("1" * 64, status="running", stage="index")
    store.add_download({"pdf_url": "https://a.test/x.pdf"}, "queued")
    assert store.next_download(0)["status"] == "downloading"
    # the waiting book's current stage task only
    assert [(t["book_id"], t["stage"]) for t in store.open_review_tasks()] == [
        ("b0", "tag")
    ]
    assert store.waiting_book_due(600)["book_id"] == "b0"  # never checked
    store.set_review_task(
        "0" * 64, "tag", status="in_progress", checked_at=9e12, done=3
    )
    assert store.waiting_book_due(600) is None
    assert store.review_task("0" * 64, "tag")["done"] == 3
    assert store.startup_reset() == {"books": 1, "downloads": 1, "urls": 0}
    assert store.book("1" * 64)["status"] == "queued"
    assert store.book("1" * 64)["stage"] == "index"
    assert store.book("0" * 64)["status"] == "waiting"
    assert store.downloads()[0]["status"] == "queued"
