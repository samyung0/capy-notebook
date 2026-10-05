"""Local agentic-loop playground.

Runs the production chat agent (pipeline.retrieval.agent) in this process against
the lab or UAT index. The system prompt, offered tools, tool caps, model, search
knobs, capture_page mode and extraction-confidence notes come from a JSON config
edited in the browser and saved under configs/. Read tools only; the search
telemetry write is disabled. Every turn is recorded under local/runs/.

  uv run --with pymupdf==1.28.2 python lab/playground/scripts/playground.py --target lab

`--ledger local/runs/<id>/run.json` starts turns from that run's stored ledger,
which is how a follow-up turn on the same conversation is tested.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bank_local
import deck
from deck import production as production_deck
from common import (
    CONFIGS,
    LOCAL,
    REPO,
    ROOT,
    TARGETS,
    PdfResolver,
    ensure_tunnel,
    prepare_environment,
)
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    Response,
    StreamingResponse,
)

RUNS = LOCAL / "runs"
# Production derives the write operations from the actor's role; the playground
# grants an editor's, plus library.read when the Library switch is on.
BUILD_OPERATIONS = frozenset(
    {"source.read", "material.read", "material.create", "document.edit"}
)


def operations_for(c: dict[str, Any]) -> frozenset[str]:
    return BUILD_OPERATIONS | ({"library.read"} if c["library"] else set())


DEFAULT_CONFIG: dict[str, Any] = {
    "workspace_id": "odl_eval_odl",
    "scope_file_ids": None,
    "locale": "en",
    # library: the per-turn Library switch; the shared library is a source.
    # Materials are written as files under the run directory either way.
    "library": True,
    # open_resource: what the learner has open, as the app sends it:
    # {"id", "kind", "title"}, or null.
    "open_resource": None,
    # study_preferences: the learner's saved preferences; missing fields take
    # the defaults in pipeline/prompts/preferences.py.
    "study_preferences": {},
    # study_progress: null leaves read_study_progress unoffered; a dict is the
    # fixture it returns, shaped like /api/internal/study-progress.
    "study_progress": None,
    # decks: offer the deck tools (production's, run locally here: deck.py);
    # the main explainer format is study_preferences.mainFormat.
    "decks": {"offer": True},
    # ledger: path to a stored ledger (a previous run.json, or its `ledger`) the
    # turn continues, the way the gateway hands one back on a follow-up turn.
    # --ledger sets it for every config that does not carry its own.
    "ledger": None,
    # transport: send this pin to another OpenAI-compatible endpoint instead of the
    # production route, e.g. {"url": ".../v1/chat/completions", "key_env": "RELACE_API_KEY",
    # "wire_model": "z-ai/glm-5.3-flash", "body": "zai"}. body picks the request builder.
    # The production chat default: GLM-5.3-Flash at high reasoning (0009, 0042).
    "model": {
        "provider_slug": "zai",
        "model_slug": "glm-5.3-flash",
        "version": 1,
        "thinking": "high",
        "transport": None,
    },
    # null keeps the production system prompt; a string replaces it wholesale,
    # except the library rules, which library_rules owns.
    "system_prompt": None,
    # null keeps production's library rules; sent only with Library on.
    "library_rules": None,
    "prompt_addon": "",
    "tool_descriptions": {},
    # A skill's text replaces what read_skill returns for it; the system prompt
    # and the other skills keep production's.
    "skills": {},
    # null offers what production offers; a list narrows it for an experiment.
    "tools": None,
    "search": {"top_k": 5, "per_file_cap": 4},
    "capture": {
        "mode": "pixels",
        "max_edge": 1568,
        "require_seen_page": True,
        "ocr_route": "docparse",
        "question_aware": True,
        "caption_prompt": (
            "This is a region of a study document. A student asked: {question}\n"
            "Transcribe every fact in the image that bears on that question exactly as printed "
            "(numbers, labels, units, table rows, formulas). Then state anything else the region "
            "shows in one short paragraph. Do not add information that is not visible."
        ),
        "addon": True,
        # OpenAI-only density switch (low | high | auto); other providers ignore it.
        "detail": None,
        # page: a capture of a page that retrieved passages already cite reuses their
        # numbers and adds no citation; new: every capture is its own citation.
        "citation": "page",
    },
    # input_limit_tokens forces compaction/checkpoints at a small budget for testing;
    # null keeps the model's real usable input limit.
    "context": {"input_limit_tokens": None},
    "quality": {
        "show": False,
        "only_below": 1.01,
        "template": " [extraction confidence {score:.2f}: {reasons}]",
    },
    # citations: as_is | renumber | structured (see citations.py)
    "answer": {"citations": "as_is"},
}


def merged(raw: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(DEFAULT_CONFIG)
    # The server's --target decides where a turn runs; configs and saved runs
    # from before 2026-10-05 still carry target (and the old acceptance
    # question), which mean nothing here.
    raw = {k: v for k, v in raw.items() if k not in ("target", "question", "expect")}
    for key, value in raw.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key].update(value)
        else:
            out[key] = value
    from pipeline.retrieval import contract

    known = set(contract.DEFINITIONS)
    descriptions = out["tool_descriptions"]
    if not isinstance(descriptions, dict) or any(
        name not in known or not isinstance(text, str)
        for name, text in descriptions.items()
    ):
        raise HTTPException(400, "tool_descriptions must map known tool names to text")
    if out["library_rules"] is not None and not isinstance(out["library_rules"], str):
        raise HTTPException(400, "library_rules must be null or text")
    from pipeline.retrieval import skills

    texts = out["skills"]
    if not isinstance(texts, dict) or any(
        name not in skills.SKILLS or not isinstance(text, str)
        for name, text in texts.items()
    ):
        raise HTTPException(400, "skills must map known skill names to text")
    if out["tools"] is not None and (
        not isinstance(out["tools"], list)
        or any(name not in known for name in out["tools"])
    ):
        raise HTTPException(400, "tools must be null or a list of known tool names")
    return out


def load_config(name: str) -> dict[str, Any]:
    return merged(json.loads((CONFIGS / f"{name}.json").read_text(encoding="utf-8")))


def model_spec(model: dict[str, Any]):
    """A model_configs row by pin, or an ad-hoc pin for a model the catalog lacks
    (`adhoc` carries the row fields; the provider still needs its platform key)."""
    from pipeline import registry

    adhoc = model.get("adhoc")
    if not adhoc:
        return registry.registry.get(
            model["provider_slug"], model["model_slug"], int(model["version"])
        )
    return registry.ModelConfig(
        version=int(model.get("version") or 1),
        provider_name=adhoc.get("provider_name") or model["provider_slug"],
        model_name=adhoc.get("model_name") or model["model_slug"],
        provider_slug=model["provider_slug"],
        model_slug=model["model_slug"],
        platform_enabled=True,
        params=adhoc.get("params") or {"temperature": 0.3},
        slots=(registry.Slot.CHAT, registry.Slot.CAPTIONING),
        thinking_levels=tuple(
            adhoc.get("thinking_levels") or ("low", "mid", "high", "max")
        ),
        default_thinking=model.get("thinking") or "high",
        context_window_tokens=int(adhoc.get("context_window_tokens") or 200000),
    )


def effective_prompt(
    c: dict[str, Any],
    base: str | None = None,
    *,
    library: bool | None = None,
    with_library: bool = True,
) -> str:
    """The exact system prompt a turn sends: production text without the
    library rules, or the config's replacement; with Library on, the library
    rules (production's or library_rules) where production puts them, before
    the answer format, or last when a replacement dropped that; then the
    addons. ``with_library=False`` is the editable part the page shows."""
    import capture
    import citations

    from pipeline.prompts import chat as chat_prompts

    library = c["library"] if library is None else library
    if base is None:
        base = chat_prompts.system_prompt(c["locale"])
    text = base if c["system_prompt"] is None else c["system_prompt"]
    if library and with_library:
        rules = (
            chat_prompts.LIBRARY_RULES
            if c["library_rules"] is None
            else c["library_rules"]
        )
        head, lang, tail = text.rpartition("\n\n" + chat_prompts.LANG_RULE)
        text = (
            f"{head}\n\n{rules}{lang}{tail}" if lang else f"{text}\n\n{rules}"
        )
    offers_capture = c["tools"] is None or capture.NAME in c["tools"]
    use_capture = offers_capture and c["capture"]["addon"]
    structured = c["answer"]["citations"] == "structured"
    prompt = (
        text
        + (c["prompt_addon"] or "")
        + (capture.ADDON if use_capture else "")
        + (citations.STRUCTURED_ADDON if structured else "")
    )
    return prompt


SUBJECT_CATALOG = "\n\nSubjects this library holds (browse one for its topic ids):\n"
# The lists production appends per turn, kept when a config replaces the text.
CATALOGS = {
    "browse_knowledge": SUBJECT_CATALOG,
    "list_question_bank": "\n\nExams and subjects this bank holds",
    "read_skill": "\n\nSkills:\n",
}


def tool_prompt(function: dict[str, Any]) -> str:
    marker = CATALOGS.get(function["name"])
    description = function["description"]
    return description.partition(marker)[0] if marker else description


def configured_tools(c: dict[str, Any], schemas: list[dict]) -> list[dict]:
    """Replace descriptions while retaining the live catalog and argument schemas."""
    import capture

    # The playground's configurable capture handler replaces the production tool.
    offered = any(s["function"]["name"] == capture.NAME for s in schemas)
    result = copy.deepcopy(
        [s for s in schemas if s["function"]["name"] != capture.NAME]
        + ([capture.SCHEMA] if offered else [])
    )
    for schema in result:
        function = schema["function"]
        name = function["name"]
        if name in c["tool_descriptions"]:
            catalog = function["description"][len(tool_prompt(function)) :]
            function["description"] = c["tool_descriptions"][name] + catalog
    return result


def tools_off(kw: dict[str, Any]) -> bool:
    """A model call that may not call tools: none sent, or sent with
    tool_choice "none" so the request keeps its cached prefix."""
    return not kw.get("tools") or kw.get("tool_choice") == "none"


def turn_tools(c: dict[str, Any], production: list[dict]) -> list[dict]:
    """What a turn offers: production's tools, without the deck tools and the
    deck skill when decks are off, with the configured descriptions."""
    from pipeline.retrieval import skills

    out = [
        s
        for s in production
        if (c["decks"]["offer"] or s["function"]["name"] not in deck.NAMES)
        and (c["tools"] is None or s["function"]["name"] in c["tools"])
    ]
    schemas = configured_tools(c, out)
    if not c["decks"]["offer"]:
        line = "\n" + skills.catalog_line(skills.DECK, skills.SKILLS[skills.DECK].when)
        for schema in schemas:
            if schema["function"]["name"] == "read_skill":
                schema["function"]["description"] = schema["function"][
                    "description"
                ].replace(line, "")
    return schemas


def skill_texts(c: dict[str, Any], *, library: bool) -> dict[str, str]:
    """Production's text of each skill this config offers."""
    from pipeline.retrieval import skills

    return {
        name: skill.text(library)
        for name, skill in skills.SKILLS.items()
        if c["decks"]["offer"] or name != skills.DECK
    }


def skill_text(c: dict[str, Any], name: str, *, library: bool) -> str | None:
    """What read_skill returns here: the config's text, else production's."""
    offered = skill_texts(c, library=library)
    if name not in offered:
        return None
    return c["skills"].get(name, offered[name])


def material_id(assistant_message_id: str, call_id: str) -> str:
    """The deterministic id Go mints for a chat-created material."""
    digest = hashlib.sha256(f"{assistant_message_id}\n{call_id}".encode()).hexdigest()
    return "mat_" + digest[:16]


def merge_books(
    existing: list[dict[str, Any]], incoming: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """What Go does with an edit's provenance: merge by book id, union the excerpts."""
    merged = {book["id"]: dict(book) for book in existing}
    for book in incoming:
        current = merged.setdefault(book["id"], {**book, "excerptIds": []})
        current["excerptIds"] = sorted(
            {*current.get("excerptIds", []), *book.get("excerptIds", [])}
        )
    return list(merged.values())


async def list_sources_locally(ctx, state: dict[str, Any]):
    """List the developer-selected workspace without a gateway or a user session."""
    from pipeline.retrieval import store, tools

    outline = await store.workspace_outline(ctx.workspace_id)
    documents = [
        {"id": f["id"], "kind": "source_file", "editable": False}
        for f in outline["files"]
        if f.get("kind") != "material"
    ]
    pool = await store.pool()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            "SELECT id, title, kind, chapter_id FROM materials WHERE workspace_id = %s "
            "AND trashed_at IS NULL AND parent_material_id IS NULL ORDER BY position, created_at",
            (ctx.workspace_id,),
        )
        materials = [dict(row) for row in await cursor.fetchall()]
    for items, editable in ((materials, False), (state["materials"], True)):
        documents.extend(
            {
                "id": m["id"],
                "title": m["title"],
                "kind": "material",
                "materialKind": m["kind"],
                "chapterId": m.get("chapter_id"),
                "editable": editable,
            }
            for m in items
        )
    return tools._source_listing(outline, documents, ctx.file_ids)


async def create_material_locally(
    args: dict[str, Any], ctx, state: dict[str, Any], message_id: str
):
    """create_material without a gateway: the material lands as JSON under the run
    directory and the model gets the receipt the gateway would have returned.

    The ledger rules (a todo while todos are open, only excerpts this turn
    read) are the production helpers, and a quiz goes through the app's own
    validation (server/cmd/quizcheck), so a saved quiz is one the app accepts."""
    from pipeline.retrieval import tools

    kind, call_id = str(args.get("kind") or ""), str(args.get("_tool_call_id") or "")
    prepared = await tools.ledger_write(ctx, "create_material", args)
    if isinstance(prepared, tools.ToolResult):
        return prepared
    books, todo = prepared
    if kind == "quiz":
        problem = await check_quiz(args.get("questions") or [])
    else:
        problem = await check_note(str(args.get("content") or ""))
    if problem:
        return tools._refused(f"create_material: {problem}")
    rid, title = material_id(message_id, call_id), str(args.get("title") or "").strip()
    record = {
        "id": rid,
        "kind": kind,
        "title": title,
        "content": args.get("content") or "",
        "cards": args.get("cards") or [],
        "questions": args.get("questions") or [],
        "excerpt_ids": [str(e) for e in (args.get("excerpt_ids") or [])],
        "provenance": {"books": books} if books else None,
        "chapter_id": args.get("chapter_id") or None,
        "size": material_size(kind, args),
        "edits": [],
    }
    state["materials"].append(record)
    write_material(state, record)
    result = tools._receipt_result(
        {
            "outcome": "succeeded",
            "effect": {
                "operation": "created",
                "resource": {
                    "kind": "material",
                    "id": rid,
                    "title": title,
                    "materialKind": kind,
                },
            },
        }
    )
    ctx.ledger.complete(todo)
    return result


async def edit_material_locally(args: dict[str, Any], ctx, state: dict[str, Any]):
    """edit_document against a material this run created: the commands are appended
    to its file and the appended section's provenance merges into the material's."""
    from pipeline.retrieval import tools

    target = args.get("target") or {}
    rid = str(target.get("id") or "")
    record = next((m for m in state["materials"] if m["id"] == rid), None)
    if record is None or target.get("kind") != "material":
        return tools._refused(
            f"edit_document: {rid} is not a material this run created.",
            code="unavailable_target",
        )
    prepared = await tools.ledger_write(ctx, "edit_document", args)
    if isinstance(prepared, tools.ToolResult):
        return prepared
    books, todo = prepared
    commands = list(args.get("commands") or [])
    problem = await check_note(
        "\n".join(str(c.get("markdown") or "") for c in commands)
    )
    if problem:
        return tools._refused(f"edit_document: {problem}")
    record["edits"].extend(commands)
    record["content"] = "\n".join(
        part
        for part in [
            record["content"],
            *(str(c.get("markdown") or c.get("text") or "") for c in commands),
        ]
        if part
    )
    record["size"] = material_size(record["kind"], record)
    record["excerpt_ids"] = sorted(
        {*record["excerpt_ids"], *(str(e) for e in (args.get("excerpt_ids") or []))}
    )
    if books:
        existing = (record["provenance"] or {}).get("books") or []
        record["provenance"] = {"books": merge_books(existing, books)}
    write_material(state, record)
    result = tools._receipt_result(
        {
            "outcome": "succeeded",
            "effect": {
                "operation": "edited",
                "resource": {
                    "kind": "material",
                    "id": rid,
                    "title": record["title"],
                    "materialKind": record["kind"],
                },
            },
        }
    )
    ctx.ledger.complete(todo)
    return result


async def deck_locally(
    name: str, args: dict[str, Any], ctx, state: dict[str, Any], message_id: str
):
    """create_deck and write_slide as production runs them (pipeline.retrieval
    .deck and tools._create_deck/_write_slide), except that the deck lands as
    JSON under the run and, once every slide is written, the exported .pptx
    stays there instead of being stored through the gateway."""
    from pipeline.retrieval import library, tools

    clean = {k: v for k, v in args.items() if not k.startswith("_")}
    problem = tools.contract.validate_args(name, clean)
    if problem:
        return tools._refused(problem)
    if name == "create_deck":
        chapter = str(clean.get("chapter_id") or "")
        if chapter and chapter not in {c["id"] for c in ctx.chapters}:
            return tools._refused(
                "chapter_id is not a chapter of this workspace; the turn context lists them."
            )
        prepared = await tools.ledger_write(ctx, "create_deck", clean)
        if isinstance(prepared, tools.ToolResult):
            return prepared
        books, todo = prepared
        rid = production_deck.deck_id(message_id, str(args.get("_tool_call_id") or ""))
        record = deck.create(clean, rid)
        record["excerpt_ids"] = [str(e) for e in clean.get("excerpt_ids") or []]
        state["materials"].append(record)
        operation = "created"
        outline = deck.created_text(record)
    else:
        rid = str(clean["deck_id"])
        record = next(
            (m for m in state["materials"] if m["id"] == rid and m["kind"] == "deck"),
            None,
        )
        if record is None:
            return tools._refused(
                f"write_slide: {rid} is not a deck this turn outlined; a deck is written "
                "within the turn that creates it.",
                code="unavailable_target",
            )
        if record.get("pptx"):
            return tools._refused(
                f"Deck {rid} is exported to {record['pptx']}, which is now the document: "
                "change its text with edit_document replace_text, or make a new deck.",
                code="unavailable_target",
            )
        prepared = await tools.ledger_write(ctx, "write_slide", clean)
        if isinstance(prepared, tools.ToolResult):
            return prepared
        books, todo = prepared
        # The model knows a capture by its page; a later capture of the same
        # page wins. A whole page is refused: a slide shrinks it unreadable.
        captures, figures, excerpts = {}, {}, {}
        for cap in state["captures"]:
            page = cap["page"]
            if not cap.get("bbox") or list(cap["bbox"]) == production_deck.WHOLE_PAGE:
                captures[page] = (
                    f"page {page} was captured whole; capture it again with a bbox "
                    "around the figure"
                )
                continue
            captures[page] = ""
            figures[page] = (state["run_dir"].parent.parent / cap["image"]).read_bytes()
            excerpts.pop(page, None)
            if cap.get("excerpt_id"):
                excerpts[page] = cap["excerpt_id"]
        cropped = sorted(
            {excerpts[p] for p in deck.figure_pages(clean["svg"]) if p in excerpts}
        )
        if cropped:
            books = [*books, *await library.provenance(cropped)]
        project = state["run_dir"] / "materials" / rid
        problem = await asyncio.to_thread(deck.write, record, clean, captures, figures, project)
        if problem:
            return tools._refused(f"write_slide: {problem}")
        record["excerpt_ids"] = sorted(
            {*record["excerpt_ids"], *(str(e) for e in clean.get("excerpt_ids") or [])}
        )
        operation = "edited"
        outline = deck.outline_text(record)
    production_deck.add_books(record, books)
    if name == "write_slide" and deck.complete(record):
        pptx = state["run_dir"] / "materials" / f"{rid}.pptx"
        problem = await asyncio.to_thread(deck.save, record, project, pptx)
        if problem:
            outline += f"\n\nThe export failed; rewrite the slide it names: {problem}"
        else:
            # runs/<run>/materials/<id>.pptx, the path the download route serves.
            record["pptx"] = str(pptx.relative_to(state["run_dir"].parent.parent))
            outline += "\n\nEvery slide is written; the deck is exported."
    slides = record["deck"]["slides"]
    record["size"] = f"{sum(1 for s in slides if s['svg'])} of {len(slides)} slides written"
    write_material(state, record)
    result = tools._receipt_result(
        {
            "outcome": "succeeded",
            "effect": {
                "operation": operation,
                "resource": {
                    "kind": "material",
                    "id": rid,
                    "title": record["title"],
                    "materialKind": "deck",
                },
            },
        }
    )
    ctx.ledger.complete(todo)
    result.text_parts = [outline]
    return result


async def copy_locally(
    args: dict[str, Any], ctx, state: dict[str, Any], message_id: str
):
    """copy_questions as the gateway runs it: bank questions copied unchanged
    into a new quiz or one this run made, each credited under its id with its
    bank sources (Go resolves those into book and web credits)."""
    from pipeline.retrieval import tools

    clean = {k: v for k, v in args.items() if not k.startswith("_")}
    title, quiz_id = str(clean.get("title") or "").strip(), clean.get("quiz_id")
    if bool(title) == bool(quiz_id):
        return tools._refused(
            "copy_questions takes exactly one destination: title for a new quiz, "
            "or quiz_id for a quiz in this workspace."
        )
    if clean.get("chapter_id") and quiz_id:
        return tools._refused("chapter_id files a new quiz; it goes with title.")
    rows = [await bank_local.read(str(qid)) for qid in clean["question_ids"]]
    missing = [qid for qid, row in zip(clean["question_ids"], rows, strict=True) if row is None]
    if missing:
        return tools._refused(
            "A question id is not in the bank; list_question_bank shows them.",
            code="unavailable_target",
        )
    record = None
    if quiz_id:
        record = next(
            (m for m in state["materials"] if m["id"] == quiz_id and m["kind"] == "quiz"), None
        )
        if record is None:
            return tools._refused(
                "quiz_id is not a quiz in this workspace", code="unavailable_target"
            )
    prepared = await tools.ledger_write(ctx, "copy_questions", clean, excerpts=False)
    if isinstance(prepared, tools.ToolResult):
        return prepared
    _, todo = prepared
    questions = [row["question"] for row in rows]
    credits = {row["id"]: row["sources"] for row in rows if row.get("sources")}
    if record is None:
        record = {
            "id": material_id(message_id, str(args.get("_tool_call_id") or "")),
            "kind": "quiz",
            "title": title,
            "content": "",
            "cards": [],
            "questions": questions,
            "excerpt_ids": [],
            "provenance": {"questions": credits} if credits else None,
            "chapter_id": clean.get("chapter_id") or None,
            "edits": [],
        }
        state["materials"].append(record)
        operation = "created"
    else:
        record["questions"] = [*record["questions"], *questions]
        provenance = record.get("provenance") or {}
        record["provenance"] = {
            **provenance,
            "questions": {**(provenance.get("questions") or {}), **credits},
        }
        record["edits"].append({"copy": list(clean["question_ids"])})
        operation = "edited"
    record["size"] = material_size("quiz", record)
    write_material(state, record)
    result = tools._receipt_result(
        {
            "outcome": "succeeded",
            "effect": {
                "operation": operation,
                "resource": {
                    "kind": "material",
                    "id": record["id"],
                    "title": record["title"],
                    "materialKind": "quiz",
                },
            },
        }
    )
    ctx.ledger.complete(todo)
    return result


def material_size(kind: str, args: dict[str, Any]) -> str:
    from pipeline.retrieval.chunking import estimate_tokens

    if kind == "quiz":
        return f"{len(args.get('questions') or [])} questions"
    if kind == "flashcards":
        return f"{len(args.get('cards') or [])} cards"
    return f"{estimate_tokens(str(args.get('content') or ''))} tokens"


async def check_quiz(questions: list[Any]) -> str:
    """The app's quiz validation, or empty when the questions pass it."""
    proc = await asyncio.create_subprocess_exec(
        "go",
        "run",
        "./cmd/quizcheck",
        cwd=REPO / "server",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate(json.dumps(questions).encode())
    return "" if proc.returncode == 0 else out.decode().strip()[:600]


FENCE = re.compile(r"^```([\w-]*)[^\n]*\n(.*?)^```[ \t]*$", re.M | re.S)
EMBED_HTML_MAX = 64 * 1024
EMBEDS_PER_NOTE = 10
NETWORK = re.compile(r"https?://|\bfetch\(|XMLHttpRequest|WebSocket|EventSource|import\(")


async def check_note(markdown: str) -> str:
    """The note fences as the editor's import and phase 3's element will take
    them, or empty when every fence passes."""
    embeds = sum(1 for m in FENCE.finditer(markdown) if m.group(1) == "html-embed")
    if embeds > EMBEDS_PER_NOTE:
        return f"{embeds} html-embed fences; a note holds at most {EMBEDS_PER_NOTE}"
    for n, match in enumerate(FENCE.finditer(markdown), 1):
        lang, body = match.group(1), match.group(2)
        where = f"fence {n} ({lang})"
        if lang not in ("quiz", "flashcards", "html-embed"):
            if lang == "mermaid" and not body.strip():
                return f"{where} is empty"
            continue
        try:
            data = yaml.safe_load(body)
        except yaml.YAMLError as err:
            return f"{where} is not YAML: {str(err).splitlines()[0]}"
        if not isinstance(data, dict):
            return f"{where} must be a YAML mapping"
        if lang == "quiz":
            questions = data.get("questions")
            if not isinstance(questions, list) or not questions:
                return f"{where} needs a non-empty questions list"
            problem = await check_quiz(questions)
            if problem:
                return f"{where}: {problem}"
        elif lang == "flashcards":
            cards = data.get("cards")
            if not isinstance(cards, list) or not cards:
                return f"{where} needs a non-empty cards list"
            for card in cards:
                if not isinstance(card, dict) or not all(
                    isinstance(card.get(k), str) and card[k].strip()
                    for k in ("front", "back")
                ):
                    return f"{where}: every card needs a front and a back"
        else:
            html = data.get("html")
            if not isinstance(html, str) or not html.strip():
                return f"{where} needs html"
            if len(html.encode()) > EMBED_HTML_MAX:
                return f"{where}: html is {len(html.encode())} bytes, over {EMBED_HTML_MAX}"
            if NETWORK.search(html):
                return f"{where}: html must not reach the network ({NETWORK.search(html).group(0)})"
    return ""


def ledger_state(ledger) -> dict[str, Any]:
    """The ledger two ways. The top level is the turn as the model sees it: every
    todo with the id the turn context shows, plus this turn's reads and progress.
    `stored` is what the gateway would persist at turn end, the newest 10 open
    todos; `--ledger` and the config's `ledger` field read it, so a follow-up
    turn starts where a real one would."""
    return {
        "next_todo_id": ledger.next_todo_id,
        "todos": [{"id": t.id, "text": t.text, "done": t.done} for t in ledger.todos],
        "progress": ledger.progress,
        "reads": [
            {"excerpt_id": r.excerpt_id, "start": r.start, "section": r.section}
            for r in ledger.reads
        ],
        "stored": ledger.stored(),
    }


def starting_ledger(path: str | None):
    """The ledger a run starts from: a previous run.json, or a bare stored
    ledger. Without one the conversation starts with an empty ledger."""
    from pipeline.retrieval import tools

    if not path:
        return tools.Ledger()
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    ledger = raw.get("ledger", raw)
    return tools.Ledger.from_stored(ledger.get("stored", ledger))


def save_knowledge_capture(
    state: dict[str, Any], ctx, call_id: str, run_id: str
) -> dict[str, Any]:
    """capture_knowledge_page renders through the production tool, which keeps its
    JPEG on the ToolContext; put it on disk in the shape the page already renders."""
    import base64

    entry = next((cap for cap in ctx.captures if cap["callId"] == call_id), None)
    label, url = ctx.pending_images.get(call_id, ("", ""))
    if entry is None or not url:
        return {"type": "capture_missing", "call_id": call_id}
    n = len(state["captures"]) + 1
    path = state["run_dir"] / "captures" / f"{n}.jpg"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(url.split(",", 1)[1]))
    record = {
        "n": n,
        "call_id": call_id,
        "file_id": entry["fileId"],
        "excerpt_id": entry.get("excerptId"),
        "page": entry["page"],
        "bbox": entry["bbox"],
        "mode": "pixels",
        "image": str(path.relative_to(LOCAL)),
        "image_bytes": entry["bytes"],
        "image_px": entry["pixels"],
        "est_image_tokens": entry["estimatedImageTokens"],
        "label": label,
        "text": "",
    }
    state["captures"].append(record)
    return {"type": "capture", **record, "url": f"/api/runs/{run_id}/captures/{n}.jpg"}


def write_material(state: dict[str, Any], record: dict[str, Any]) -> None:
    path = state["run_dir"] / "materials" / f"{record['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")


