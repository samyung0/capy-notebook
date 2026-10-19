import hashlib
import http.server
import threading

import httpx
import pytest
import scrape
import store
from jsonschema import Draft202012Validator

PUBLIC = "93.184.216.34"


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    """Every test host resolves to one public address unless a test says
    otherwise; robots.txt answers are not cached across tests."""
    monkeypatch.setattr(scrape, "resolve", lambda host, port: [PUBLIC])
    monkeypatch.setattr(scrape, "_robots", {})


def test_subject_schema_accepts_parent_subjects_but_rejects_invented_ids():
    validator = Draft202012Validator(scrape.VERDICT_SCHEMA["properties"]["subject_id"])
    assert validator.is_valid("electrical-engineering")
    assert validator.is_valid("electricity-magnetism")
    assert validator.is_valid(None)
    assert not validator.is_valid("electromagnetics")


@pytest.mark.parametrize(
    ("name", "url", "quote", "ok", "reason"),
    [
        ("CC BY 4.0", "https://x/licence", "Licensed under CC BY 4.0", True, ""),
        ("CC BY-SA 3.0", "https://x", "q", True, ""),
        ("CC BY 3.0 US", "https://x", "q", True, ""),
        ("Creative Commons Attribution 3.0 United States", "https://x", "q", True, ""),
        ("CC BY-NC 3.0 US", "https://x", "q", False, "NonCommercial licence"),
        ("CC BY-ND 3.0 US", "https://x", "q", False, "NoDerivatives licence"),
        ("Free Documentation License (GNU)", "https://x", "q", False, "GFDL licence"),
        (
            "GNU GPL v2",
            "https://x",
            "q",
            False,
            "GNU GPL (outside approved licence policy) licence",
        ),
        (
            "Creative Commons Attribution-ShareAlike 4.0 International",
            "https://x",
            "q",
            True,
            "",
        ),
        ("CC0 1.0", "https://x", "q", True, ""),
        ("Public domain", "https://x", "q", True, ""),
        ("CC BY-NC 4.0", "https://x", "q", False, "NonCommercial licence"),
        ("CC BY-NC-SA 4.0", "https://x", "q", False, "NonCommercial licence"),
        ("CC BY-ND 4.0", "https://x", "q", False, "NoDerivatives licence"),
        ("GFDL 1.3", "https://x", "q", False, "GFDL licence"),
        ("ODbL", "https://x", "q", False, "ODbL licence"),
        (
            "All rights reserved",
            "https://x",
            "q",
            False,
            "unknown licence 'All rights reserved'",
        ),
        (None, "https://x", "q", False, "no licence stated"),
        ("CC BY 4.0", "", "q", False, "no licence evidence URL"),
        ("CC BY 4.0", "https://x", "  ", False, "no licence evidence quote"),
    ],
)
def test_licence_gate(name, url, quote, ok, reason):
    assert scrape.licence_accepted(name, url, quote) == (ok, reason)


def test_worker_failure_retains_cause(monkeypatch, caplog):
    stop = threading.Event()
    monkeypatch.setattr(scrape, "paused", lambda _: False)
    monkeypatch.setattr(
        store, "next_download", lambda _: {"pdf_url": "https://x/book.pdf"}
    )

    def fail(*_):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(scrape, "download_one", fail)
    captured = []

    def finish(*args):
        captured.append(args)
        stop.set()

    monkeypatch.setattr(store, "finish_download", finish)
    scrape.download_worker(stop)
    assert captured[0][3] == "worker error: RuntimeError: database is locked"
    assert "Download worker failed" in caplog.text


def test_gate_accepts_all_classified_levels_but_requires_english():
    verdict = {
        "page_type": "book",
        "subject_id": "physics",
        "licence": {"name": "CC BY 4.0", "url": "u", "evidence_quote": "q"},
        "language": "en",
        "level": "undergraduate",
    }
    for level in ("secondary", "undergraduate", "graduate", "other"):
        assert scrape.gate({**verdict, "level": level}) == (True, "")
    assert scrape.gate({**verdict, "language": "es"}) == (False, "language 'es'")
    assert scrape.gate({**verdict, "level": None}) == (False, "level None")
    assert scrape.gate({**verdict, "licence": None})[1] == "no licence stated"
    assert scrape.gate({**verdict, "relevant": False, "licence": None}) == (
        False,
        "irrelevant",
    )


