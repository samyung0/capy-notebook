"""Transcribe stage: one Qwen3.8-Flash request per page image, then chunk
recovery by alignment and figure descriptions.

Every page a chunk touches is rendered once (PyMuPDF, zoom 1.4, JPEG 82) under
<run>/pages/ and sent as one request (the developer's page prompt, thinking
off, temperature 0) returning `text` (the transcription) and `figures` (printed
label plus what each figure visibly shows). Batch by default: page images go to
the knowledge-base bucket as `pages/<sha256>/<page>.jpg`, presigned for 7 days,
one JSONL line per page (`<book>:p<page>`) as one Alibaba Batch task; the task
id lands in `review_tasks` and the command exits 3 while it is in flight. Pages
without an answer after collection get one live call; `--live` sends every
page live (four in flight, one retry pass). Each answer is saved as
<run>/pages/<page>.json.

Alignment: a chunk's original words are matched against the transcription of
its pages (concatenated for a page-spanning chunk) in blocks of three or more
words; coverage is matched words over original words. The span from the first
to the last block replaces the chunk text when coverage is at least 0.9 and the
span's length is within 0.7x-2.5x of the original, under a `recovery` receipt
(method align); otherwise the chunk is held for the dashboard with the reason,
coverage, ratio and the transcription. Chunks under 12 words with no match are
skipped as `unaligned_short`. Every run reverts and re-aligns from the saved
transcriptions, so a rule change reaches every chunk without a new batch;
decided held items keep their decision. `--redo` also discards the
transcriptions and the ledger and submits a new task.

Figures: each returned figure is matched to the corpus figures on its page by
printed label, else by order; the description is written to the figure and
appended as "[Figure <label>] <description>" to the `indexed_text` of the first
chunk of the excerpt that lists the figure (never to `text`), unless the figure
is decorative.

  python lab/knowledge/transcribe.py --run <run_dir> --book <id> [--live] [--redo]
"""

from __future__ import annotations

import argparse
import base64
import difflib
import re
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from jsonschema import Draft202012Validator

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batches
import llm
import store
from batches import WAITING, out
from knowledge_base_batch import TERMINAL, PilotError, read_json, save_json

STAGE = "transcribe"
ZOOM = 1.4
JPEG_QUALITY = 82
PRESIGN_SECONDS = 7 * 24 * 3600
UPLOAD_WORKERS = 8
COVERAGE = 0.9
RATIO = (0.7, 2.5)
MIN_BLOCK = 3
SLACK = 3
SHORT_WORDS = 12
WORD = re.compile(r"\w+")
FIGURE_LABEL = re.compile(r"\bfig(?:ure)?\.?\s*(\d+(?:\.\d+)*)", re.IGNORECASE)
# A literal backslash-n the model escaped inside the JSON string, unless it
# starts one of the LaTeX commands a physics page can carry.
LATEX_N = (
    "abla|atural|e|eq|g|geq|gtr|leq|less|mid|ot|otin|parallel|sim|u|earrow|warrow|"
    "ewline|onumber|olimits|ormalsize|obreak|eg|i|subseteq|supseteq|vdash"
)
ESCAPED_NEWLINE = re.compile(rf"\\n(?!(?:{LATEX_N})\b)")
# The developer's page-description prompt, verbatim, plus the output shape.
PROMPT = (
    "Describe this page from a study document so a student's search can find the information it "
    "carries. Extract all visible raw facts such as text, tables, formulas, data, labels, etc. Do not "
    "caption any images. Do not add any text that is not visible in the page or depicted in the images. "
    "Do not duplicate information. Do not add any unnecessary summary, title, line breaks, the response "
    "is processed automatically by a RAG pipeline."
    '\n\nReturn JSON {"text": <the transcription>, "figures": [{"label": <printed figure label or '
    'empty>, "description": <what the figure visibly shows: data, axes, labels, values; no '
    "interpretation>}]}."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "figures": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["label", "description"],
            },
        },
    },
    "required": ["text", "figures"],
}
VALIDATOR = Draft202012Validator(SCHEMA)


# --- pages --------------------------------------------------------------------


