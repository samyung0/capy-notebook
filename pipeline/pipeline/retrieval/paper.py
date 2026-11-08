"""Marking an uploaded answer paper (todo-file-submissions.md M and 5a).

One read call (R) finds each part's pages and the closed parts' answers on
every page at 1,024 px; then open and drawing parts are graded four to a call
(SYSTEM_PROMPT + DRAWN_SECTION + P1 + B) on the union of their pages at
1,568 px. Go marks the closed answers against the key and computes marks.

R, P1 and B are approved by Epo word for word (2026-11-08, benched in
bench/grading/reports/2026-11-08-paper-prompts.md); change them only with Epo.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from .. import elitellm
from ..registry import ModelConfig
from . import accounting, capture, extraction, grading, limits, models, store

log = logging.getLogger("capy.retrieval.paper")

R = """You see every page of one student's answer paper, in order, then the list of question parts. For each part give:
- "pages": the pages where the student answers it, in order. Answers may run over several pages or come out of order; a part the student did not answer gets [].
- "answer": the student's final answer, in the shape its type asks for below. Leave it out for open and drawing parts, and when the part is unanswered or you cannot read it.
  - choice: the letters the student marked, such as ["B"] or ["A", "D"]. A crossed-out or erased mark does not count.
  - true/false: true or false.
  - short: the final answer as written.
  - gaps: one entry per numbered gap, in order; "" for a gap left empty.
  - matching: each numbered item's letter, such as {"1": "C", "2": "A"}.
  - ordering: the item letters in the order the student puts them.
Copy what the student wrote; never correct it. Reply with JSON only, such as {"parts": [{"part": "1a", "pages": [1], "answer": ["B"]}]}."""

P1 = """

Page answers: when the student's answer comes as page images instead of <student_answer> text, the pages are the student's written work and everything above applies to them.
- The pages may hold answers to other questions or parts; mark only the answer to the part in <question>.
- Read handwriting as written; anything you cannot read earns nothing.
- "quote" copies, in at most 12 words, the words or working on the page that earn the credit."""

B = """

Several parts: this time you mark every part listed in <parts> at once. Everything above applies to each part on its own.
- Find each part's answer anywhere in the pages given; it may run over several pages or come out of order. A part with no answer earns "none" on every item.
- Mark only what the student wrote for that part.
Reply with JSON only, one entry per part in the given order: {"parts": [{"part": "1a", "steps": [], "vocabulary_only": false, "injection_suspected": false, "comment": "", "items": [{"id": "m0", "quote": "", "reason": "", "choice": "full"}]}]}"""

GRADE_SYSTEM = grading.SYSTEM_PROMPT + grading.DRAWN_SECTION + P1 + B

# Epo's figure, held pending confirmation (todo-file-submissions.md 5a).
PAPER_MAX_PAGES = 15
READ_EDGE = 1024
GRADE_EDGE = 1568
BATCH = 4
_READ_MAX_TOKENS = 6000
GRADED = ("open", "drawing")


class TooManyPages(ValueError):
    pass


@dataclass
class Part:
    id: str
    type: str
    label: str
    question: str
    items: list[dict[str, Any]]


@dataclass
class Page:
    """A PDF page or an image (rendered per edge), or a text file's whole text."""

    number: int
    file_id: str
    file_page: int = 1
    text: str | None = None
    images: dict[int, str] = field(default_factory=dict)


async def assemble(files: list[dict[str, str]]) -> list[Page]:
    """The paper's pages in file order, numbered on across files from 1. Text
    and Office files are one text page each, as in Make a quiz."""
    pages: list[Page] = []
    for file in files:
        file_id, name = file["fileId"], file["name"]
        row = await store.file_page_source(None, file_id)
        if row is None:
            raise extraction.ExtractionRefused(
                "file_unavailable", f"{name} is no longer available."
            )
        if row.get("kind") == "pdf":
            try:
                pdf = await capture.pdf_path(None, file_id)
            except capture.CaptureUnavailable as exc:
                raise extraction.ExtractionRefused(exc.code, f"{name}: {exc}.") from exc
            count = await limits.render_thread(extraction._page_count, pdf)
        elif row.get("kind") == "image":
            count = 1
        else:
            text = extraction._whole_text(
                name, await store.file_passages(None, file_id)
            )
            pages.append(Page(len(pages) + 1, file_id, text=text))
            continue
        pages += [Page(len(pages) + n, file_id, n) for n in range(1, count + 1)]
        if len(pages) > PAPER_MAX_PAGES:
            break
    if len(pages) > PAPER_MAX_PAGES:
        raise TooManyPages(f"A paper holds at most {PAPER_MAX_PAGES} pages.")
    return pages


async def _render(pages: list[Page], edge: int) -> None:
    """Each of ``pages`` drawn once at ``edge``; text pages need nothing."""

    async def one(page: Page) -> None:
        if page.text is None and edge not in page.images:
            jpeg, _box, _size = await capture.render_file(
                None, page.file_id, page.file_page, None, edge
            )
            page.images[edge] = capture.data_url(jpeg)

    await asyncio.gather(*(one(page) for page in pages))


def _page_content(pages: list[Page], edge: int) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    for page in pages:
        if page.text is not None:
            # A typed page is the student's work: it cannot close a section.
            text = f"Page {page.number}:\n{grading._escape(page.text)}"
            content.append({"type": "text", "text": text})
        else:
            content += [
                {"type": "text", "text": f"Page {page.number}:"},
                {"type": "image_url", "image_url": {"url": page.images[edge]}},
            ]
    return content