def test_extract_normalises_and_dedupes_links_and_strips_scripts():
    html = """<html><head><script>var x = "hidden";</script><style>b{}</style></head>
    <body><h1>Physics</h1><a href="/book/1#top">One</a><a href="HTTPS://Example.org/book/1">One again</a>
    <a href="mailto:a@b">mail</a><a href="ftp://example.org/x">ftp</a><a href="http://example.org/plain">other scheme</a>
    <p>Some   text</p><noscript>no</noscript></body></html>"""
    text, links = scrape.extract(html, "https://example.org/subjects")
    assert text == "Physics One One again mail ftp other scheme Some text"
    assert [link["url"] for link in links] == [
        "https://example.org/book/1",
        "http://example.org/plain",
    ]
    assert links[0]["text"] == "One; One again"
    assert scrape.normalise("javascript:void(0)") is None
    assert scrape.is_pdf("https://x/a.PDF", "text/html") and scrape.is_pdf(
        "https://x/dl", "application/pdf; charset=binary"
    )


def test_extract_preserves_format_labels_for_opaque_urls():
    _, links = scrape.extract(
        """
        <a href="/formats/1805" aria-label="Go to host of PDF version"><span>PDF</span></a>
        <a href="/formats/1806" aria-label="Go to host of Hardcopy version" title="Buy printed book">Hardcopy</a>
        <a href="/picture"><img alt="Download PDF" src="icon.png"></a>
    """,
        "https://open.umn.edu/opentextbooks/",
    )
    assert links[0] == {
        "url": "https://open.umn.edu/formats/1805",
        "text": "PDF",
        "aria_label": "Go to host of PDF version",
        "title": "",
    }
    assert links[1]["text"] == "Hardcopy"
    assert links[1]["aria_label"] == "Go to host of Hardcopy version"
    assert links[1]["title"] == "Buy printed book"
    assert links[2]["text"] == "Download PDF"


def fake_client(pages, content_type="text/html"):
    """Serves `pages` by URL; robots.txt is missing everywhere."""

    def handle(request):
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        assert request.headers["accept"] == "text/html"
        return httpx.Response(
            200, content=pages[str(request.url)], headers={"content-type": content_type}
        )

    return httpx.Client(transport=httpx.MockTransport(handle))


def test_scrape_follows_links_within_depth_and_queues_gated_pdfs(monkeypatch):
    pages = {
        "https://a.test/": b"CC BY 4.0 <a href='/next'>n</a><a href='https://b.test/x'>x</a><a href='/book.pdf'>PDF</a>",
        "https://a.test/deep": b"<a href='/more'>m</a>",
    }
    verdict = {
        "relevant": True,
        "page_type": "book",
        "subject_id": "physics",
        "level": "undergraduate",
        "language": "en",
        "licence": {
            "name": "CC BY 4.0",
            "url": "https://creativecommons.org/licenses/by/4.0/",
            "evidence_quote": "CC BY 4.0",
        },
        "pdf_links": [
            {
                "url": "https://a.test/book.pdf",
                "title": "Physics",
                "authors": ["A"],
                "edition": "1st",
            }
        ],
        "follow_links": [
            "https://a.test/next",
            "https://a.test/next",
            "https://b.test/x#frag",
        ],
        "reason": "catalog",
    }
    monkeypatch.setattr(scrape, "judge", lambda url, text, links: verdict)
    client = fake_client(pages)
    store.enqueue_url("https://a.test/")
    scrape.scrape_one(client, store.next_url(0))
    counts = store.url_counts()
    assert {u["url"] for u in counts["pending_head"]} == {
        "https://a.test/next",
        "https://b.test/x",
    }
    assert all(u["depth"] == 1 for u in counts["pending_head"])
    queued = store.downloads()[0]
    assert (
        queued["status"] == "queued"
        and queued["landing_url"] == "https://a.test/"
        and queued["subject_id"] == "physics"
    )
    # depth 4 is the last level fetched: its links are not queued
    store.enqueue_url("https://a.test/deep", depth=4)
    scrape.scrape_one(
        client, {"url": "https://a.test/deep", "depth": 4, "discovered_from": None}
    )
    assert "https://a.test/more" not in {
        u["url"] for u in store.url_counts()["pending_head"]
    }
    # a rejected licence is recorded with its reason
    verdict["licence"] = {"name": "CC BY-NC 4.0", "url": "u", "evidence_quote": "q"}
    verdict["pdf_links"] = [
        {"url": "https://a.test/nc.pdf", "title": "NC", "authors": [], "edition": ""}
    ]
    store.enqueue_url("https://a.test/nc")
    pages["https://a.test/nc"] = b"<p>q</p><a href='/nc.pdf'>PDF</a>"
    scrape.scrape_one(
        client, {"url": "https://a.test/nc", "depth": 0, "discovered_from": None}
    )
    rows = {d["pdf_url"]: d for d in store.downloads()}
    assert rows["https://a.test/nc.pdf"]["status"] == "rejected"
    assert rows["https://a.test/nc.pdf"]["last_error"] == "NonCommercial licence"


