"""Optional source-page capability for the isolated ODL agent benchmark.

Install around ONE run_turn, before its render/prompt observers are captured.
The caller pins captioning and installs the existing recorded lab transport.
No index writes, question-aware captions, automatic pages, or timeout changes.
Wholly absent pages cannot pass the observed indexed-citation guard.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import tempfile
import time
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path

TOOL_NAME = "read_source_page"
MAX_PAGE_ATTEMPTS = 3
CHUNK_PREFIX = "source-page:"
PROMPT_ADDON = (
    "\n- When indexed evidence leaves a table, figure, formula, or list relationship "
    "unclear, you may call read_source_page using a file_id and 1-based PDF page "
    "already shown in a retrieved passage's page range. It describes that entire "
    "source page from its image. You have at most three page attempts this turn, "
    "within the existing overall tool budget. This is a model-generated visual "
    "description and can omit or misread dense content. Check its labels and "
    "associations against the indexed evidence, preserve stated uncertainty, and "
    "cite only what the returned evidence supports. Source-page passages have "
    "page locators, not read_document chunk starts. Do not guess unseen pages."
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")


def generation_identity():
    import pymupdf
    from pipeline.parse import figures
    from pipeline.prompts.captioning import IMAGE_PROMPT
    from pipeline.retrieval import models

    from pipeline import elitellm, registry

    spec = registry.captioning_spec()
    return json.loads(
        canonical(
            {
                "model": asdict(spec),
                "thinking": elitellm.resolve_thinking(spec, reasoning=False),
                "enable_thinking": False,
                "endpoint": os.environ["ODL_QWEN_CHAT_URL"],
                "prompt_sha256": digest(IMAGE_PROMPT.encode()),
                "encoder_sha256": digest(Path(figures.__file__).read_bytes()),
                "caption_max_edge": figures.cfg.caption_max_edge,
                "renderer": {
                    "pymupdf": pymupdf.VersionBind,
                    "scale": 2,
                    "alpha": False,
                },
                "retry_policy": asdict(models.retry_policy()),
            }
        )
    )


def render_page(entry, page):
    """Hash the exact bytes opened, then use the production image encoder."""
    import pymupdf
    from pipeline.parse.figures import _encode

    raw = Path(entry["pdf"]).read_bytes()
    if digest(raw) != entry["pdf_sha256"]:
        raise ValueError("Coordinate PDF hash differs from frozen source")
    with pymupdf.open(stream=raw, filetype="pdf") as document:
        if len(document) != entry["pages"]:
            raise ValueError("Coordinate PDF page count differs from frozen source")
        png = (
            document[page - 1]
            .get_pixmap(
                matrix=pymupdf.Matrix(2, 2), colorspace=pymupdf.csRGB, alpha=False
            )
            .tobytes("png")
        )
    with tempfile.TemporaryDirectory(prefix="odl-page-") as folder:
        path = Path(folder) / "page.png"
        path.write_bytes(png)
        data_url = _encode(path)
    if not data_url:
        raise ValueError("Source page could not be encoded")
    jpeg = base64.b64decode(data_url.split(",", 1)[1], validate=True)
    return png, jpeg, data_url


async def current_source(workspace_id, file_id):
    from pipeline.retrieval import store

    pool = await store.pool()
    async with pool.connection() as conn:
        cursor = await conn.execute(
            "SELECT source_sha256, name, status FROM files "
            "WHERE id=%s AND workspace_id=%s",
            (file_id, workspace_id),
        )
        return await cursor.fetchone()


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temp_path = Path(temporary.name)
        temporary.write(data)
    try:
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)


@contextmanager
def page_evidence(workspace, corpus_entries, cache_dir):
    """Yield auditable state; restore tool, renderer and prompt on every exit.

    workspace: {workspace_id, files: {logical_source_id: actual_file_id}}
    entries: {id, pdf, pdf_sha256, source_sha256, pages}, no question data.
    cache_dir: isolated local benchmark cache shared across matched arms.
    The runner must validate its indexed corpus first. Database source hashes
    and scope are additionally checked on every page request.
    """
    from odl_agentic_runtime import recording_context
    from pipeline.prompts import chat as chat_prompts
    from pipeline.prompts.captioning import DECORATIVE, IMAGE_PROMPT
    from pipeline.retrieval import models, tools
    from pipeline.retrieval.search import Passage

    if TOOL_NAME in tools.REGISTRY:
        raise ValueError("Source-page tool is already installed")
    entries = {}
    for entry in corpus_entries:
        sid = entry["id"]
        if sid in entries:
            raise ValueError("Duplicate logical source id")
        entries[sid] = {
            k: entry[k] for k in ("id", "pdf", "pdf_sha256", "source_sha256", "pages")
        }
        if type(entry["pages"]) is not int or entry["pages"] < 1:
            raise ValueError("Invalid frozen page count")
        for key in ("pdf_sha256", "source_sha256"):
            value = entry[key]
            if (
                not isinstance(value, str)
                or len(value) != 64
                or any(c not in "0123456789abcdef" for c in value)
            ):
                raise ValueError("Invalid frozen source hash")
    files = workspace["files"]
    if len(set(files.values())) != len(files) or not set(files) <= entries.keys():
        raise ValueError("Ambiguous or incomplete workspace source mapping")
    by_file = {fid: entries[sid] for sid, fid in files.items()}
    generation = generation_identity()
    cache_dir = Path(cache_dir)
    state = {
        "attempts": 0,
        "limit": MAX_PAGE_ATTEMPTS,
        "generation": generation,
        "receipts": [],
        "observed_indexed_ranges": [],
    }
    observed_ranges = set()
    locks = {}
    installed_ctx = None

    async def handler(args, ctx):
        nonlocal installed_ctx
        receipt = {
            "sequence": len(state["receipts"]),
            "file_id": args.get("file_id"),
            "page": args.get("page"),
            "tool_call_id": args.get("_tool_call_id"),
        }
        state["receipts"].append(receipt)
        started = time.perf_counter()

        def refuse(reason):
            receipt.update(outcome="refused", reason=reason)
            return tools.ToolResult(error=reason, refused=True)

        try:
            if installed_ctx is not None and installed_ctx is not ctx:
                return refuse("Source-page context must be installed once per turn")
            installed_ctx = ctx
            if state["attempts"] >= MAX_PAGE_ATTEMPTS:
                return refuse("Source-page attempt limit reached")
            state["attempts"] += 1
            if ctx.workspace_id != workspace["workspace_id"]:
                return refuse("Source-page workspace does not match")
            if set(args) - {"file_id", "page", "_tool_call_id"}:
                return refuse("Only file_id and page are accepted")
            fid, page = args.get("file_id"), args.get("page")
            if not isinstance(fid, str) or fid not in by_file:
                return refuse("Source-page file is unavailable")
            entry = by_file[fid]
            if type(page) is not int or not 1 <= page <= entry["pages"]:
                return refuse("Page must be a 1-based PDF page within the file")
            scope = await tools._resolve_scope(ctx, {"file_ids": [fid]})
            if isinstance(scope, tools.ToolResult):
                return refuse("Source-page file is outside the current source scope")
            if not any(
                p.file_id == fid
                and not p.chunk_id.startswith(CHUNK_PREFIX)
                and p.page_start is not None
                and p.page_start <= page <= (p.page_end or p.page_start)
                for p in ctx.citations
            ):
                return refuse("Retrieve an indexed passage identifying this page first")
            if not any(
                file_id == fid and start <= page <= end
                for file_id, start, end in observed_ranges
            ):
                return refuse(
                    "The indexed page locator was not visible in a tool result"
                )
            await ctx.pending_sources.validate()
            if ctx.pending_sources.files:
                return refuse(
                    "Source-page benchmark requires unchanged source snapshots"
                )
            source = await current_source(ctx.workspace_id, fid)
            if (
                not source
                or source["source_sha256"] != entry["source_sha256"]
                or source["status"] != "ready"
            ):
                return refuse("Current file does not match the frozen source")
            if generation_identity() != generation:
                return refuse("Caption generation settings changed during the turn")
            # Keep PyMuPDF on this one thread; the subsequent provider calls
            # still use the agent's existing concurrent read-tool execution.
            png, jpeg, data_url = render_page(entry, page)
            identity = {
                "generation": generation,
                "png_sha256": digest(png),
                "image_sha256": digest(jpeg),
            }
            key = digest(canonical(identity))
            receipt.update(
                source_id=entry["id"],
                pdf_sha256=entry["pdf_sha256"],
                source_sha256=entry["source_sha256"],
                cache_key=key,
                **identity,
            )
            # ponytail: this runner executes turns sequentially; per-key locks
            # deduplicate simultaneous calls within the current turn only.
            async with locks.setdefault(key, asyncio.Lock()):
                path = cache_dir / f"{key}.json"
                if path.exists():
                    cached = json.loads(path.read_text(encoding="utf-8"))
                    text = cached["text"]
                    if (
                        cached["identity"] != identity
                        or not text.strip()
                        or text.strip() == DECORATIVE
                        or cached["text_sha256"] != digest(text.encode())
                        or digest(path.with_suffix(".png").read_bytes()) != digest(png)
                        or digest(path.with_suffix(".jpg").read_bytes()) != digest(jpeg)
                    ):
                        raise ValueError("Source-page cache provenance mismatch")
                    receipt["cache_hit"] = True
                else:
                    receipt["cache_hit"] = False
                    with recording_context(
                        phase="source_page",
                        source_id=entry["id"],
                        file_id=fid,
                        pdf_sha256=entry["pdf_sha256"],
                        page=page,
                        cache_key=key,
                    ):
                        text = await models.caption_image(data_url, IMAGE_PROMPT)
                    if not text or not text.strip() or text.strip() == DECORATIVE:
                        receipt.update(outcome="empty_provider_result")
                        return tools.ToolResult(
                            error="Source page returned no usable visual description; "
                            "the source content remains uncertain.",
                            refused=True,
                        )
                    text = text.strip()
                    atomic_write(path.with_suffix(".png"), png)
                    atomic_write(path.with_suffix(".jpg"), jpeg)
                    atomic_write(
                        path,
                        canonical(
                            {
                                "identity": identity,
                                "text": text,
                                "text_sha256": digest(text.encode()),
                            }
                        ),
                    )
            passage = Passage(
                chunk_id=f"{CHUNK_PREFIX}{fid}:{entry['pdf_sha256']}:{page}:{key}",
                file_id=fid,
                file_name=source["name"],
                chunk_idx=-1,
                section_path="Source page visual description",
                text=text,
                hit_text=text,
                page_start=page,
                page_end=page,
                regions=[{"page": page, "bbox": [0, 0, 1000, 1000]}],
            )
            receipt.update(
                outcome="described",
                chunk_id=passage.chunk_id,
                text_sha256=digest(text.encode()),
            )
            return tools.ToolResult(
                passages=[passage],
                text_parts=[
                    (
                        "Model-generated description of the entire source page. It may "
                        "omit or misread content; uncertainty is not evidence of absence."
                    )
                ],
            )
        except BaseException as exc:
            receipt.update(
                outcome="error", error_class=type(exc).__name__, error=str(exc)
            )
            raise
        finally:
            receipt["elapsed_seconds"] = time.perf_counter() - started

    original_render = tools.render_result
    original_prompt = chat_prompts.system_prompt

    def render(result, numbered):
        if not numbered or not all(
            p.chunk_id.startswith(CHUNK_PREFIX) for _, p in numbered
        ):
            text = original_render(result, numbered)
            visible = tools.limit_tool_result(text)
            offset = 0
            for number, passage in numbered:
                header = f"[{number}] {passage.location()}"
                if result.paged:
                    header += f" (chunk {passage.chunk_idx})"
                block = header + "\n" + passage.text
                # Follow the real renderer's ordered blocks, not header-like
                # strings in document text. Unrecognized layouts abstain.
                if not text.startswith(block, offset):
                    break
                end = offset + len(header) + 1
                if (
                    not passage.chunk_id.startswith(CHUNK_PREFIX)
                    and passage.page_start is not None
                    and visible.startswith(text[:end])
                ):
                    key = (
                        passage.file_id,
                        passage.page_start,
                        passage.page_end or passage.page_start,
                    )
                    if key not in observed_ranges:
                        observed_ranges.add(key)
                        state["observed_indexed_ranges"].append(
                            {
                                "file_id": key[0],
                                "page_start": key[1],
                                "page_end": key[2],
                            }
                        )
                offset += len(block) + 2
            return text
        locators = "\n".join(
            f"[{n}] file_id={p.file_id}, page={p.page_start}" for n, p in numbered
        )
        return "\n\n".join(
            [
                "Locations for read_source_page:\n" + locators,
                *[p.as_context(n) for n, p in numbered],
                *result.text_parts,
            ]
        )

    schema = tools._schema(
        TOOL_NAME,
        "Describe one complete source PDF page as a model-generated visual record. "
        "Use only a file_id and 1-based PDF page already present in an indexed "
        "passage's page range. Maximum three attempts per turn. Dense content "
        "may be unreadable. No question-specific prompt or crop is accepted.",
        {
            "type": "object",
            "properties": {
                "file_id": {"type": "string"},
                "page": {"type": "integer", "minimum": 1},
            },
            "required": ["file_id", "page"],
            "additionalProperties": False,
        },
    )
    try:
        tools.REGISTRY[TOOL_NAME] = tools.ToolSpec(
            TOOL_NAME, schema, handler, False, False, "read"
        )
        tools.render_result = render
        chat_prompts.system_prompt = lambda locale: (
            original_prompt(locale) + PROMPT_ADDON
        )
        yield state
    finally:
        tools.REGISTRY.pop(TOOL_NAME, None)
        tools.render_result = original_render
        chat_prompts.system_prompt = original_prompt


async def check():
    """Exercise real rendering, tool scope and citations; mock only DB/provider."""
    import io
    import sys
    from unittest.mock import AsyncMock, patch

    import pymupdf
    from odl_agentic_runtime import _context, model_config, recording_context
    from PIL import Image
    from pipeline.prompts import chat as chat_prompts
    from pipeline.prompts.captioning import IMAGE_PROMPT
    from pipeline.retrieval import agent, models, tools
    from pipeline.retrieval.limits import TurnBudget
    from pipeline.retrieval.search import Passage
    from pipeline.retrieval.stream import ToolCall

    from pipeline import registry

    originals = dict(tools.REGISTRY), tools.render_result, chat_prompts.system_prompt
    previous_pins = registry.current_job_pins()
    provider_inputs = []

    async def describe(url, prompt):
        assert prompt == IMAGE_PROMPT
        assert _context.get()["question_id"] == "provider-free-check"
        assert _context.get()["phase"] == "source_page"
        provider_inputs.append((url, prompt))
        await asyncio.sleep(0)
        return "Column A: label. Column B: 42."

    with (
        tempfile.TemporaryDirectory() as folder,
        patch.dict(
            os.environ,
            {
                "ODL_QWEN_CONTEXT_TOKENS": "65536",
                "ODL_QWEN_MAX_OUTPUT_TOKENS": "8192",
                "ODL_QWEN_CHAT_URL": "https://example.invalid/chat/completions",
            },
        ),
    ):
        root = Path(folder)
        pdf = root / "source.pdf"
        with pymupdf.open() as doc:
            for label in ("Table: label | 42", "Page two"):
                doc.new_page().insert_text((30, 30), label)
            doc.save(pdf)
        source_hash = digest(pdf.read_bytes())
        entry = {
            "id": "synthetic",
            "pdf": str(pdf),
            "pdf_sha256": source_hash,
            "source_sha256": source_hash,
            "pages": 2,
        }
        workspace = {"workspace_id": "workspace", "files": {"synthetic": "file"}}

        def context():
            return tools.ToolContext(
                workspace_id="workspace",
                citations=[
                    Passage(
                        "indexed",
                        "file",
                        "source.pdf",
                        7,
                        "",
                        "indexed hit",
                        page_start=1,
                        page_end=1,
                    )
                ],
                _scope_outline={
                    "files": [{"id": "file", "chunks": 1, "name": "source.pdf"}],
                    "chapters": [],
                },
            )

        def show(ctx, *, paged=False):
            return tools.limit_tool_result(
                tools.render_result(
                    tools.ToolResult(
                        passages=ctx.citations, paged=paged, text_parts=["end"]
                    ),
                    list(enumerate(ctx.citations, 1)),
                )
            )

        source = AsyncMock(
            return_value={
                "source_sha256": source_hash,
                "name": "source.pdf",
                "status": "ready",
            }
        )
        registry.set_job_pins(registry.JobPins(captioning=model_config()))
        try:
            with (
                patch.object(sys.modules[__name__], "current_source", source),
                patch.object(models, "caption_image", describe),
                recording_context(question_id="provider-free-check"),
            ):
                ctx = context()
                with page_evidence(workspace, [entry], root / "cache") as state:
                    show(ctx)
                    assert len(tools.REGISTRY) == len(originals[0]) + 1
                    assert any(
                        s["function"]["name"] == TOOL_NAME
                        for s in tools.schemas_for(ctx)
                    )
                    assert PROMPT_ADDON in chat_prompts.system_prompt("en")
                    args = {"file_id": "file", "page": 1}
                    results = await asyncio.gather(
                        *[tools.run(TOOL_NAME, args, ctx) for _ in range(3)]
                    )
                    assert all(len(r.passages) == 1 for r in results)
                    assert len(provider_inputs) == 1 and state["attempts"] == 3
                    assert [r["cache_hit"] for r in state["receipts"]].count(False) == 1
                    assert (await tools.run(TOOL_NAME, args, ctx)).refused
                    numbered = tools.assign_citations(ctx, results[0].passages)
                    text = tools.render_result(results[0], numbered)
                    assert "file_id=file, page=1" in text and "start=-1" not in text
                    assert "Locations for read_document" not in text
                    citation = results[0].passages[0].as_citation()
                    assert citation["fileId"] == "file" and citation["pageStart"] == 1
                    assert citation["regions"] == [
                        {"page": 1, "bbox": [0, 0, 1000, 1000]}
                    ]
                    native = tools.ToolResult(passages=[ctx.citations[0]])
                    assert tools.render_result(
                        native, [(1, ctx.citations[0])]
                    ) == originals[1](native, [(1, ctx.citations[0])])
                with Image.open(
                    io.BytesIO(base64.b64decode(provider_inputs[0][0].split(",")[1]))
                ) as im:
                    assert max(im.size) <= 1280
                # Invalid pages, scope and request-supplied prompts spend no provider call.
                invalid = [
                    ({"page": True}, None),
                    ({"page": 0}, None),
                    ({"page": 3}, None),
                    ({"page": 2}, None),
                    ({"prompt": "answer leakage"}, None),
                    ({}, "scope"),
                    ({}, "workspace"),
                    ({}, "hash"),
                ]
                for change, kind in invalid:
                    ctx = context()
                    altered = dict(entry)
                    if kind == "scope":
                        ctx.file_ids = ["different"]
                    if kind == "workspace":
                        ctx.workspace_id = "different"
                    if kind == "hash":
                        altered["pdf_sha256"] = "0" * 64
                    with page_evidence(workspace, [altered], root / "cache"):
                        show(ctx)
                        result = await tools.run(TOOL_NAME, {**args, **change}, ctx)
                        assert result.refused, (change, kind)
                assert len(provider_inputs) == 1
                with page_evidence(workspace, [entry], root / "cache") as state:
                    ctx = context()
                    show(ctx)
                    assert (await tools.run(TOOL_NAME, args, ctx)).passages
                    assert state["receipts"][0]["cache_hit"]
                with patch.object(
                    models, "caption_image", AsyncMock(return_value="")
                ) as empty:
                    ctx = context()
                    with page_evidence(workspace, [entry], root / "empty") as state:
                        show(ctx)
                        for _ in range(2):
                            assert (await tools.run(TOOL_NAME, args, ctx)).refused
                        assert empty.await_count == 2 and not (root / "empty").exists()
                        assert all(
                            r["outcome"] == "empty_provider_result"
                            for r in state["receipts"]
                        )
                with (
                    patch.object(
                        sys.modules[__name__],
                        "current_source",
                        AsyncMock(
                            return_value={"source_sha256": "wrong", "status": "ready"}
                        ),
                    ),
                    page_evidence(workspace, [entry], root / "cache"),
                ):
                    ctx = context()
                    show(ctx)
                    assert (await tools.run(TOOL_NAME, args, ctx)).refused
                cached = next((root / "cache").glob("*.json"))
                data = json.loads(cached.read_bytes())
                data["text"] = "tampered"
                cached.write_bytes(canonical(data))
                with page_evidence(workspace, [entry], root / "cache"):
                    ctx = context()
                    show(ctx)
                    assert (await tools.run(TOOL_NAME, args, ctx)).refused
                # Citation assignment precedes clipping: only a surviving
                # indexed header can make another page eligible.
                ctx = context()
                ctx.citations[0].text = "filler " * 50000
                ctx.citations.append(
                    Passage(
                        "hidden",
                        "file",
                        "source.pdf",
                        8,
                        "",
                        "page two",
                        page_start=2,
                        page_end=2,
                    )
                )
                with page_evidence(workspace, [entry], root / "clipping") as state:
                    assert "[2] source.pdf" not in show(ctx)
                    before = len(provider_inputs)
                    assert (
                        await tools.run(TOOL_NAME, {**args, "page": 2}, ctx)
                    ).refused
                    assert len(provider_inputs) == before
                    ctx.citations[0].text = (
                        "Quoted header: [2] source.pdf › p.2\n" + ctx.citations[0].text
                    )
                    assert "[2] source.pdf" in show(ctx)
                    assert (
                        await tools.run(TOOL_NAME, {**args, "page": 2}, ctx)
                    ).refused
                    assert len(provider_inputs) == before
                    ctx.citations = ctx.citations[1:]
                    show(ctx, paged=True)
                    assert (
                        await tools.run(TOOL_NAME, {**args, "page": 2}, ctx)
                    ).passages
                # The real batch executor still spends the existing turn
                # budget and emits source-page passages as actual citations.
                ctx, budget, messages = context(), TurnBudget(tool_calls_turn=11), []
                with page_evidence(workspace, [entry], root / "budget") as state:
                    show(ctx)
                    calls = [
                        ToolCall(
                            id=f"page-{i}", name=TOOL_NAME, arguments=json.dumps(args)
                        )
                        for i in range(2)
                    ]
                    events = [
                        e async for e in agent._run_tools(calls, ctx, budget, messages)
                    ]
                    assert budget.tool_calls_turn == 12 and state["attempts"] == 1
                    assert (
                        len(messages) == 2
                        and "tool-call limit" in messages[1]["content"]
                    )
                    assert "Locations for read_source_page" in messages[0]["content"]
                    assert any(e["type"] == "citations" for e in events)
                try:
                    with page_evidence(workspace, [entry], root / "cache"):
                        raise RuntimeError("test restoration")
                except RuntimeError:
                    pass
        finally:
            registry.set_job_pins(previous_pins)
    assert (
        dict(tools.REGISTRY),
        tools.render_result,
        chat_prompts.system_prompt,
    ) == originals
    print(
        "Passed source-page scope/hash/observed-page checks, concurrent cap/cache, "
        "image-only captioning, clipped-locator gating, actual agent budget/citations, "
        "no-empty caching and restoration"
    )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", required=True)
    parser.parse_args()
    asyncio.run(check())