def load_quality(target: str, workspace_id: str) -> dict[str, Any]:
    path = LOCAL / "quality" / f"{target}-{workspace_id}.json"
    return (
        json.loads(path.read_text(encoding="utf-8"))["chunks"] if path.exists() else {}
    )


class Turn:
    """One question through the patched agent. Patches are process-global, so
    the server runs one turn at a time."""

    def __init__(
        self,
        config: dict[str, Any],
        question: str,
        history: list[dict[str, Any]],
        resolver: PdfResolver,
        checkpoint: dict[str, Any] | None = None,
        ledger: dict[str, Any] | None = None,
    ):
        self.config, self.question, self.history, self.resolver = (
            config,
            question,
            history,
            resolver,
        )
        self.checkpoint = checkpoint
        self.ledger = ledger
        self.id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        self.run_dir = RUNS / self.id
        self.state: dict[str, Any] = {
            "run_dir": self.run_dir,
            "captures": [],
            "images": {},
            "calls": [],
            "provider_calls": [],
            "extra": [],
            "_result_call": {},
            "compactions": [],
            "materials": [],
            "ledger": {},
            "stall_events": [],
        }

    async def events(self):
        import capture
        import citations

        from pipeline import elitellm, obs, registry
        from pipeline.config import cfg
        from pipeline.elitellm import client as llm_client
        from pipeline.prompts import chat as chat_prompts
        from pipeline.retrieval import (
            agent,
            compact,
            models,
            search,
            skills,
            store,
            tools,
        )
        from pipeline.retrieval.chunking import estimate_tokens

        c, state = self.config, self.state
        library = bool(c["library"])
        spec = model_spec(c["model"])
        registry.bind_request_llm(thinking=c["model"]["thinking"])
        registry.set_job_pins(registry.JobPins(captioning=spec))
        obs.set_trace(obs.new_trace_id())
        obs.start_usage()
        # None offers what production offers.
        offered = None if c["tools"] is None else set(c["tools"])
        use_capture = offered is None or capture.NAME in offered
        handler = (
            capture.make_handler(c, self.resolver, state, self.question)
            if use_capture
            else None
        )
        quality = (
            load_quality(c["target"], c["workspace_id"]) if c["quality"]["show"] else {}
        )
        ctx = tools.ToolContext(
            workspace_id=c["workspace_id"],
            user_id="playground",
            library=library,
            operations=operations_for(c),
            file_ids=c["scope_file_ids"] or None,
            assistant_message_id=self.id,
            ledger=tools.Ledger.from_stored(self.ledger)
            if self.ledger is not None
            else starting_ledger(c["ledger"]),
            open_resource=dict(c["open_resource"] or {}),
            study_preferences=dict(c["study_preferences"] or {}),
            study_progress=bool(c["study_progress"]),
        )
        saved = {
            "system_prompt": chat_prompts.system_prompt,
            "schemas_for": tools.schemas_for,
            "run": tools.run,
            "store_ledger": tools.store_ledger,
            "mutates": tools.mutates,
            "render": tools.render_result,
            "stream": models.stream_agent_response,
            "record": store.record_search_events,
            "location": search.Passage.location,
            "llm_stream": elitellm.stream,
            "llm_complete": elitellm.complete,
            "usable_input_limit": compact.usable_input_limit,
            "summarize": compact.summarize_checkpoint,
            "cfg": (cfg.search_top_k, cfg.search_per_file_cap),
        }

        def system_prompt(locale, *, library=False):
            return effective_prompt(c, saved["system_prompt"](locale), library=library)

        def schemas_for(ctx_):
            schemas = turn_tools(c, saved["schemas_for"](ctx_))
            state["tool_schemas"] = schemas
            return schemas

        async def run(name, args, ctx_):
            record = {
                "sequence": len(state["calls"]),
                "name": name,
                "call_id": args.get("_tool_call_id"),
                "args": {k: v for k, v in args.items() if not k.startswith("_")},
            }
            state["calls"].append(record)
            started = time.perf_counter()
            problem = (
                tools.contract.validate_args(name, record["args"])
                if name in tools.contract.DEFINITIONS
                else None
            )
            if offered is not None and name not in offered:
                result = tools._refused(
                    f"{name} is not offered in this configuration.",
                    code="unsupported_operation",
                )
            elif name == capture.NAME:
                result = await handler(args, ctx_)
                if (
                    state["captures"]
                    and state["captures"][-1]["call_id"] == record["call_id"]
                ):
                    cap = state["captures"][-1]
                    state["extra"].append(
                        {
                            "type": "capture",
                            **cap,
                            "url": f"/api/runs/{self.id}/captures/{cap['n']}.jpg",
                        }
                    )
            elif problem:
                result = tools._refused(problem)
            elif needs := skills.missing(name, record["args"], ctx_.skills_read):
                result = tools._refused(skills.refusal(needs))
            elif name == "read_skill" and (
                text := skill_text(c, record["args"]["name"], library=ctx_.library)
            ) is not None:
                result = tools._result(skills.render(record["args"]["name"], text))
            elif name == "list_sources":
                result = await list_sources_locally(ctx_, state)
            elif name == "read_study_progress":
                result = tools._result(tools.render_progress(c["study_progress"]))
            elif name in deck.NAMES:
                result = await deck_locally(name, args, ctx_, state, self.id)
            elif name == "copy_questions":
                result = await copy_locally(args, ctx_, state, self.id)
            elif name == "create_material":
                result = await create_material_locally(args, ctx_, state, self.id)
            elif name == "edit_document":
                result = await edit_material_locally(args, ctx_, state)
            else:
                result = await saved["run"](name, args, ctx_)
            if result.effects:
                rid = (result.effects[0].get("resource") or {}).get("id")
                written = next((m for m in state["materials"] if m["id"] == rid), None)
                if written is not None:
                    state["extra"].append({"type": "material", **written})
            if name == "capture_knowledge_page" and not result.refused:
                state["extra"].append(
                    save_knowledge_capture(state, ctx_, record["call_id"], self.id)
                )
            record.update(
                elapsed_seconds=round(time.perf_counter() - started, 3),
                outcome=result.outcome,
                error=result.error,
                passages=[p.chunk_id for p in result.passages],
            )
            state["_result_call"][id(result)] = record
            return result

        async def store_ledger(ctx_):
            """There is no gateway to store the ledger in: run.json is where a
            follow-up run reads it back from (`--ledger`)."""
            state["ledger"] = ledger_state(ctx_.ledger)

        def mutates(name):
            return False if name == capture.NAME else saved["mutates"](name)

        def render_result(result, numbered):
            text = saved["render"](result, numbered)
            record = state["_result_call"].get(id(result))
            if record is not None:
                shown = tools.limit_tool_result(text)
                record.update(text_sent_to_model=shown, truncated=shown != text)
                state["extra"].append(
                    {
                        "type": "tool_text",
                        "callId": record["call_id"],
                        "name": record["name"],
                        "text": shown,
                    }
                )
            return text

        transport = c["model"].get("transport")
        structured = c["answer"]["citations"] == "structured"
        builders = {
            "zai": llm_client.zai_request,
            "openai": llm_client.openai_chat_request,
            "deepseek": llm_client.deepseek_request,
        }

        async def llm_stream(model, messages, **kw):
            """Route this turn's pin to the configured endpoint; enforce JSON only on
            tools-off calls, because a tool-capable call under json_object skips tools."""
            if (
                model.pin == spec.pin
                and structured
                and tools_off(kw)
                and kw.get("response_format") is None
            ):
                kw["response_format"] = {"type": "json_object"}
            if model.pin != spec.pin or not transport:
                async for chunk in saved["llm_stream"](model, messages, **kw):
                    yield chunk
                return
            key = os.environ.get(transport["key_env"], "")
            if not key:
                raise RuntimeError(
                    f"{transport['key_env']} is not set for the transport override"
                )
            temperature = kw.get("temperature")
            body = builders[transport.get("body", "zai")](
                model,
                messages,
                temperature=model.temperature() if temperature is None else temperature,
                tools=kw.get("tools"),
                response_format=kw.get("response_format"),
                max_tokens=kw.get("max_tokens"),
                thinking=llm_client._thinking_for_call(model, kw.get("reasoning")),
                stream=True,
                tool_choice=kw.get("tool_choice"),
            )
            body["model"] = transport.get("wire_model") or model.model_slug
            async for event in llm_client._stream_sse(
                transport["url"], llm_client._bearer(key), body
            ):
                yield llm_client._as_obj(event)

        async def llm_complete(model, messages, **kw):
            """Non-streaming twin of llm_stream (captions in `caption` mode)."""
            if model.pin != spec.pin or not transport:
                return await saved["llm_complete"](model, messages, **kw)
            key = os.environ.get(transport["key_env"], "")
            if not key:
                raise RuntimeError(
                    f"{transport['key_env']} is not set for the transport override"
                )
            temperature = kw.get("temperature")
            body = builders[transport.get("body", "zai")](
                model,
                messages,
                temperature=model.temperature() if temperature is None else temperature,
                tools=kw.get("tools"),
                response_format=kw.get("response_format"),
                max_tokens=kw.get("max_tokens"),
                thinking=llm_client._thinking_for_call(model, kw.get("reasoning")),
                stream=False,
                tool_choice=kw.get("tool_choice"),
            )
            body["model"] = transport.get("wire_model") or model.model_slug
            return llm_client._as_obj(
                await llm_client._post_json(
                    transport["url"], llm_client._bearer(key), body
                )
            )

        limit_override = c["context"]["input_limit_tokens"]

        def usable_input_limit(model, **kw):
            """Force the agent's compaction threshold only; the summarizer's own
            fit check (it passes max_tokens) keeps the real limit."""
            real = saved["usable_input_limit"](model, **kw)
            if limit_override and kw.get("max_tokens") is None:
                return min(real, int(limit_override))
            return real

        async def summarize_checkpoint(**kw):
            started = time.perf_counter()
            summary = await saved["summarize"](**kw)
            record = {
                "purpose": kw.get("purpose", "checkpoint"),
                "turns_folded": len(kw.get("turns") or []),
                "kind": getattr(
                    kw.get("build"), "__name__", "checkpoint_messages"
                ).removesuffix("_messages"),
                "prior_summary_tokens": estimate_tokens(kw.get("prior_summary") or ""),
                "summary_tokens": estimate_tokens(summary),
                "elapsed_seconds": round(time.perf_counter() - started, 2),
                "summary": summary,
            }
            state["compactions"].append(record)
            state["extra"].append({"type": "compaction", **record})
            return summary

        def context_breakdown(messages, tools):
            """Estimated tokens by part of the request, the production estimator's
            total, and the limit the compactor enforces."""
            parts = {
                "system": 0,
                "memory": 0,
                "history": 0,
                "query": 0,
                "assistant": 0,
                "tool_results": 0,
            }
            counts = {"tool_results": 0, "images": 0}
            after_query = False
            for m in messages:
                role, kind, content = m.get("role"), m.get("_kind"), m.get("content")
                if isinstance(content, list):
                    text = " ".join(
                        p.get("text", "")
                        for p in content
                        if isinstance(p, dict) and p.get("type") == "text"
                    )
                    counts["images"] += sum(
                        1
                        for p in content
                        if isinstance(p, dict)
                        and p.get("type") in ("image_url", "image")
                    )
                else:
                    text = content or ""
                tokens = estimate_tokens(text)
                if role == "assistant" and m.get("tool_calls"):
                    tokens += estimate_tokens(json.dumps(m["tool_calls"]))
                if role == "system":
                    parts["system"] += tokens
                elif kind == "memory":
                    parts["memory"] += tokens
                elif kind == "query":
                    parts["query"] += tokens
                    after_query = True
                elif role == "tool":
                    parts["tool_results"] += tokens
                    counts["tool_results"] += 1
                else:
                    parts["assistant" if after_query else "history"] += tokens
            attached = set(state["images"]) | set(ctx.pending_images)
            parts["images_est"] = sum(
                cap.get("est_image_tokens", 0)
                for cap in state["captures"]
                if cap["call_id"] in attached
            )
            measured = models.measure_request_context(messages, model=spec, tools=tools)
            parts["schemas"] = measured.tool_tokens
            return {
                "parts": parts,
                "counts": counts,
                "estimated_total": measured.total_tokens + parts["images_est"],
                "limit": usable_input_limit(spec),
            }

        from pipeline.retrieval import response_guard

        async def stream(messages, **kw):
            started = time.perf_counter()
            state["last_messages"] = list(messages)
            request = capture.inject_images(
                messages, state["images"], spec.provider_slug, c["capture"]["detail"]
            )
            context = context_breakdown(request, kw.get("tools"))
            call = len(state["provider_calls"]) + 1
            if ctx.ledger.active:
                state["ledger"] = ledger_state(ctx.ledger)
                state["extra"].append(
                    {"type": "ledger", "call": call, **state["ledger"]}
                )
                if tools_off(kw):
                    # With ledger todos tools go off only on the stall guard, the
                    # tool cap or the terminal call after credits run out.
                    stall = {
                        "call": call,
                        "progress": ctx.ledger.progress,
                        "todos_done": sum(1 for t in ctx.ledger.todos if t.done),
                        "todos": len(ctx.ledger.todos),
                    }
                    state["stall_events"].append(stall)
                    state["extra"].append({"type": "stall", **stall})
            try:
                assembled = await saved["stream"](request, **kw)
            except Exception as exc:
                # The agent maps every provider failure to a generic client error;
                # keep the real text so the page can show it.
                state["last_error"] = f"{type(exc).__name__}: {exc}"[:600]
                raise
            usage = assembled.usage
            state["provider_calls"].append(
                {
                    "elapsed_seconds": round(time.perf_counter() - started, 3),
                    "input_tokens": usage.input_tokens,
                    "output_tokens": usage.output_tokens,
                    "cached_read_tokens": usage.cached_read_tokens,
                    "reasoning_tokens": usage.reasoning_tokens,
                    "tool_calls": [call.name for call in assembled.tool_calls],
                    "images_attached": len(state["images"]),
                    "response_format": bool(structured and tools_off(kw)),
                    "transport": transport["url"] if transport else "production",
                    "context": context,
                }
            )
            if response_guard.contains_tool_protocol(assembled.text):
                # The agent withholds a response carrying tool-call markup and
                # reports it as flagged; keep what the model wrote.
                state["provider_calls"][-1]["flagged_text"] = assembled.text[:8000]
            # Output by where it went: the provider reports the total and the
            # reasoning; the visible part is split by estimate.
            written = {"answer": estimate_tokens(assembled.text or "")}
            for tool_call in assembled.tool_calls:
                written[tool_call.name] = written.get(tool_call.name, 0) + estimate_tokens(
                    tool_call.arguments or ""
                )
            state["provider_calls"][-1]["output_split"] = written
            # The turn context this call carried: open file, chapters,
            # preferences, todos. It is last in the request.
            turn_context = next(
                (str(m.get("content")) for m in reversed(request) if m.get("_kind") == "ledger"),
                "",
            )
            state["provider_calls"][-1]["turn_context"] = turn_context
            state["extra"].append(
                {
                    "type": "context",
                    "call": len(state["provider_calls"]),
                    "reported_input": usage.input_tokens,
                    "cached_read": usage.cached_read_tokens,
                    "output": usage.output_tokens,
                    "reasoning": usage.reasoning_tokens,
                    "written": {name: n for name, n in written.items() if n},
                    "seconds": state["provider_calls"][-1]["elapsed_seconds"],
                    "turn_context": turn_context,
                    **context,
                }
            )
            return assembled

        async def record_search_events(events):
            return None

        def location(passage):
            base = saved["location"](passage)
            q = quality.get(passage.chunk_id)
            if (
                q
                and q.get("score") is not None
                and q["score"] < c["quality"]["only_below"]
            ):
                base += c["quality"]["template"].format(
                    score=q["score"],
                    reasons="; ".join(q["reasons"]) or "no issue found",
                )
            return base

        chat_prompts.system_prompt = system_prompt
        tools.schemas_for, tools.run, tools.store_ledger = (
            schemas_for,
            run,
            store_ledger,
        )
        tools.mutates, tools.render_result, models.stream_agent_response = (
            mutates,
            render_result,
            stream,
        )
        store.record_search_events, search.Passage.location = (
            record_search_events,
            location,
        )
        elitellm.stream, elitellm.complete = llm_stream, llm_complete
        compact.usable_input_limit, compact.summarize_checkpoint = (
            usable_input_limit,
            summarize_checkpoint,
        )
        cfg.search_top_k, cfg.search_per_file_cap = (
            c["search"]["top_k"],
            c["search"]["per_file_cap"],
        )
        self.run_dir.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        recorded: list[dict[str, Any]] = []
        mode = c["answer"]["citations"]
        blocks: dict[str, str] = {}
        renum: citations.Renumberer | None = None
        version = 0
        final_answer: str | None = None

        def final_citations(order: list[int]) -> dict[str, Any]:
            nonlocal version
            version += 1
            used = [ctx.citations[n - 1].as_citation() for n in order]
            unused = [
                p.as_citation()
                for i, p in enumerate(ctx.citations)
                if i + 1 not in order
            ]
            return {
                "type": "citations",
                "version": version,
                "final": True,
                "citations": used,
                "unused": unused,
            }

        async def structured_answer(raw: str) -> tuple[str, list[int], dict[str, Any]]:
            items = citations.parse_structured(raw)
            note: dict[str, Any] = {"repaired": False, "parse_failed": False}
            if items is None and state.get("last_messages"):
                note["repaired"] = True
                repair = state["last_messages"] + [
                    {"role": "assistant", "content": raw},
                    {"role": "user", "content": citations.REPAIR_PROMPT},
                ]
                assembled = await models.stream_agent_response(
                    repair, model=spec, tools=None
                )
                items = citations.parse_structured(assembled.text)
                state["repair_raw"] = assembled.text
            if items is None:
                note["parse_failed"] = True
                return raw, [], note
            text, order = citations.render_structured(items, len(ctx.citations))
            return text, order, note

        async def shaped(event: dict[str, Any]):
            """Apply the citation mode to one agent event; may yield several."""
            nonlocal renum, final_answer, version
            t = event.get("type")
            if t == "citations":
                version = max(version, event.get("version", 0))
            if t == "error" and state.get("last_error"):
                event = {**event, "detail": state["last_error"]}
            if mode == "as_is" or t == "citations":
                yield event
                return
            if t == "block_start":
                blocks[event["blockId"]] = ""
                renum = citations.Renumberer(lambda: len(ctx.citations))
                yield event
            elif t == "block_delta":
                blocks[event["blockId"]] = (
                    blocks.get(event["blockId"], "") + event["text"]
                )
                if mode == "renumber" and renum is not None:
                    out = renum.push(event["text"])
                    if out:
                        yield {**event, "text": out}
                else:
                    yield event
            elif t == "block_end":
                raw = blocks.get(event["blockId"], "")
                if mode == "renumber" and renum is not None:
                    tail = renum.flush()
                    if tail:
                        yield {
                            "type": "block_delta",
                            "blockId": event["blockId"],
                            "text": tail,
                        }
                    yield event
                    if event.get("kind") == "answer":
                        final_answer, order = citations.renumber(
                            raw, len(ctx.citations)
                        )
                        yield final_citations(order)
                elif event.get("kind") == "answer":
                    text, order, note = await structured_answer(raw)
                    final_answer = text
                    yield event
                    yield {
                        "type": "answer_rendered",
                        "blockId": event["blockId"],
                        "text": text,
                        **note,
                    }
                    yield final_citations(order)
                else:
                    yield event
            elif t == "error" and state.get("last_error"):
                yield {**event, "detail": state["last_error"]}
            elif t == "done":
                if final_answer is not None:
                    yield {
                        **event,
                        "answer_raw": event.get("answer", ""),
                        "answer": final_answer,
                    }
                else:
                    yield event
            else:
                yield event

        try:
            async for raw_event in agent.run_agent(
                query=self.question,
                ctx=ctx,
                history=self.history,
                model=spec,
                locale=c["locale"],
                checkpoint=self.checkpoint,
            ):
                for extra in state["extra"]:
                    recorded.append(extra)
                    yield extra
                state["extra"].clear()
                async for event in shaped(raw_event):
                    if event.get("type") != "block_delta":
                        recorded.append(event)
                    yield event
        except Exception as exc:  # noqa: BLE001 - keep the failed turn on disk
            event = {
                "type": "error",
                "code": "harness_exception",
                "message": f"{type(exc).__name__}: {exc}",
            }
            recorded.append(event)
            yield event
        finally:
            chat_prompts.system_prompt = saved["system_prompt"]
            tools.schemas_for, tools.run, tools.store_ledger = (
                saved["schemas_for"],
                saved["run"],
                saved["store_ledger"],
            )
            tools.mutates, tools.render_result, models.stream_agent_response = (
                saved["mutates"],
                saved["render"],
                saved["stream"],
            )
            store.record_search_events, search.Passage.location = (
                saved["record"],
                saved["location"],
            )
            elitellm.stream, elitellm.complete = (
                saved["llm_stream"],
                saved["llm_complete"],
            )
            compact.usable_input_limit, compact.summarize_checkpoint = (
                saved["usable_input_limit"],
                saved["summarize"],
            )
            cfg.search_top_k, cfg.search_per_file_cap = saved["cfg"]
            registry.set_job_pins(None)
        done = next((e for e in reversed(recorded) if e.get("type") == "done"), {})
        usage = obs.current_usage()
        summary = {
            "id": self.id,
            "started_unix": time.time() - (time.perf_counter() - started),
            "elapsed_seconds": round(time.perf_counter() - started, 2),
            "config": c,
            "question": self.question,
            "history": self.history,
            "system_prompt": system_prompt(c["locale"], library=library),
            "tool_schemas": state.get("tool_schemas", []),
            "answer": done.get("answer", ""),
            "answer_raw": done.get("answer_raw"),
            "repair_raw": state.get("repair_raw"),
            "citation_mode": mode,
            "telemetry": done.get("telemetry"),
            "citations": next(
                (
                    e["citations"]
                    for e in reversed(recorded)
                    if e.get("type") == "citations"
                ),
                [],
            ),
            "usage": usage.as_dict() if usage is not None else None,
            "provider_calls": state["provider_calls"],
            "calls": state["calls"],
            "captures": state["captures"],
            "compactions": state["compactions"],
            "checkpoint_in": self.checkpoint,
            "ledger_in": self.ledger,
            "events": recorded,
            # What the loop read and wrote. Materials carry their own
            # provenance books, which is the attribution a real material keeps.
            "library": library,
            "ledger": ledger_state(ctx.ledger),
            "stall_events": state["stall_events"],
            "materials": state["materials"],
        }
        (self.run_dir / "run.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        yield {
            "type": "run_saved",
            "id": self.id,
            "elapsed_seconds": summary["elapsed_seconds"],
            "usage": summary["usage"],
        }