def _numbers(value: Any, count: int) -> list[int]:
    """Page numbers within the paper, deduplicated in order."""
    kept: list[int] = []
    for n in value if isinstance(value, list) else []:
        if type(n) is int and 1 <= n <= count and n not in kept:
            kept.append(n)
    return kept


def _reply_parts(content: Any, what: str) -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(content)
    except (TypeError, json.JSONDecodeError) as error:
        raise elitellm.ProviderError(f"the {what} reply is not JSON") from error
    entries = data.get("parts") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        raise elitellm.ProviderError(f"the {what} reply has no parts")
    return {
        str(entry.get("part")): entry for entry in entries if isinstance(entry, dict)
    }


async def read(
    parts: list[Part], pages: list[Page], *, model: ModelConfig
) -> dict[str, dict[str, Any]]:
    """Each part's pages and, for a closed part, its answer. An answer with no
    pages is dropped: the bench saw R guess one for an unanswered part."""
    await _render(pages, READ_EDGE)
    labels = "\n\n".join(part.label for part in parts)
    message = await models.complete(
        [
            {"role": "system", "content": R},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"Question parts:\n{labels}\n\nPages:"},
                    *_page_content(pages, READ_EDGE),
                ],
            },
        ],
        model=model,
        response_format={"type": "json_object"},
        max_tokens=_READ_MAX_TOKENS,
        call_purpose="grading",
        reasoning=False,
        temperature=0,
    )
    entries = _reply_parts(getattr(message, "content", None), "read")
    found: dict[str, dict[str, Any]] = {}
    for part in parts:
        entry = entries.get(part.id, {})
        numbers = _numbers(entry.get("pages"), len(pages))
        found[part.id] = {"pages": numbers}
        if numbers and part.type not in GRADED and entry.get("answer") is not None:
            found[part.id]["answer"] = entry["answer"]
    return found


def _batch_message(batch: list[Part]) -> str:
    blocks = "\n\n".join(
        f'<part id="{part.id}">\n{grading._question_and_items(part.question, part.items)}\n</part>'
        for part in batch
    )
    return f"<parts>\n{blocks}\n</parts>\n\nStudent's pages:"


async def _grade_batch(
    batch: list[Part],
    pages_of: dict[str, list[int]],
    pages: list[Page],
    model: ModelConfig,
) -> dict[str, dict[str, Any]]:
    union = sorted({n for part in batch for n in pages_of[part.id]})
    shown = [pages[n - 1] for n in union]
    kind = (
        "thinking"
        if any(grading.has_working(part.question, part.items) for part in batch)
        else "plain"
    )
    settings: dict[str, Any] = (
        {} if kind == "thinking" else {"reasoning": False, "temperature": 0}
    )
    async with asyncio.timeout(grading._TIMEOUT_S[kind]):
        message = await models.complete(
            [
                {"role": "system", "content": GRADE_SYSTEM},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _batch_message(batch)},
                        *_page_content(shown, GRADE_EDGE),
                    ],
                },
            ],
            model=model,
            response_format={"type": "json_object"},
            # One part's room each; a thinking batch as the bench ran it (32k).
            max_tokens=min(grading._MAX_TOKENS[kind] * len(batch), 32000),
            call_purpose="grading",
            **settings,
        )
    entries = _reply_parts(getattr(message, "content", None), "batch")
    graded: dict[str, dict[str, Any]] = {}
    for part in batch:
        if part.id not in entries:
            raise elitellm.ProviderError(f"the batch reply misses part {part.id}")
        # Quotes come from page images, so they are not checked (drawn).
        graded[part.id] = grading.decode(
            json.dumps(entries[part.id]), part.items, part.question, drawn=True
        )
    return graded


async def _graded_or_error(
    batch: list[Part],
    pages_of: dict[str, list[int]],
    pages: list[Page],
    model: ModelConfig,
) -> dict[str, dict[str, Any]]:
    """A failed batch leaves its parts unmarked, with why; the rest go on."""
    try:
        return await _grade_batch(batch, pages_of, pages, model)
    except Exception:
        log.exception("a paper batch failed")
        state = accounting.current()
        reason = "credits" if state and state.credits_exhausted else "error"
        return {part.id: {"error": reason} for part in batch}


async def mark(
    files: list[dict[str, str]],
    parts: list[Part],
    given: dict[str, list[int]] | None,
    *,
    model: ModelConfig,
) -> dict[str, Any]:
    """The paper's page count and, per part in order, its pages, a closed
    part's read answer, and an open or drawing part's grade or error. With
    ``given`` pages there is no read: only those open and drawing parts are
    graded on them."""
    pages = await assemble(files)
    if given is None:
        found = await read(parts, pages, model=model)
    else:
        found = {
            part.id: {"pages": _numbers(given.get(part.id), len(pages))}
            for part in parts
        }
    pages_of = {part.id: found[part.id]["pages"] for part in parts}
    graded = [part for part in parts if part.type in GRADED and pages_of[part.id]]
    needed = sorted({n for part in graded for n in pages_of[part.id]})
    await _render([pages[n - 1] for n in needed], GRADE_EDGE)
    results: dict[str, dict[str, Any]] = {}
    for batch_result in await asyncio.gather(
        *(
            _graded_or_error(graded[i : i + BATCH], pages_of, pages, model)
            for i in range(0, len(graded), BATCH)
        )
    ):
        results.update(batch_result)
    return {
        "pageCount": len(pages),
        "parts": [
            {"id": part.id, **found[part.id], **results.get(part.id, {})}
            for part in parts
        ],
    }