def test_direct_pdf_response_cannot_inherit_the_landing_verdict(monkeypatch):
    verdict = {
        "subject_id": "physics",
        "level": "secondary",
        "language": "en",
        "licence": {"name": "CC BY-SA 4.0", "url": "u", "evidence_quote": "q"},
    }
    store.enqueue_url("https://a.test/land")
    store.mark_url("https://a.test/land", "visited", verdict)
    store.enqueue_url(
        "https://a.test/dl", depth=1, discovered_from="https://a.test/land"
    )
    store.enqueue_url("https://a.test/orphan.pdf")

    pdfs = {"https://a.test/dl": b"%PDF", "https://a.test/orphan.pdf": b"%PDF"}
    scrape.scrape_one(fake_client(pdfs, "application/pdf"), store.next_url(0))
    scrape.scrape_one(fake_client(pdfs, "application/pdf"), store.next_url(0))
    rows = {d["pdf_url"]: d for d in store.downloads()}
    assert (
        rows["https://a.test/dl"]["status"] == "rejected"
        and rows["https://a.test/dl"]["licence"] is None
    )
    assert (
        rows["https://a.test/orphan.pdf"]["last_error"]
        == "PDF requires assessment on its book landing page"
    )


def test_catalog_discovers_books_without_poisoning_pdf_dedupe(monkeypatch):
    pdf = "https://a.test/book.pdf"
    book = "https://a.test/book"
    verdict = {
        "page_type": "catalog",
        "subject_id": "physics",
        "language": "en",
        "level": "undergraduate",
        "licence": {
            "name": "CC BY 4.0",
            "url": "https://license.test/",
            "evidence_quote": "CC BY 4.0",
        },
        "pdf_links": [{"url": pdf, "title": "Physics", "authors": ["Author"]}],
        "follow_links": [book, pdf, "https://invented.test/book"],
    }
    html = b"CC BY 4.0 <a href='/book'>Book</a><a href='/book.pdf'>PDF</a>"
    monkeypatch.setattr(scrape, "judge", lambda *args: verdict)
    store.enqueue_url("https://a.test/")
    scrape.scrape_one(fake_client({"https://a.test/": html}), store.next_url(0))
    assert store.downloads() == []
    assert [r["url"] for r in store.url_counts()["pending_head"]] == [book]
    verdict["page_type"] = "book"
    verdict["pdf_links"].append({"url": "https://invented.test/file.pdf"})
    scrape.scrape_one(fake_client({book: html}), store.next_url(0))
    assert [(r["pdf_url"], r["status"]) for r in store.downloads()] == [(pdf, "queued")]


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ({"page_type": "catalog"}, "individual book landing page required"),
        ({"page_type": None}, "individual book landing page required"),
        ({"subject_id": None}, "missing or unknown subject"),
        ({"subject_id": "made-up"}, "missing or unknown subject"),
        ({"language": "zh"}, "language 'zh'"),
        ({"title": " "}, "missing title"),
        (
            {"title": "Some book (Free Courseware)"},
            "Free Courseware in title or filename",
        ),
    ],
)
def test_candidate_requires_individual_book_metadata(change, reason):
    metadata = {
        "page_type": "book",
        "subject_id": "physics",
        "language": "en",
        "level": "undergraduate",
        "title": "Physics",
        "authors": ["Author"],
        "licence": {
            "name": "CC BY 4.0",
            "url": "https://license.test/",
            "evidence_quote": "CC BY 4.0",
        },
        **change,
    }
    scrape.candidate(
        "https://a.test/book.pdf", "https://a.test/book", metadata, metadata
    )
    assert store.downloads()[0]["last_error"] == reason