def build_app(target: str):
    from pipeline import registry
    from pipeline.config import cfg
    from pipeline.prompts import chat as chat_prompts
    from pipeline.retrieval import library, store, tools

    # There is no gateway here: create_material and edit_document are handled in
    # process and write files. This only makes tool admission decide as it does
    # in production, so the offered tools match what a real turn would see.
    cfg.gateway_url = cfg.gateway_url or "http://playground.invalid"
    cfg.pipeline_secret = cfg.pipeline_secret or "playground"
    # Production offers the deck tools only with ppt-master installed.
    deck.ensure_ppt_master()
    # The bank routes answer from the local restore, so the production bank
    # tools run unchanged.
    gateway_read = tools._gateway_read

    async def local_gateway_read(path, payload, failure):
        if not path.startswith("/api/internal/bank/"):
            return await gateway_read(path, payload, failure)
        try:
            status, body = await bank_local.handle(path, payload)
        except Exception as exc:  # the restore is down: the tools go unoffered
            return tools._failed(f"Could not {failure}: {exc}")
        if status != 200:
            return tools._refused(
                f"Could not {failure}: {body['message']}", code=body["code"]
            )
        return body

    tools._gateway_read = local_gateway_read
    app = FastAPI(title="Capy agentic playground")
    resolver = PdfResolver(target)
    turn_lock = asyncio.Lock()
    # A running turn temporarily patches prompts and schemas with its own config.
    production_schemas = tools.schemas_for
    production_prompt = chat_prompts.system_prompt

    async def library_summary() -> dict[str, Any] | None:
        """What Library turns read: the live library's current books, their
        excerpts and the topic catalog, or None when no library URL is set."""
        if not library.enabled():
            return None
        pool = await library.pool()
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT (SELECT count(*) FROM library_books) AS books, "
                "(SELECT count(*) FROM library_excerpts e JOIN library_books b ON b.content_id = e.content_id) AS excerpts, "
                "(SELECT count(*) FROM library_topics) AS topics"
            )
            row = await cur.fetchone()
        return dict(row)

    async def reconnect() -> None:
        """Reopen the ingest-host tunnel if it died since the last request, and
        drop both pools when it did: their connections went with the old tunnel."""
        if target != "local" and ensure_tunnel():
            await store.close_pool()
            await library.close_pool()

    @app.on_event("shutdown")
    async def close_library():
        await library.close_pool()

    @app.get("/", response_class=HTMLResponse)
    def index():
        return (ROOT / "scripts/ui.html").read_text(encoding="utf-8")

    @app.get("/api/state")
    async def state():
        await reconnect()
        pool = await store.pool()
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT provider_slug, model_slug, version, thinking_levels, default_thinking, capabilities, platform_enabled "
                "FROM model_configs WHERE enabled AND 'chat' = ANY(slots) ORDER BY 1, 2, 3"
            )
            models = [dict(r) for r in await cur.fetchall()]
            cur = await conn.execute(
                "SELECT w.id, w.name, count(f.id) AS files, (SELECT count(*) FROM rag_chunks c WHERE c.workspace_id = w.id) AS chunks "
                "FROM workspaces w LEFT JOIN files f ON f.workspace_id = w.id AND f.trashed_at IS NULL GROUP BY 1, 2 ORDER BY 4 DESC, 2"
            )
            workspaces = [dict(r) for r in await cur.fetchall()]
        quality = sorted(p.name for p in (LOCAL / "quality").glob(f"{target}-*.json"))
        return {
            "target": target,
            "configs": sorted(p.stem for p in CONFIGS.glob("*.json")),
            "defaults": DEFAULT_CONFIG,
            "models": models,
            "workspaces": workspaces,
            "library": await library_summary(),
            "quality_files": quality,
            "runs": sorted(
                (p.name for p in RUNS.glob("*/run.json") for p in [p.parent]),
                reverse=True,
            )[:200],
        }

    @app.get("/api/workspaces/{workspace_id}/files")
    async def files(workspace_id: str):
        outline = await store.workspace_outline(workspace_id)
        return [
            {
                "id": f["id"],
                "name": f["name"],
                "chunks": f["chunks"],
                "status": f["status"],
            }
            for f in outline["files"]
        ]

    @app.get("/api/configs/{name}")
    def get_config(name: str):
        path = CONFIGS / f"{name}.json"
        if not path.exists():
            raise HTTPException(404)
        return {
            "raw": json.loads(path.read_text(encoding="utf-8")),
            "effective": load_config(name),
        }

    @app.put("/api/configs/{name}")
    async def put_config(name: str, request: Request):
        if not name.replace("-", "").replace("_", "").isalnum():
            raise HTTPException(400, "config names are letters, digits, - and _")
        raw = await request.json()
        merged(raw)
        (CONFIGS / f"{name}.json").write_text(
            json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return {"saved": name}

    @app.post("/api/openui")
    async def openui_tree(request: Request):
        """An answer as a tree the page can draw: each component call with its
        props named, refs left for the page to resolve."""
        from pipeline.retrieval import openui

        text = str((await request.json()).get("text") or "")
        if not openui.is_lang_shaped(text):
            return {"markdown": text}
        body = re.sub(r"^\s*```[\w-]*\s*\n|\n?```\s*$", "", text)
        try:
            program = openui.parse(body, strict=True)
        except openui.ParseError as exc:
            return {"error": str(exc)}

        def plain(value):
            if isinstance(value, openui.Call):
                names = openui.COMPONENTS.get(value.name, [])
                return {
                    "$": value.name,
                    "props": {
                        (names[i] if i < len(names) else f"arg{i}"): plain(arg)
                        for i, arg in enumerate(value.args)
                    },
                }
            if isinstance(value, openui.Ref):
                return {"ref": value.name}
            if isinstance(value, list):
                return [plain(item) for item in value]
            return value

        return {
            "root": openui.ROOT,
            "statements": {k: plain(v) for k, v in program.statements.items()},
        }

    @app.post("/api/prompt")
    async def prompt(request: Request):
        """The two layers a turn sends: the system prompt and the tools array."""
        from pipeline.retrieval import contract, tools

        c = merged(await request.json())
        ctx = tools.ToolContext(
            workspace_id=c["workspace_id"],
            user_id="playground",
            library=c["library"],
            operations=operations_for(c),
        )
        if c["library"]:
            # The pinned version's topic catalog rides in the knowledge tool
            # descriptions, so this reads the library exactly as a turn does;
            # like a turn, a bank that is down leaves its tools out.
            await tools.load_library_catalog(ctx)
            try:
                await tools.load_bank_catalog(ctx)
            except Exception as exc:
                print(f"question bank unavailable for the preview: {exc}", flush=True)
        return {
            "prompt": effective_prompt(
                c, production_prompt(c["locale"]), with_library=False
            ),
            "library_rules": chat_prompts.LIBRARY_RULES,
            "full_prompt": effective_prompt(c, production_prompt(c["locale"])),
            "tools": turn_tools(c, production_schemas(ctx)),
            "skills": skill_texts(c, library=ctx.library),
            "tool_prompts": {
                s["function"]["name"]: tool_prompt(s["function"])
                for s in turn_tools({**c, "tool_descriptions": {}}, production_schemas(ctx))
            },
        }

    @app.post("/api/turn")
    async def turn(request: Request):
        await reconnect()
        body = await request.json()
        config = {**merged(body["config"]), "target": target}
        try:
            spec = model_spec(config["model"])
            if spec.resolve_thinking(config["model"]["thinking"]) in ("", "instant"):
                raise registry.RegistryError("Chat requires thinking to be enabled.")
        except registry.RegistryError as exc:
            raise HTTPException(400, str(exc)) from exc

        async def relay():
            async with turn_lock:
                run = Turn(
                    config,
                    body["question"],
                    body.get("history") or [],
                    resolver,
                    body.get("checkpoint"),
                    body.get("ledger"),
                )
                async for event in run.events():
                    yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

        return StreamingResponse(relay(), media_type="text/event-stream")

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str):
        path = RUNS / run_id / "run.json"
        if not path.exists():
            raise HTTPException(404)
        return FileResponse(path)

    @app.get("/api/runs/{run_id}/materials/{name}")
    def get_material_file(run_id: str, name: str):
        path = RUNS / run_id / "materials" / name
        if path.parent.parent.parent != RUNS or not path.exists():
            raise HTTPException(404)
        return FileResponse(path, filename=name)

    @app.get("/api/runs/{run_id}/captures/{name}")
    def get_capture(run_id: str, name: str):
        path = RUNS / run_id / "captures" / name
        if not path.exists():
            raise HTTPException(404)
        return FileResponse(path)

    @app.get("/api/page")
    async def page(file_id: str, page: int, bbox: str | None = None):
        import capture

        box = [float(v) for v in bbox.split(",")] if bbox else None
        try:
            jpeg, _ = capture.render(await resolver.path(file_id), page, box, 1400)
        except (KeyError, ValueError) as exc:
            raise HTTPException(404, str(exc)) from exc
        return Response(jpeg, media_type="image/jpeg")

    return app