def pages_of(corpus: dict) -> list[int]:
    return sorted(
        {p for c in corpus["chunks"] for p in range(c["page_start"], c["page_end"] + 1)}
    )


def custom_id(book_id: str, page: int) -> str:
    return f"{book_id}:p{page}"


def page_of(cid: str) -> int:
    return int(cid.rsplit(":p", 1)[1])


def messages(url: str) -> list[dict]:
    return [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": url}},
            ],
        }
    ]


def render_pages(pdf: Path, pages_dir: Path, pages: list[int]) -> int:
    """<pages_dir>/<page>.jpg for every page not rendered yet; how many."""
    missing = [p for p in pages if not (pages_dir / f"{p}.jpg").exists()]
    if not missing:
        return 0
    import pymupdf

    pages_dir.mkdir(parents=True, exist_ok=True)
    with pymupdf.open(pdf) as doc:
        for page in missing:
            pix = doc[page - 1].get_pixmap(
                matrix=pymupdf.Matrix(ZOOM, ZOOM), alpha=False
            )
            (pages_dir / f"{page}.jpg").write_bytes(
                pix.tobytes("jpeg", jpg_quality=JPEG_QUALITY)
            )
    return len(missing)


def data_url(pages_dir: Path, page: int) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(
        (pages_dir / f"{page}.jpg").read_bytes()
    ).decode("ascii")


def upload_pages(pages_dir: Path, sha256: str, pages: list[int]) -> dict[int, str]:
    """pages/<sha256>/<page>.jpg in the knowledge-base bucket (keys the bucket
    already holds are kept) and a 7-day GET URL per page."""
    from pipeline.config import cfg
    from pipeline.store import blobstore

    client, bucket = blobstore.library_client(), cfg.knowledge_base_b2_bucket
    prefix = f"pages/{sha256}/"
    held = {
        obj["Key"]
        for page in client.get_paginator("list_objects_v2").paginate(
            Bucket=bucket, Prefix=prefix
        )
        for obj in page.get("Contents", [])
    }

    def put(page: int) -> tuple[int, str]:
        key = f"{prefix}{page}.jpg"
        if key not in held:
            client.upload_file(
                str(pages_dir / f"{page}.jpg"),
                bucket,
                key,
                ExtraArgs={"ContentType": "image/jpeg"},
            )
        return page, blobstore.library_presign_get(key, PRESIGN_SECONDS)

    with ThreadPoolExecutor(UPLOAD_WORKERS) as pool:
        return dict(pool.map(put, pages))


def save_page(pages_dir: Path, page: int, record: dict) -> bool:
    """<pages_dir>/<page>.json from a schema-valid answer; False otherwise."""
    if not VALIDATOR.is_valid(record["value"]):
        return False
    value = record["value"]
    text, escaped = ESCAPED_NEWLINE.subn("\n", value["text"])
    save_json(
        pages_dir / f"{page}.json",
        {
            "text": text,
            "figures": value["figures"],
            "escaped_newlines": escaped,
            **{
                k: record.get(k)
                for k in ("model", "endpoint", "request_id", "usage", "source")
            },
            "at": record.get("at") or time.time(),
        },
    )
    return True


def transcriptions(pages_dir: Path, pages: list[int]) -> dict[int, dict]:
    return {
        p: read_json(pages_dir / f"{p}.json")
        for p in pages
        if (pages_dir / f"{p}.json").exists()
    }


# --- alignment ----------------------------------------------------------------


def tight(prev, nxt) -> bool:
    """The page gap between two matching blocks is at most the original's gap
    plus a few restored tokens (a number, a unit)."""
    return nxt.b - (prev.b + prev.size) <= nxt.a - (prev.a + prev.size) + SLACK