def test_missing_authors_can_download_and_courseware_cannot():
    metadata = {
        "page_type": "book",
        "title": "Physics",
        "authors": [],
        "subject_id": "physics",
        "language": "en",
        "level": "undergraduate",
        "licence": {
            "name": "CC BY 4.0",
            "url": "https://license.test/",
            "evidence_quote": "CC BY 4.0",
        },
    }
    scrape.candidate(
        "https://a.test/book.pdf", "https://a.test/book", metadata, metadata
    )
    row = store.downloads()[0]
    assert row["status"] == "queued" and row["authors"] == []
    for filename in [
        "Free%20Courseware.pdf",
        "book_Free_Courseware.pdf",
        "Free-Courseware.pdf",
    ]:
        scrape.candidate(
            "https://a.test/" + filename, "https://a.test/book", metadata, metadata
        )
    assert sum(r["status"] == "rejected" for r in store.downloads()) == 3
    assert not scrape.excluded_title_or_filename("Free textbook", "courseware.pdf")


def test_queued_courseware_is_rejected_without_fetching():
    url = "https://a.test/book.pdf"
    store.add_download({"pdf_url": url, "title": "Free Courseware: Physics"}, "queued")
    scrape.download_one(None, store.next_download(0))
    assert store.downloads()[0]["status"] == "rejected"


def test_book_licence_quote_must_be_on_fetched_page(monkeypatch):
    verdict = {
        "page_type": "book",
        "subject_id": "physics",
        "language": "en",
        "level": "undergraduate",
        "licence": {
            "name": "CC BY 4.0",
            "url": "https://license.test/",
            "evidence_quote": "invented quote",
        },
        "pdf_links": [
            {
                "url": "https://a.test/book.pdf",
                "title": "Physics",
                "authors": ["Author"],
            }
        ],
    }
    monkeypatch.setattr(scrape, "judge", lambda *args: verdict)
    store.enqueue_url("https://a.test/")
    scrape.scrape_one(
        fake_client({"https://a.test/": b"<a href='/book.pdf'>PDF</a>"}),
        store.next_url(0),
    )
    assert store.downloads()[0]["status"] == "rejected"


def test_pending_pagination_uses_shortest_discovered_route():
    url = "https://a.test/books?page=5"
    assert store.enqueue_url(url, depth=4)
    assert not store.enqueue_url(
        url, depth=2, discovered_from="https://a.test/books?page=4"
    )
    row = store.next_url(0)
    assert row["depth"] == 2
    assert row["discovered_from"] == "https://a.test/books?page=4"


def test_catalog_pagination_keeps_depth_and_only_same_catalog(monkeypatch):
    url = "https://a.test/books?page=4"
    html = b"""<a rel='next' href='?page=5'>Next</a>
    <a rel='next' href='https://b.test/books?page=5'>Other host</a>
    <a rel='next' href='/unrelated?page=5'>Other path</a>
    <a href='/book'>Book</a>"""
    monkeypatch.setattr(
        scrape,
        "judge",
        lambda *args: {"page_type": "catalog", "follow_links": ["https://a.test/book"]},
    )
    store.enqueue_url(url, depth=4)
    scrape.scrape_one(fake_client({url: html}), store.next_url(0))
    assert [(r["url"], r["depth"]) for r in store.url_counts()["pending_head"]] == [
        ("https://a.test/books?page=5", 4)
    ]