def check_decks() -> None:
    """Outline, slide checks, figures, export and the ledger rules, through the
    local handler. Runs ppt-master's checker and exporter (cloned on first use)."""
    from tempfile import TemporaryDirectory

    from pipeline.retrieval import skills, tools

    deck.ensure_ppt_master()

    def slide(body: str = '<text x="64" y="300">A tangent meets the radius at 90°.</text>', bounds: str = "64 260 1152 60", lang: str = "en-GB") -> str:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" lang="{lang}" '
            'data-pptx-page-role="content" font-family="Arial" font-size="20">'
            '<rect id="background" data-pptx-role="background" x="0" y="0" width="1280" height="720" fill="#FAF8F4"/>'
            f'<g id="body" data-pptx-bounds="{bounds}" fill="#1C1C1A">{body}</g></svg>'
        )

    async def flow(run_dir: Path) -> None:
        ctx = tools.ToolContext(workspace_id="ws", user_id="u", operations=BUILD_OPERATIONS)
        state = {"materials": [], "captures": [], "run_dir": run_dir}
        outline = {
            "title": "Tangents",
            "slides": [
                {"title": "Tangent meets radius", "brief": "From: tangents are lines. To: the radius meets one at 90°."},
                {"title": "Two tangents", "brief": "Contrast the rule TA = TB with why it holds (RHS)."},
            ],
            "_tool_call_id": "c1",
        }
        made = await deck_locally("create_deck", outline, ctx, state, "m1")
        assert not made.refused, made.text()
        record = state["materials"][0]
        rid = record["id"]
        assert "1. Tangent meets radius (to write)" in made.text()
        assert "Reference slide toc" in skills.SKILLS[skills.DECK].text(False)
        long = '<text x="64" y="300">' + "far too long for this box " * 8 + "</text>"
        for args, says in (
            ({"slide": 1, "svg": "<svg"}, "does not parse"),
            ({"slide": 1, "svg": slide().replace('viewBox="0 0 1280 720"', 'viewBox="0 0 800 600"')}, "viewBox must be"),
            ({"slide": 1, "svg": slide(lang="")}, "needs lang"),
            ({"slide": 1, "svg": slide(body=long, bounds="64 260 300 60")}, "refused by the checker"),
            ({"slide": 1, "svg": slide(body='<image href="../images/p13.jpg" x="64" y="260" width="40" height="30"/>')}, "was not captured"),
            ({"slide": 9, "svg": slide()}, "the deck has 2 slides"),
        ):
            refused = await deck_locally("write_slide", {"deck_id": rid, **args}, ctx, state, "m1")
            assert refused.refused and says in refused.text(), refused.text()
        first = await deck_locally("write_slide", {"deck_id": rid, "slide": 1, "svg": slide()}, ctx, state, "m1")
        assert not first.refused and "1. Tangent meets radius (written)" in first.text(), first.text()
        assert "pptx" not in record and record["size"] == "1 of 2 slides written"
        # Figures are captured pages, cropped to the figure.
        from PIL import Image

        image = run_dir / "captures" / "1.jpg"
        image.parent.mkdir(parents=True)
        Image.new("RGB", (40, 30), "white").save(image)
        for page, bbox in ((12, [0, 0, 1000, 1000]), (14, [100, 200, 600, 700])):
            state["captures"].append(
                {"page": page, "bbox": bbox, "image": str(image.relative_to(run_dir.parent.parent))}
            )
        figure = '<image href="../images/p{}.jpg" x="64" y="260" width="40" height="30" preserveAspectRatio="xMidYMid meet"/>'
        whole = await deck_locally("write_slide", {"deck_id": rid, "slide": 2, "svg": slide(body=figure.format(12))}, ctx, state, "m1")
        assert whole.refused and "captured whole" in whole.text(), whole.text()
        done = await deck_locally("write_slide", {"deck_id": rid, "slide": 2, "svg": slide(body=figure.format(14))}, ctx, state, "m1")
        assert not done.refused and "the deck is exported" in done.text(), done.text()
        assert (run_dir.parent.parent / record["pptx"]).stat().st_size > 10_000
        assert (run_dir / "materials" / rid / "images" / "p14.jpg").exists()
        # The exported PPTX is the document from now on.
        again = await deck_locally("write_slide", {"deck_id": rid, "slide": 1, "svg": slide()}, ctx, state, "m1")
        assert again.refused and "now the document" in again.text(), again.text()
        # With todos open, a deck write names one, like any material write.
        await tools._create_ledger({"todos": ["deck", "quiz"]}, ctx)
        needs = await deck_locally("create_deck", {**outline, "_tool_call_id": "c2"}, ctx, state, "m1")
        assert needs.refused and "needs todo" in needs.text()
        bad_args = await deck_locally("create_deck", {"title": "x", "slides": []}, ctx, state, "m1")
        assert bad_args.refused and "arguments invalid" in bad_args.text()

    with TemporaryDirectory() as tmp:
        asyncio.run(flow(Path(tmp) / "runs" / "r1"))