def align(original: str, page: str) -> tuple[str, float]:
    """The span of the page transcription the chunk's words align to, and the
    share of the original words matched: longest matching blocks between the
    two word sequences, anchored by blocks of three or more words and extended
    over shorter blocks that follow or precede within a tight gap (a chunk's
    tail "a. Fnet = 1 b. Fnet = 0" matches two words at a time)."""
    ow, pw = WORD.findall(original.casefold()), WORD.findall(page.casefold())
    matcher = difflib.SequenceMatcher(None, ow, pw, autojunk=False)
    blocks = [b for b in matcher.get_matching_blocks() if b.size]
    anchors = [i for i, b in enumerate(blocks) if b.size >= MIN_BLOCK]
    if not anchors:
        return "", 0.0
    lo, hi = anchors[0], anchors[-1]
    while hi + 1 < len(blocks) and tight(blocks[hi], blocks[hi + 1]):
        hi += 1
    while lo > 0 and tight(blocks[lo - 1], blocks[lo]):
        lo -= 1
    used = blocks[lo : hi + 1]
    coverage = sum(b.size for b in used) / max(1, len(ow))
    positions = [m.span() for m in WORD.finditer(page)]
    start, end = used[0].b, used[-1].b + used[-1].size
    s, e = positions[start][0], positions[end - 1][1]
    # Out to the whitespace on both sides, so a closing "." or "**" and an
    # opening "(" or "$" stay with the words they wrap.
    while s > 0 and not page[s - 1].isspace():
        s -= 1
    while e < len(page) and not page[e].isspace():
        e += 1
    return page[s:e], coverage


def judge(original: str, page: str) -> dict:
    """Alignment verdict for one chunk: `apply`, `hold` (with reason) or
    `short` (a fragment under 12 words with nothing matched)."""
    span, coverage = align(original, page)
    ratio = len(span) / max(len(original), 1)
    verdict = {"span": span, "coverage": round(coverage, 3), "ratio": round(ratio, 2)}
    if coverage == 0 and len(WORD.findall(original)) < SHORT_WORDS:
        return {**verdict, "outcome": "short"}
    if coverage < COVERAGE:
        return {
            **verdict,
            "outcome": "hold",
            "reason": f"coverage {coverage:.2f} below {COVERAGE}",
        }
    if not RATIO[0] <= ratio <= RATIO[1]:
        return {
            **verdict,
            "outcome": "hold",
            "reason": f"length ratio {ratio:.2f} outside {RATIO[0]}-{RATIO[1]}",
        }
    return {**verdict, "outcome": "apply"}


# --- figures ------------------------------------------------------------------


def label_number(text: str) -> str | None:
    found = FIGURE_LABEL.search(text or "")
    return found.group(1) if found else None


def match_figures(returned: list[dict], figures: list[dict]) -> list[tuple[dict, dict]]:
    """Pairs (corpus figure, returned figure) for one page: by printed label
    where both sides carry one, the rest by order.
    ponytail: order pairing misassigns when the model describes an image the
    parser excluded; match by bbox if a book shows that."""
    pairs, spare_r, spare_c = [], list(returned), list(figures)
    for r in returned:
        number = label_number(r["label"])
        match = next(
            (
                c
                for c in spare_c
                if number and label_number(" ".join(c["original_caption"])) == number
            ),
            None,
        )
        if match is not None:
            pairs.append((match, r))
            spare_r.remove(r)
            spare_c.remove(match)
    return pairs + list(zip(spare_c, spare_r))


def describe_figures(corpus: dict, texts: dict[int, dict]) -> int:
    """Descriptions from the page answers onto the corpus figures; how many."""
    for figure in corpus["figures"]:
        figure.pop("description", None)
        figure.pop("label", None)
    described = 0
    for page, record in texts.items():
        on_page = sorted(
            (f for f in corpus["figures"] if f["page"] == page and not f["excluded"]),
            key=lambda f: f["block_index"],
        )
        for figure, returned in match_figures(record["figures"], on_page):
            if returned["description"].strip():
                figure["description"] = returned["description"].strip()
                figure["label"] = returned["label"].strip()
                described += 1
    return described


def figure_note(figure: dict) -> str:
    label = f" {figure['label']}" if figure.get("label") else ""
    return f"[Figure{label}] {figure['description']}"