@pytest.fixture
def server(tmp_path):
    files = {
        "/one.pdf": b"%PDF-1.4 one",
        "/same.pdf": b"%PDF-1.4 one",
        "/page.html": b"<html>",
        "/flaky.pdf": b"%PDF-1.4 flaky",
    }
    hits = {"flaky": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/flaky.pdf":
                hits["flaky"] += 1
                if hits["flaky"] == 1:
                    self.send_error(503)
                    return
            body = files.get(self.path)
            if body is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header(
                "Content-Type",
                "application/pdf" if self.path.endswith(".pdf") else "text/html",
            )
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}", hits
    httpd.shutdown()


def test_download_hashes_dedupes_and_retries(server, monkeypatch):
    base, hits = server
    monkeypatch.setattr(scrape, "BACKOFF", (0, 0, 0))
    monkeypatch.setattr(scrape, "page_count", lambda path: 7)
    for name in ("one", "same", "page", "flaky"):
        store.add_download(
            {
                "pdf_url": f"{base}/{name}.pdf"
                if name != "page"
                else f"{base}/page.html",
                "title": name,
            },
            "queued",
        )
    with httpx.Client() as client:
        for _ in range(4):
            scrape.download_one(client, store.next_download(0))
    rows = {d["title"]: d for d in store.downloads()}
    sha = hashlib.sha256(b"%PDF-1.4 one").hexdigest()
    assert (
        rows["one"]["status"] == "downloaded"
        and rows["one"]["sha256"] == sha
        and rows["one"]["pages"] == 7
    )
    assert (store.SOURCES / f"{sha}.pdf").read_bytes() == b"%PDF-1.4 one"
    assert rows["same"]["status"] == "rejected" and rows["one"]["duplicate_urls"] == [
        f"{base}/same.pdf"
    ]
    assert (
        rows["page"]["status"] == "failed"
        and rows["page"]["last_error"] == "not a PDF"
        and rows["page"]["attempts"] == 1
    )
    assert (
        rows["flaky"]["status"] == "downloaded"
        and rows["flaky"]["attempts"] == 2
        and hits["flaky"] == 2
    )
    assert not list(store.SOURCES.glob(".*.part"))


def test_download_respects_robots_the_cap_and_a_corrupt_pdf(server, monkeypatch):
    base, _ = server
    monkeypatch.setattr(scrape, "BACKOFF", (0, 0, 0))
    monkeypatch.setattr(
        scrape, "robots_allowed", lambda client, url: not url.endswith("/one.pdf")
    )

    def corrupt(path):
        raise RuntimeError("cannot open broken document")

    monkeypatch.setattr(scrape, "page_count", corrupt)
    store.add_download({"pdf_url": f"{base}/one.pdf", "title": "one"}, "queued")
    store.add_download({"pdf_url": f"{base}/flaky.pdf", "title": "flaky"}, "queued")
    with httpx.Client() as client:
        scrape.download_one(client, store.next_download(0))
        scrape.download_one(client, store.next_download(0))
    rows = {d["title"]: d for d in store.downloads()}
    assert rows["one"]["status"] == "rejected"
    assert rows["one"]["last_error"] == "robots.txt disallows"
    assert rows["flaky"]["status"] == "failed"
    assert rows["flaky"]["last_error"] == "unreadable PDF: RuntimeError"
    assert not list(store.SOURCES.glob("*.pdf"))
    monkeypatch.setattr(scrape, "PDF_CAP", 8)
    store.add_download({"pdf_url": f"{base}/same.pdf", "title": "same"}, "queued")
    with httpx.Client() as client:
        scrape.download_one(client, store.next_download(0))
    same = {d["title"]: d for d in store.downloads()}["same"]
    assert same["status"] == "failed" and same["last_error"] == "pdf over 200 MB"
    assert not list(store.SOURCES.glob(".*.part"))


# --- redirects and addresses (security regression: builder scraper redirects) --


@pytest.mark.parametrize(
    ("address", "allowed"),
    [
        (PUBLIC, True),
        ("2606:4700:4700::1111", True),
        ("10.0.0.5", False),
        ("127.0.0.1", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),
        ("224.0.0.1", False),
        ("240.0.0.1", False),
        ("0.0.0.0", False),
        ("::1", False),
        ("fe80::1", False),
        ("fc00::1", False),
        ("fec0::1", False),
        ("ff02::1", False),
        ("::ffff:10.0.0.5", False),
        ("::ffff:127.0.0.1", False),
    ],
)
def test_only_public_addresses_pass(address, allowed):
    assert scrape.public(address) is allowed