def check_copy() -> None:
    """copy_questions into a new quiz and a run's quiz, its refusals, and no
    excerpt rule for copied bank questions."""
    from tempfile import TemporaryDirectory
    from unittest.mock import patch

    from pipeline.retrieval import tools

    async def read(qid: str):
        if not qid.startswith("q"):
            return None
        question = {"id": qid, "stem": [], "parts": [{"id": f"{qid}-p", "blocks": [{"type": "text", "text": "Q"}], "marks": 1}]}
        return {"id": qid, "question": question, "sources": [{"kind": "web", "title": "S"}]}

    async def flow(run_dir: Path) -> None:
        ctx = tools.ToolContext(workspace_id="ws", user_id="u", operations=BUILD_OPERATIONS)
        ctx.ledger.note_read("exc_1", 0, "1.1")  # a library read does not ask copies for excerpts
        state = {"materials": [], "captures": [], "run_dir": run_dir}
        for args, says in (
            ({"question_ids": ["q1"]}, "exactly one destination"),
            ({"question_ids": ["q1"], "title": "T", "quiz_id": "x"}, "exactly one destination"),
            ({"question_ids": ["q1"], "quiz_id": "x", "chapter_id": "c"}, "goes with title"),
            ({"question_ids": ["q1", "nope"], "title": "T"}, "not in the bank"),
            ({"question_ids": ["q1"], "quiz_id": "mat_x"}, "not a quiz in this workspace"),
        ):
            refused = await copy_locally(args, ctx, state, "m1")
            assert refused.refused and says in refused.text(), refused.text()
        made = await copy_locally({"question_ids": ["q1", "q2"], "title": "IELTS reading", "_tool_call_id": "c1"}, ctx, state, "m1")
        assert not made.refused, made.text()
        quiz = state["materials"][-1]
        assert [q["id"] for q in quiz["questions"]] == ["q1", "q2"]
        assert set(quiz["provenance"]["questions"]) == {"q1", "q2"}
        more = await copy_locally({"question_ids": ["q3"], "quiz_id": quiz["id"]}, ctx, state, "m1")
        assert not more.refused and len(quiz["questions"]) == 3 and "q3" in quiz["provenance"]["questions"]
        await tools._create_ledger({"todos": ["quiz"]}, ctx)
        needs = await copy_locally({"question_ids": ["q5"], "title": "T2"}, ctx, state, "m1")
        assert needs.refused and "needs todo" in needs.text()

    with TemporaryDirectory() as tmp, patch.object(bank_local, "read", new=read):
        asyncio.run(flow(Path(tmp) / "runs" / "r1"))