def rebuild_indexed_text(corpus: dict) -> None:
    """section_path + text, plus the notes of the described figures the
    chunk's excerpt lists first (on the excerpt's first chunk); decorative
    figures add none, excluded ones keep theirs."""
    notes: dict[str, list[str]] = {}
    described = {
        f["id"]: f
        for f in corpus["figures"]
        if f.get("description") and not f.get("decorative")
    }
    seen = set()
    for excerpt in corpus["excerpts"]:
        for figure_id in excerpt["figure_ids"]:
            if (
                figure_id in described
                and figure_id not in seen
                and excerpt["chunk_ids"]
            ):
                seen.add(figure_id)
                notes.setdefault(excerpt["chunk_ids"][0], []).append(
                    figure_note(described[figure_id])
                )
    for chunk in corpus["chunks"]:
        base = (
            f"{chunk['section_path']}\n\n{chunk['text']}"
            if chunk["section_path"]
            else chunk["text"]
        )
        chunk["indexed_text"] = base + "".join(
            f"\n\n{n}" for n in notes.get(chunk["id"], [])
        )


# --- corpus -------------------------------------------------------------------


def replace(chunk: dict, text: str, receipt: dict) -> None:
    chunk["recovery"] = {"original_text": chunk["text"], "method": "align", **receipt}
    chunk["text"] = text


def revert(chunks: list[dict]) -> int:
    reverted = 0
    for chunk in chunks:
        if "recovery" in chunk:
            chunk["text"] = chunk.pop("recovery")["original_text"]
            reverted += 1
    return reverted


def refresh(corpus: dict) -> None:
    """Excerpt texts, indexed texts and the content hash follow the chunks."""
    from pipeline.retrieval.chunking import Chunk, Region
    from pipeline.retrieval.indexing import content_hash

    rebuild_indexed_text(corpus)
    by_id = {c["id"]: c for c in corpus["chunks"]}
    for excerpt in corpus["excerpts"]:
        excerpt["text"] = "\n\n".join(by_id[i]["text"] for i in excerpt["chunk_ids"])
    corpus["content_hash"] = content_hash(
        [
            Chunk(
                text=c["text"],
                section_path=c["section_path"],
                page_start=c["page_start"],
                page_end=c["page_end"],
                regions=[Region(r["page"], r["bbox"]) for r in c["regions"]],
                reference=c["reference"],
                confidence=c["confidence"],
                confidence_reasons=c["confidence_reasons"],
            )
            for c in corpus["chunks"]
        ]
    )


# --- held ledger --------------------------------------------------------------


def ledger_path(run_dir: Path) -> Path:
    return run_dir / "transcribe.json"


def ledger(run_dir: Path) -> dict:
    path = ledger_path(run_dir)
    return read_json(path) if path.exists() else {"held": []}


def undecided(run_dir: Path) -> list[dict]:
    return [h for h in ledger(run_dir)["held"] if h["decision"] is None]


def decide(run_dir: Path, book_id: str, chunk_id: str, accept: bool) -> dict:
    """The dashboard's verdict on a held chunk: accept applies its aligned
    span under the held receipt, reject only records it."""
    book_ledger = ledger(run_dir)
    item = next((h for h in book_ledger["held"] if h["chunk_id"] == chunk_id), None)
    if item is None:
        raise ValueError(f"no held item for {chunk_id}")
    if item["decision"]:
        raise ValueError(f"{chunk_id} was already {item['decision']}")
    if accept:
        if not item["aligned_text"].strip():
            raise ValueError(f"{chunk_id} aligned to nothing; only reject applies")
        corpus_path = run_dir / "books" / book_id / "corpus.json"
        corpus = read_json(corpus_path)
        chunk = next(c for c in corpus["chunks"] if c["id"] == chunk_id)
        replace(chunk, item["aligned_text"], receipt(item))
        refresh(corpus)
        save_json(corpus_path, corpus)
    item.update(decision="accepted" if accept else "rejected", decided_at=time.time())
    save_json(ledger_path(run_dir), book_ledger)
    return item


def receipt(item: dict) -> dict:
    return {
        **{k: item[k] for k in ("coverage", "ratio", "model", "request_id")},
        "at": time.time(),
    }


# --- apply --------------------------------------------------------------------