def redirects(chain, monkeypatch, addresses):
    """A client where each URL of `chain` redirects to the next and the last
    serves a page or a PDF; `addresses` is the stubbed DNS. Returns the client
    and the URLs it actually requested."""
    monkeypatch.setattr(
        scrape, "resolve", lambda host, port: addresses.get(host, [host])
    )
    sent = []

    def handle(request):
        url = str(request.url)
        if request.url.path == "/robots.txt":
            return httpx.Response(404)
        sent.append(url)
        i = chain.index(url)
        if i + 1 < len(chain):
            return httpx.Response(302, headers={"location": chain[i + 1]})
        pdf = url.endswith(".pdf")
        return httpx.Response(
            200,
            content=b"%PDF-1.4 x" if pdf else b"<p>CC BY 4.0</p>",
            headers={"content-type": "application/pdf" if pdf else "text/html"},
        )

    return httpx.Client(transport=httpx.MockTransport(handle)), sent


DNS = {"a.test": [PUBLIC], "b.test": ["2606:4700:4700::1111"]}


@pytest.mark.parametrize(
    "target",
    [
        "http://intranet.test/admin",  # a name resolving privately
        "http://169.254.169.254/latest/meta-data/",  # a literal link-local address
        "http://[::ffff:127.0.0.1]:8080/",  # loopback behind an IPv4-mapped address
        "http://split.test/",  # one public and one private record
        "http://xn--fa-hia.test/",  # checked as the ASCII host it connects to
    ],
)
def test_a_page_redirect_to_a_private_address_is_never_sent(monkeypatch, target):
    dns = {
        **DNS,
        "intranet.test": ["10.0.0.5"],
        "split.test": [PUBLIC, "192.168.1.1"],
        "xn--fa-hia.test": ["127.0.0.1"],
        "fass.test": [PUBLIC],
    }
    client, sent = redirects(["https://a.test/start", target], monkeypatch, dns)
    store.enqueue_url("https://a.test/start")
    scrape.scrape_one(client, store.next_url(0))
    assert sent == ["https://a.test/start"]
    assert store.url_verdict("https://a.test/start")["reason"].startswith(
        "Refused: refused "
    )


def test_a_pdf_redirect_to_a_private_address_fails_without_a_retry(monkeypatch):
    chain = ["https://a.test/book.pdf", "http://127.0.0.1:8080/book.pdf"]
    client, sent = redirects(chain, monkeypatch, DNS)
    store.add_download({"pdf_url": chain[0], "title": "Book"}, "queued")
    scrape.download_one(client, store.next_download(0))
    row = store.downloads()[0]
    assert sent == [chain[0]] and row["status"] == "failed" and row["attempts"] == 1
    assert row["last_error"] == "refused 127.0.0.1: resolves to 127.0.0.1"
    assert not list(store.SOURCES.glob("*.pdf"))


def test_a_public_redirect_chain_is_followed_up_to_five_hops(monkeypatch):
    chain = [
        "https://a.test/book",
        "https://b.test/mirror",
        "https://a.test/landing",
    ]
    client, sent = redirects(chain, monkeypatch, DNS)
    assert scrape.fetch_html(client, chain[0])[0] == chain[-1] and sent == chain
    pdfs = [f"https://a.test/{i}.pdf" for i in range(6)]
    client, sent = redirects(pdfs, monkeypatch, DNS)
    monkeypatch.setattr(scrape, "page_count", lambda path: 1)
    store.add_download({"pdf_url": pdfs[0], "title": "Book"}, "queued")
    scrape.download_one(client, store.next_download(0))
    assert store.downloads()[0]["status"] == "downloaded" and sent == pdfs
    client, sent = redirects([*pdfs, "https://a.test/6.pdf"], monkeypatch, DNS)
    with pytest.raises(scrape.Refused, match="more than 5 redirects"):
        scrape.fetch_html(client, pdfs[0])
    assert len(sent) == 6