def check() -> None:
    assert merged({"search": {"top_k": 3}})["search"] == {
        **DEFAULT_CONFIG["search"],
        "top_k": 3,
    }
    assert merged({"system_prompt": "x"})["system_prompt"] == "x"
    schemas = [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": "production" + catalog,
                "parameters": {"type": "object", "properties": {}},
            },
        }
        for name, catalog in (
            ("search_knowledge", ""),
            ("browse_knowledge", SUBJECT_CATALOG + "math: Mathematics (10 excerpts)"),
        )
    ]
    config = merged(
        {
            "tool_descriptions": {
                "search_knowledge": "custom search",
                "browse_knowledge": "custom browse",
            }
        }
    )
    customized = configured_tools(config, schemas)
    assert customized[0]["function"]["description"] == "custom search"
    assert customized[1]["function"]["description"] == (
        "custom browse" + SUBJECT_CATALOG + "math: Mathematics (10 excerpts)"
    )
    assert (
        customized[1]["function"]["parameters"] == schemas[1]["function"]["parameters"]
    )
    assert tool_prompt(schemas[1]["function"]) == "production"
    assert schemas[0]["function"]["description"] == "production"
    assert configured_tools(merged({}), schemas) == schemas
    for invalid in (None, [], {"unknown": "x"}, {"search_knowledge": 1}):
        try:
            merged({"tool_descriptions": invalid})
        except HTTPException as exc:
            assert exc.status_code == 400
        else:
            raise AssertionError(f"accepted invalid tool_descriptions: {invalid}")
    # A skill's text replaces only that skill; deck is a skill only with decks on.
    from pipeline.retrieval import skills

    edited = merged({"skills": {"workspace_building": "my building"}})
    assert skill_text(edited, "workspace_building", library=True) == "my building"
    assert skill_text(edited, "editing", library=True) != "my building"
    assert skill_text(edited, "deck", library=True) == skills.SKILLS["deck"].text(True)
    assert skill_text(merged({"decks": {"offer": False}}), "deck", library=True) is None
    assert "Practice from the library" not in skill_text(
        merged({}), "workspace_building", library=False
    )
    for invalid in (None, {"unknown": "x"}, {"workspace_building": 1}):
        try:
            merged({"skills": invalid})
        except HTTPException as exc:
            assert exc.status_code == 400
        else:
            raise AssertionError(f"accepted invalid skills: {invalid}")
    # Note fences: flashcards and html-embed are checked here, quizzes by Go.
    note = "```flashcards\ncards:\n- front: a\n  back: b\n```\n"
    embed = "```html-embed\ntitle: t\nhtml: |\n  <p>x</p>\n```\n"
    assert asyncio.run(check_note("text\n" + note + embed + "```mermaid\nflowchart\n```\n")) == ""
    for bad, says in (
        ("```flashcards\ncards: []\n```\n", "non-empty cards"),
        ("```flashcards\ncards:\n- front: a\n```\n", "front and a back"),
        ("```html-embed\ntitle: t\n```\n", "needs html"),
        ("```html-embed\nhtml: <img src='https://x'>\n```\n", "network"),
        ("```html-embed\n: [\n```\n", "not YAML"),
    ):
        assert says in asyncio.run(check_note(bad)), bad
    check_decks()
    check_copy()
    # Preview requests must not inherit the monkeypatches of an active turn.
    from tempfile import TemporaryDirectory
    from unittest.mock import AsyncMock, patch

    import httpx

    from pipeline import registry
    from pipeline.prompts import chat
    from pipeline.retrieval import agent, evidence, tools

    async def check_preview():
        app = build_app("local")
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://playground"
        ) as client:
            with patch.object(
                registry.registry,
                "get",
                side_effect=registry.RegistryError(
                    "model config not found: missing v1"
                ),
            ):
                response = await client.post(
                    "/api/turn",
                    json={
                        "config": {"target": "local"},
                        "question": "Summarize the PDF",
                    },
                )
            assert response.status_code == 400
            assert response.json() == {"detail": "model config not found: missing v1"}
            for mode in (False, True):
                c = merged({"library": mode})
                expected = effective_prompt(c, with_library=False)
                with (
                    patch.object(chat, "system_prompt", return_value="active turn"),
                    patch.object(tools, "load_library_catalog", new=AsyncMock()),
                    patch.object(tools, "load_bank_catalog", new=AsyncMock()),
                ):
                    response = await client.post("/api/prompt", json=c)
                assert response.status_code == 200
                assert response.json()["prompt"] == expected
                names = [s["function"]["name"] for s in response.json()["tools"]]
                assert names.count("capture_page") == 1
            stored = {
                "next_todo_id": 2,
                "todos": [{"id": 1, "text": "Make a quiz"}],
            }
            history = [
                {
                    "id": "m2",
                    "role": "assistant",
                    "content": "Created the note.",
                    "toolEvidence": {
                        "tools": [
                            {"name": "create_material", "text": "Created note mat_1"}
                        ],
                        "passages": [],
                    },
                }
            ]
            checkpoint = {"summary": "Earlier study goals", "throughMessageId": "m0"}

            async def continued_agent(**kw):
                names = [s["function"]["name"] for s in tools.schemas_for(kw["ctx"])]
                assert names.count("capture_page") == 1
                listed = await tools.run("list_sources", {}, kw["ctx"])
                assert listed.text_parts == ["Local workspace sources"]
                assert kw["ctx"].ledger.stored() == stored
                assert not kw["ctx"].ledger.reads
                assert kw["history"] == history
                assert kw["checkpoint"] == checkpoint
                replayed = await evidence.history_turns(kw["history"], kw["ctx"])
                assert "Created note mat_1" in replayed[-1]["content"]
                assert tools.mutates("create_ledger")
                # As if the turn had read the editing skill, which the ledger needs.
                kw["ctx"].skills_read = {"editing"}
                updated = await tools.run(
                    "create_ledger",
                    {
                        "todos": [{"id": 1, "todo": "Advanced quiz"}],
                        "_tool_call_id": "revise",
                    },
                    kw["ctx"],
                )
                assert updated.outcome == "succeeded"
                yield {"type": "done", "answer": "Continued."}

            c = merged(
                {
                    "target": "local",
                    "library": True,
                    "tools": ["create_ledger", "capture_page", "list_sources"],
                    "model": {"adhoc": {"provider_name": "test"}},
                }
            )
            with (
                TemporaryDirectory() as directory,
                patch.dict(globals(), RUNS=Path(directory)),
                patch.dict(
                    globals(),
                    list_sources_locally=AsyncMock(
                        return_value=tools._result("Local workspace sources")
                    ),
                ),
                patch.object(agent, "run_agent", continued_agent),
                patch.object(tools.library, "enabled", return_value=True),
            ):
                response = await client.post(
                    "/api/turn",
                    json={
                        "config": c,
                        "question": "Continue",
                        "history": history,
                        "checkpoint": checkpoint,
                        "ledger": stored,
                    },
                )
                assert response.status_code == 200
                assert '"answer": "Continued."' in response.text
                saved = json.loads(next(Path(directory).glob("*/run.json")).read_text())
                assert saved["ledger_in"] == stored
                assert saved["ledger"]["stored"] == {
                    **stored,
                    "todos": [{"id": 1, "text": "Advanced quiz"}],
                }
        bare = merged(
            {
                "library": False,
                "system_prompt": "",
                "capture": {"addon": False},
                "decks": {"offer": False},
            }
        )
        assert effective_prompt(bare, "production") == ""
        decks = merged(
            {"library": False, "system_prompt": "", "capture": {"addon": False}}
        )
        # The main explainer format reaches the model with the study
        # preferences in the turn context, not the system prompt.
        assert effective_prompt(decks, "production") == ""
        # The library rules sit before the answer format, as production puts
        # them, whether they or the rest of the prompt were edited.
        assert effective_prompt(merged({}), chat.system_prompt("en")).replace(
            "\n\n" + chat.LANG_RULE, ""
        ).startswith(chat.system_prompt("en", library=True).split("\n\n" + chat.LANG_RULE)[0])
        lib = merged({"library_rules": "MY RULES", "tools": []})
        assert effective_prompt(lib, "base\n\n" + chat.LANG_RULE) == (
            "base\n\nMY RULES\n\n" + chat.LANG_RULE
        )
        assert effective_prompt({**lib, "system_prompt": "mine"}, "x") == "mine\n\nMY RULES"
        assert effective_prompt(lib, "base", with_library=False) == "base"

    asyncio.run(check_preview())
    assert (
        material_id("m_1", "call_1")
        == material_id("m_1", "call_1")
        != material_id("m_1", "call_2")
    )
    for path in CONFIGS.glob("*.json"):
        c = merged(json.loads(path.read_text(encoding="utf-8")))
        assert c["capture"]["mode"] in (
            "pixels",
            "ocr",
            "caption",
        ), path
        assert c["answer"]["citations"] in ("as_is", "renumber", "structured"), path
        assert c["capture"]["citation"] in ("page", "new"), path
        assert isinstance(c["library"], bool), path
        assert c["ledger"] is None or isinstance(c["ledger"], str), path
    print("playground checks passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=sorted(TARGETS), default="lab")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--ledger",
        help="start turns from this stored ledger (a previous run.json), "
        "for configs that do not set `ledger` themselves",
    )
    args = parser.parse_args()
    if args.check:
        check()
        return
    if args.ledger:
        DEFAULT_CONFIG["ledger"] = args.ledger
    dsn = prepare_environment(args.target)
    sys.path.insert(0, str(REPO / "pipeline"))
    import uvicorn

    from pipeline import registry

    registry.registry.start()
    print(
        f"target={args.target} dsn={dsn.split('@')[-1]} http://127.0.0.1:{args.port}",
        flush=True,
    )
    if sys.platform == "win32":
        # psycopg's async pool refuses the Proactor loop that uvicorn installs on
        # Windows, so serve on a selector loop of our own.
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    config = uvicorn.Config(
        build_app(args.target),
        host="127.0.0.1",
        port=args.port,
        log_level="warning",
        loop="none",
    )
    asyncio.run(uvicorn.Server(config).serve())


if __name__ == "__main__":
    main()