def apply(corpus: dict, texts: dict[int, dict], held: list[dict]) -> dict:
    """Revert every chunk, then re-apply accepted held items and align the
    rest from the transcriptions; new held items are appended to `held`
    (which holds the decided ones on entry)."""
    revert(corpus["chunks"])
    decided = {h["chunk_id"]: h for h in held}
    report = {
        "aligned": 0,
        "changed": 0,
        "held": [],
        "unaligned_short": [],
        "untranscribed": [],
        "accepted": 0,
        "rejected": 0,
    }
    for chunk in corpus["chunks"]:
        pages = list(range(chunk["page_start"], chunk["page_end"] + 1))
        item = decided.get(chunk["id"])
        if item is not None:
            report[item["decision"]] += 1
            if item["decision"] == "accepted":
                replace(chunk, item["aligned_text"], receipt(item))
            continue
        if any(p not in texts for p in pages):
            report["untranscribed"].append(chunk["id"])
            continue
        transcription = "\n".join(texts[p]["text"] for p in pages)
        verdict = judge(chunk["text"], transcription)
        first = texts[chunk["page_start"]]
        if verdict["outcome"] == "short":
            report["unaligned_short"].append(chunk["id"])
        elif verdict["outcome"] == "hold":
            entry = {
                "chunk_id": chunk["id"],
                "page": chunk["page_start"],
                "pages": pages,
                "reason": verdict["reason"],
                "coverage": verdict["coverage"],
                "ratio": verdict["ratio"],
                "original_text": chunk["text"],
                "aligned_text": verdict["span"],
                "transcription": transcription,
                "model": first["model"],
                "request_id": first["request_id"],
                "at": time.time(),
                "decision": None,
                "decided_at": None,
            }
            held.append(entry)
            report["held"].append(entry)
        else:
            report["aligned"] += 1
            if verdict["span"] != chunk["text"]:
                report["changed"] += 1
                replace(
                    chunk,
                    verdict["span"],
                    {
                        "coverage": verdict["coverage"],
                        "ratio": verdict["ratio"],
                        "model": first["model"],
                        "request_id": first["request_id"],
                        "at": time.time(),
                    },
                )
    return report


# --- stage --------------------------------------------------------------------


def run(run_dir: Path, book_id: str, *, live: bool = False, redo: bool = False) -> int:
    started = time.time()
    manifest = read_json(run_dir / "manifest.json")
    book = next(b for b in manifest["books"] if b["id"] == book_id)
    pdf = Path(book["pdf_path"])
    if not pdf.is_absolute():
        pdf = store.REPO / pdf
    corpus_path = run_dir / "books" / book_id / "corpus.json"
    corpus = read_json(corpus_path)
    directory = run_dir / "models" / STAGE
    pages_dir = run_dir / "pages"
    pages = pages_of(corpus)
    book_ledger = ledger(run_dir)
    if redo:
        batches.archive(run_dir, STAGE, int(started))
        for page in pages:
            (pages_dir / f"{page}.json").unlink(missing_ok=True)
        book_ledger["held"] = []
        save_json(ledger_path(run_dir), book_ledger)
        reverted = revert(corpus["chunks"])
        describe_figures(corpus, {})
        refresh(corpus)
        save_json(corpus_path, corpus)
        out({"redo": True, "reverted": reverted})
    # Model directories of stages this round replaced (review, tags,
    # recovery) leave the loader's model-run walk.
    if (run_dir / "models").exists():
        for stale in list((run_dir / "models").iterdir()):
            if stale.is_dir() and stale.name not in (STAGE, "tag"):
                batches.archive(run_dir, stale.name, int(started))
    out({"pages": len(pages), "pages_rendered": render_pages(pdf, pages_dir, pages)})

    state_path = directory / "state.json"
    state = read_json(state_path) if state_path.exists() else None
    if state and state.get("batch_id") and live:
        raise PilotError(
            f"{STAGE}: a batch task is open; collect it or --redo before --live"
        )
    live = live or bool(state and state.get("transport") == "live")
    if live:
        if state is None:
            state = {
                "transport": "live",
                "model": llm.ALIBABA_MODEL,
                "request_ids": [custom_id(book_id, p) for p in pages],
                "status": "running",
            }
            save_json(state_path, state)
    else:
        if state is None or not state.get("batch_id"):
            urls = upload_pages(pages_dir, book["sha256"], pages)
            out({"uploaded_pages": len(urls)})
            rows = [
                batches.row(
                    custom_id(book_id, p), messages(urls[p]), SCHEMA, thinking=False
                )
                for p in pages
            ]
            state = batches.submit(directory, rows, book, STAGE)
            out({"batch": state["batch_id"], "status": state["status"]})
            return WAITING
        state = batches.collect(directory, book, STAGE)
        if state["status"] not in TERMINAL:
            out({"batch": state["batch_id"], "status": state["status"]})
            return WAITING
        for cid, record in batches.answers(directory).items():
            page = page_of(cid)
            if not (pages_dir / f"{page}.json").exists():
                save_page(pages_dir, page, record)

    # Pages still without a transcription get one live pass (two on the live
    # path: the send and its retry).
    sent, live_calls = 0, 0
    for _ in range(2 if live else 1):
        pending = [p for p in pages if not (pages_dir / f"{p}.json").exists()]
        if not pending:
            break
        out({"live_pass": len(pending)})
        for cid, record, error in batches.live(
            [
                (custom_id(book_id, p), messages(data_url(pages_dir, p)))
                for p in pending
            ],
            SCHEMA,
            stage=STAGE,
            sha256=book["sha256"],
        ):
            live_calls += 1
            saved = bool(record) and save_page(pages_dir, page_of(cid), record)
            out({"page": cid, "live": "ok" if saved else "failed", "error": error})
        sent += len(pending)
    texts = transcriptions(pages_dir, pages)

    # Undecided items are judged again by this run's rules; decided ones stay.
    book_ledger["held"] = [h for h in book_ledger["held"] if h["decision"]]
    report = apply(corpus, texts, book_ledger["held"])
    described = describe_figures(corpus, texts)
    refresh(corpus)
    save_json(corpus_path, corpus)
    save_json(ledger_path(run_dir), book_ledger)

    usage = Counter()
    for record in texts.values():
        usage.update(batches.tokens(record["usage"]))
    state.update(
        transport="live" if live else "batch",
        model=llm.ALIBABA_MODEL,
        collection={
            "success": len(texts),
            "failed": len(pages) - len(texts),
            "missing": 0,
        },
        normal_requests=live_calls,
        usage=dict(usage),
        complete=len(texts) == len(pages),
    )
    save_json(state_path, state)

    summary = {
        "at": started,
        "transport": state["transport"],
        "batch_id": state.get("batch_id"),
        "pages": len(pages),
        "pages_transcribed": len(texts),
        "pages_sent_live": sent,
        "pages_failed": [p for p in pages if p not in texts],
        "escaped_newlines": sum(1 for t in texts.values() if t.get("escaped_newlines")),
        "chunks": len(corpus["chunks"]),
        "aligned": report["aligned"],
        "changed": report["changed"],
        "held": len(report["held"]),
        "held_total": len(book_ledger["held"]),
        "accepted": report["accepted"],
        "rejected": report["rejected"],
        "unaligned_short": len(report["unaligned_short"]),
        "untranscribed": len(report["untranscribed"]),
        "figures": len(corpus["figures"]),
        "figures_described": described,
        "usage": dict(usage),
        "seconds": round(time.time() - started, 1),
    }
    save_json(
        run_dir / f"{STAGE}-{batches.stamp(started)}.json",
        {
            **summary,
            "held_items": [h["chunk_id"] for h in report["held"]],
            "unaligned_short_ids": report["unaligned_short"],
            "untranscribed_ids": report["untranscribed"],
        },
    )
    out(summary)
    if report["untranscribed"]:
        print(
            f"{len(summary['pages_failed'])} pages without a transcription after the live retry "
            f"({len(report['untranscribed'])} chunks); retry the stage",
            file=sys.stderr,
            flush=True,
        )
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--book", required=True)
    parser.add_argument("--live", action="store_true", help="send every page live")
    parser.add_argument(
        "--redo",
        action="store_true",
        help="discard transcriptions, corrections and the ledger, then start over",
    )
    args = parser.parse_args()
    batches.load_env()
    store.init()
    try:
        code = run(args.run, args.book, live=args.live, redo=args.redo)
    except (PilotError, llm.LLMError) as exc:
        print(str(exc), file=sys.stderr)
        code = 2
    sys.exit(code)


if __name__ == "__main__":
    main()
