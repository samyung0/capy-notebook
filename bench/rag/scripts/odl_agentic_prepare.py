"""Prepare matched parser artifacts with current captioning, chunking and indexing."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import time
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

ROOT = Path(os.environ.get("ODL_EVAL_ROOT", "/lab"))
MAIN = Path("/opt/capy-odl-third-pass-20260909")
OLD = Path("/opt/capy-odl-third-regression-20260909")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def serialize(chunks):
    return [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks]


def pack_odl(blocks, entry):
    import experiment_odl_table_integration as tables
    from experiment_odl_heading_retention import retain_headings

    furniture = set(read(Path(entry["odl"]) / "refinement.json")["furniture"])
    with patch.object(tables, "_repeated_across_pages", lambda _: furniture):
        chunks, _ = tables.stable_chunks(blocks, blocks)
    return retain_headings(blocks, Path(entry["parsed_pdf"]), chunks)[0]


def inventory():
    """Bind by PDF SHA, then prove caption-free replay matches frozen ODL chunks."""
    from pipeline.parse.figures import select_figures
    from pipeline.retrieval.chunking import chunk_content_list

    sources = read(ROOT / "source-inventory.json")
    pdfs = {}
    for dirname in (
        "capy-odl-third-pass-20260909",
        "capy-odl-third-regression-20260909",
        "capy-odl-independent-20260909",
        "capy-java-new-documents-20260909",
        "capy-odl-font-transfer-20260909",
        "capy-parser-eval-20260908",
    ):
        for path in (Path("/opt") / dirname).rglob("*.pdf"):
            if path.is_file():
                pdfs.setdefault(sha(path), str(path))
    entries = []
    for sid, source in sources.items():
        legacy = source["kind"] == "legacy"
        odl = (OLD if legacy else MAIN) / "refined-final-r1" / sid
        mineru = (
            Path("/opt/capy-parser-eval-20260908/results/full-mineru-auto")
            if legacy
            else MAIN / "results/full-mineru-auto-r1"
        ) / sid
        result = read(odl / "result.json")
        assert result["source_sha256"] == source["coordinate_pdf_sha256"], sid
        mineru_result = read(mineru / "result.json")
        assert mineru_result["state"] == "ok"
        assert mineru_result["input_sha256"] == source["coordinate_pdf_sha256"], sid
        entry = {
            "id": sid,
            "source_sha256": source["source_sha256"],
            "pdf_sha256": source["coordinate_pdf_sha256"],
            "odl_parser_input_sha256": result["source_sha256"],
            "mineru_parser_input_sha256": mineru_result["input_sha256"],
            "pdf": pdfs[source["coordinate_pdf_sha256"]],
            "parsed_pdf": pdfs[result["parsed_pdf_sha256"]],
            "pages": source["page_count"],
            "odl": str(odl),
            "mineru": str(mineru),
            "name": source.get("legacy_path", sid + ".pdf").split("/")[-1],
        }
        for arm in ("odl", "mineru"):
            folder = Path(entry[arm])
            blocks = read(folder / "content_list.json")
            missing = [
                b["img_path"]
                for b in blocks
                if b.get("img_path") and not (folder / b["img_path"]).is_file()
            ]
            assert not missing, (sid, arm, missing[:3])
            chunks = (
                pack_odl(blocks, entry) if arm == "odl" else chunk_content_list(blocks)
            )
            if arm == "odl":
                assert serialize(chunks) == read(folder / "chunks.json"), (
                    sid,
                    "ODL replay mismatch",
                )
            entry[arm + "_content_sha256"] = sha(folder / "content_list.json")
            entry[arm + "_native_chunks"] = len(chunks)
            entry[arm + "_selected_images"] = len(select_figures(blocks, folder))
        entries.append(entry)
        print(
            sid,
            "verified",
            entry["odl_selected_images"],
            entry["mineru_selected_images"],
            flush=True,
        )
    save(ROOT / "corpus.json", entries)
    print(
        "Verified",
        len(entries),
        "documents",
        sum(e["pages"] for e in entries),
        "pages",
        flush=True,
    )


async def captions(ids):
    from odl_agentic_runtime import install_transport, recording_context
    from pipeline.elitellm import client
    from pipeline.parse import figures
    from pipeline.prompts.captioning import DECORATIVE, IMAGE_PROMPT
    from pipeline.retrieval import models
    from pipeline.retrieval.chunking import chunk_content_list

    from pipeline import registry

    spec = install_transport(ROOT)
    registry.bind_request_llm(thinking="instant")
    registry.set_job_pins(registry.JobPins(ingest=spec, captioning=spec))
    # This stage has no billing state but uses the current ingest retry policy.
    models._interactive = lambda: False
    client._interactive = lambda: False
    generation = {
        "model": asdict(spec),
        "enable_thinking": False,
        "endpoint": os.environ["ODL_QWEN_CHAT_URL"],
        "prompt_sha256": hashlib.sha256(IMAGE_PROMPT.encode()).hexdigest(),
        "caption_max_edge": figures.cfg.caption_max_edge,
        "encoder_sha256": sha(Path(figures.__file__)),
    }
    generation = json.loads(json.dumps(generation))
    semaphore = asyncio.Semaphore(4)
    for entry in read(ROOT / "corpus.json"):
        if ids and entry["id"] not in ids:
            continue
        for arm in ("odl", "mineru"):
            target = ROOT / "captioned" / arm / entry["id"]
            if (target / "complete.json").exists():
                completed = read(target / "complete.json")
                assert completed["generation"] == generation
                assert completed["input_sha256"] == sha(
                    Path(entry[arm]) / "content_list.json"
                )
                assert completed["chunks_sha256"] == sha(target / "chunks.json")
                assert completed["content_sha256"] == sha(target / "content_list.json")
                continue
            started = time.perf_counter()
            blocks = read(Path(entry[arm]) / "content_list.json")
            selected = figures.select_figures(blocks, Path(entry[arm]))

            async def describe(figure, arm=arm, source_id=entry["id"]):
                async with semaphore:
                    cache = ROOT / "caption-cache" / (figure.digest + ".json")
                    if cache.exists():
                        record = read(cache)
                        assert record["generation"] == generation
                        assert record["model"] == spec.model_slug
                        assert (
                            record["text"] and record["image_sha256"] == figure.digest
                        )
                        assert (
                            record["prompt_sha256"]
                            == hashlib.sha256(IMAGE_PROMPT.encode()).hexdigest()
                        )
                        assert (
                            record["caption_max_edge"] == figures.cfg.caption_max_edge
                        )
                        assert record["encoder_sha256"] == sha(Path(figures.__file__))
                        return record["text"], True
                    data_url = figures._encode(figure.path)
                    assert data_url
                    with recording_context(
                        phase="caption",
                        arm=arm,
                        source_id=source_id,
                        image_sha256=figure.digest,
                    ):
                        text = await models.caption_image(
                            data_url, IMAGE_PROMPT, best_effort=True
                        )
                    record = {
                        "model": spec.model_slug,
                        "text": text,
                        "image_sha256": figure.digest,
                        "prompt_sha256": hashlib.sha256(
                            IMAGE_PROMPT.encode()
                        ).hexdigest(),
                        "caption_max_edge": figures.cfg.caption_max_edge,
                        "encoder_sha256": sha(Path(figures.__file__)),
                    }
                    record["generation"] = generation
                    if text:
                        save(cache, record)
                    return text, False

            results = await asyncio.gather(*(describe(figure) for figure in selected))
            for figure, (text, _) in zip(selected, results):
                if text and text != DECORATIVE:
                    for block in figure.items:
                        block["description"] = text
            chunks = (
                pack_odl(blocks, entry) if arm == "odl" else chunk_content_list(blocks)
            )
            save(target / "content_list.json", blocks)
            save(target / "chunks.json", serialize(chunks))
            record = {
                "id": entry["id"],
                "arm": arm,
                "selected": len(selected),
                "cached": sum(hit for _, hit in results),
                "empty": sum(not text for text, _ in results),
                "decorative": sum(text == DECORATIVE for text, _ in results),
                "chunks": len(chunks),
                "seconds": time.perf_counter() - started,
                "input_sha256": entry[arm + "_content_sha256"],
                "chunks_sha256": sha(target / "chunks.json"),
            }
            record.update(
                generation=generation, content_sha256=sha(target / "content_list.json")
            )
            save(target / "complete.json", record)
            print(json.dumps(record), flush=True)


async def _index_failure_snapshot(workspace_id, file_id, content_id):
    from pipeline.retrieval import store

    table = store.vector_table_for_pin(
        await store.workspace_embedding_pin(workspace_id)
    )
    pool = await store.pool()
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT f.source_sha256, f.status, f.indexed, "
            "(SELECT workspace_id FROM rag_contents WHERE id=%s) AS content_workspace_id, "
            "(SELECT content_id FROM rag_file_contents WHERE file_id=f.id) AS attached_content_id, "
            "(SELECT status FROM rag_contents WHERE id=%s AND workspace_id=%s) AS content_status, "
            "(SELECT count(*) FROM rag_file_contents WHERE file_id=f.id) AS file_aliases, "
            "(SELECT count(*) FROM rag_file_contents WHERE content_id=%s) AS content_aliases, "
            "(SELECT count(*) FROM rag_chunks WHERE content_id=%s) AS chunks, "
            f"(SELECT count(*) FROM {table} v JOIN rag_chunks c ON c.id=v.chunk_id "
            "WHERE c.content_id=%s) AS vectors, "
            "(SELECT count(*) FROM rag_content_summaries WHERE content_id=%s) AS summaries "
            "FROM files f WHERE f.id=%s AND f.workspace_id=%s",
            (
                content_id,
                content_id,
                workspace_id,
                content_id,
                content_id,
                content_id,
                content_id,
                file_id,
                workspace_id,
            ),
        )
        row = await cur.fetchone()
    return dict(row) if row else None


async def record_index_failure(entry, arm, exc=None, started=None, *, evidence=None):
    """Seal the first failure, perform production cleanup, and never retry it.

    To adopt a failure recorded before this handler existed, root passes its
    original error and log/provider receipt hashes in evidence. No provider is
    called. With an existing marker this only verifies/resumes its cleanup.
    """
    from odl_agentic_runtime import guard_database
    from pipeline.retrieval import store

    guard_database()
    if arm not in ("odl", "mineru"):
        raise ValueError("Unknown parser arm")
    target = ROOT / "captioned" / arm / entry["id"]
    path = target / "index-failed.json"
    binding = {
        "arm": arm,
        "source_id": entry["id"],
        "workspace_id": "odl_eval_" + arm,
        "file_id": f"odl_eval_{arm}_{entry['id']}",
        "content_id": f"odl_content_{arm}_{entry['id']}",
        "source_sha256": entry["source_sha256"],
        "pdf_sha256": entry["pdf_sha256"],
        "chunks_sha256": sha(target / "chunks.json"),
        "caption_complete_sha256": sha(target / "complete.json"),
    }
    if (target / "index-complete.json").exists():
        raise ValueError("A successful index cannot also be marked failed")
    if path.exists():
        record = read(path)
        if any(record.get(k) != value for k, value in binding.items()):
            raise ValueError("Failed-index input or source binding changed")
        if record.get("status") != "failed" or record.get("cleanup") not in (
            "pending",
            "complete",
        ):
            raise ValueError("Invalid failed-index marker")
    else:
        if exc is None:
            raise ValueError("Recording a first failure requires its original error")
        snapshot = await _index_failure_snapshot(
            binding["workspace_id"], binding["file_id"], binding["content_id"]
        )
        if not snapshot or snapshot["source_sha256"] != entry["source_sha256"]:
            raise ValueError("Failed file does not match the frozen source")
        if snapshot["content_status"] not in (None, "processing"):
            raise ValueError("Cannot abandon a completed index")
        record = {
            **binding,
            "status": "failed",
            "cleanup": "pending",
            "error": str(exc),
            "error_class": type(exc).__name__,
            "seconds": None if started is None else time.perf_counter() - started,
            "recorded_unix": time.time(),
            "first_partial_state": snapshot,
            "evidence": evidence or {},
        }
        # Persist before removing partial rows. A stopped cleanup resumes from
        # this marker, so repeating the preparation never reissues the model call.
        save(path, record)

    snapshot = await _index_failure_snapshot(
        binding["workspace_id"], binding["file_id"], binding["content_id"]
    )
    if not snapshot or snapshot["source_sha256"] != entry["source_sha256"]:
        raise ValueError("Failed file source changed")
    if snapshot["content_workspace_id"] not in (None, binding["workspace_id"]):
        raise ValueError("Failed content belongs to another workspace")
    if snapshot["attached_content_id"] not in (None, binding["content_id"]):
        raise ValueError("Failed file is associated with different content")
    if record["cleanup"] == "pending":
        if snapshot["content_status"] not in (None, "processing"):
            raise ValueError("Failed content unexpectedly became ready")
        if snapshot["file_aliases"] != snapshot["content_aliases"]:
            raise ValueError("Unexpected failed-file content association")
        await store.abandon_content(binding["content_id"])
        pool = await store.pool()
        async with pool.connection() as conn:
            cur = await conn.execute(
                "UPDATE files SET status='failed', indexed=false "
                "WHERE id=%s AND workspace_id=%s AND source_sha256=%s RETURNING id",
                (binding["file_id"], binding["workspace_id"], entry["source_sha256"]),
            )
            if await cur.fetchone() is None:
                raise ValueError("Failed file source changed during cleanup")
        snapshot = await _index_failure_snapshot(
            binding["workspace_id"], binding["file_id"], binding["content_id"]
        )
    if (
        not snapshot
        or snapshot["source_sha256"] != entry["source_sha256"]
        or snapshot["status"] != "failed"
        or snapshot["indexed"]
        or snapshot["content_status"] is not None
        or any(
            snapshot[k]
            for k in (
                "file_aliases",
                "content_aliases",
                "chunks",
                "vectors",
                "summaries",
            )
        )
    ):
        raise ValueError("Failed-index cleanup does not match production state")
    if record["cleanup"] != "complete":
        record.update(cleanup="complete", final_state=snapshot)
        save(path, record)
    return record


async def index(ids):
    import psycopg
    from odl_agentic_runtime import install_transport, recording_context
    from pipeline.config import cfg
    from pipeline.elitellm import client
    from pipeline.retrieval import indexing, models, store
    from pipeline.retrieval.chunking import Chunk, Region

    from pipeline import registry

    assert "127.0.0.1:55435/odl_eval" in cfg.dsn, "Isolated lab DB required"
    spec = install_transport(ROOT)
    registry.bind_request_llm(thinking="instant")
    embedding = registry.resolve_pinned(
        "deepinfra", "Qwen/Qwen3-Embedding-4B", 1, registry.Slot.RETRIEVAL
    )
    registry.set_job_pins(
        registry.JobPins(ingest=spec, captioning=spec, embedding=embedding)
    )
    models._interactive = lambda: False
    client._interactive = lambda: False
    manifest = {
        "arms": {
            arm: {"workspace_id": "odl_eval_" + arm, "files": {}, "failed_sources": {}}
            for arm in ("odl", "mineru")
        }
    }
    with psycopg.connect(cfg.dsn) as conn:
        conn.execute(
            "INSERT INTO users(id,name) VALUES ('odl_eval_user','Parser QA lab') ON CONFLICT DO NOTHING"
        )
        for arm, ws in manifest["arms"].items():
            conn.execute(
                "INSERT INTO workspaces(id,user_id,name) VALUES (%s,'odl_eval_user',%s) ON CONFLICT DO NOTHING",
                (ws["workspace_id"], "Parser QA " + arm),
            )
    for entry in read(ROOT / "corpus.json"):
        for arm, ws in manifest["arms"].items():
            fid, cid = (
                f"odl_eval_{arm}_{entry['id']}",
                f"odl_content_{arm}_{entry['id']}",
            )
            ws["files"][entry["id"]] = fid
            target = ROOT / "captioned" / arm / entry["id"]
            if (target / "index-failed.json").exists():
                ws["failed_sources"][entry["id"]] = await record_index_failure(
                    entry, arm
                )
                continue
            if ids and entry["id"] not in ids:
                continue
            assert (target / "complete.json").exists()
            if (target / "index-complete.json").exists():
                complete = read(target / "index-complete.json")
                assert complete["chunks_sha256"] == sha(target / "chunks.json")
                with psycopg.connect(cfg.dsn) as conn:
                    row = conn.execute(
                        "SELECT rc.status,cs.fingerprint,(SELECT count(*) FROM rag_chunks c WHERE c.content_id=rc.id) FROM rag_contents rc JOIN rag_content_summaries cs ON cs.content_id=rc.id WHERE rc.id=%s AND rc.workspace_id=%s",
                        (cid, ws["workspace_id"]),
                    ).fetchone()
                    assert row == (
                        "ready",
                        complete["fingerprint"],
                        complete["chunks"],
                    ), (arm, entry["id"], row)
                    assert conn.execute(
                        "SELECT f.source_sha256,fc.content_id FROM files f JOIN rag_file_contents fc ON fc.file_id=f.id WHERE f.id=%s AND f.workspace_id=%s",
                        (fid, ws["workspace_id"]),
                    ).fetchone() == (entry["source_sha256"], cid)
                continue
            rows = read(target / "chunks.json")
            chunks = [
                Chunk(
                    **{
                        k: v
                        for k, v in row.items()
                        if k not in ("indexed_text", "regions")
                    },
                    regions=[
                        Region(page=r["page"], bbox=r["bbox"]) for r in row["regions"]
                    ],
                )
                for row in rows
            ]
            with psycopg.connect(cfg.dsn) as conn:
                conn.execute(
                    "INSERT INTO files(id,workspace_id,user_id,name,status,indexed,source_sha256) VALUES (%s,%s,'odl_eval_user',%s,'ready',true,%s) ON CONFLICT DO NOTHING",
                    (fid, ws["workspace_id"], entry["name"], entry["source_sha256"]),
                )
                conn.execute(
                    "INSERT INTO rag_contents(id,workspace_id,content_hash,source_sha256,pipeline_identity) VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    (
                        cid,
                        ws["workspace_id"],
                        indexing.content_hash(chunks),
                        entry["source_sha256"],
                        "odl-agentic-20260909:" + arm,
                    ),
                )
                conn.execute(
                    "INSERT INTO rag_file_contents(file_id,workspace_id,content_id) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                    (fid, ws["workspace_id"], cid),
                )
            started = time.perf_counter()
            try:
                with recording_context(phase="index", arm=arm, source_id=entry["id"]):
                    result = await indexing.index_file(
                        workspace_id=ws["workspace_id"],
                        content_id=cid,
                        file_id=fid,
                        file_name=entry["name"],
                        chunks=chunks,
                    )
            except Exception as exc:  # noqa: BLE001 - retain every failed ingest attempt
                failure = await record_index_failure(
                    entry,
                    arm,
                    exc,
                    started,
                    evidence={
                        "recording_context": {
                            "phase": "index",
                            "arm": arm,
                            "source_id": entry["id"],
                        }
                    },
                )
                ws["failed_sources"][entry["id"]] = failure
                print(json.dumps(failure), flush=True)
                continue
            result.update(
                seconds=time.perf_counter() - started,
                arm=arm,
                source_id=entry["id"],
                chunks_sha256=sha(target / "chunks.json"),
            )
            save(target / "index-complete.json", result)
            print(json.dumps(result), flush=True)
    save(ROOT / "workspaces.json", manifest)
    await store.close_pool()


async def check_failure():
    """Provider-free check of first-failure preservation and cleanup resumption."""
    import copy
    import sys
    import tempfile
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock, patch

    import odl_agentic_runtime
    from pipeline.retrieval import store

    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        entry = {"id": "synthetic", "source_sha256": "a" * 64, "pdf_sha256": "b" * 64}
        target = root / "captioned" / "odl" / entry["id"]
        save(target / "chunks.json", [{"text": "original source"}])
        save(target / "complete.json", {"input": "frozen"})
        marker = target / "index-failed.json"
        initial = {
            "source_sha256": entry["source_sha256"],
            "status": "ready",
            "indexed": True,
            "content_status": "processing",
            "content_workspace_id": "odl_eval_odl",
            "attached_content_id": "odl_content_odl_synthetic",
            "file_aliases": 1,
            "content_aliases": 1,
            "chunks": 2,
            "vectors": 2,
            "summaries": 0,
        }
        state = dict(initial)

        async def snapshot(*_):
            return copy.deepcopy(state)

        async def abandon(content_id):
            assert content_id == "odl_content_odl_synthetic"
            assert read(marker)["cleanup"] == "pending"
            state.update(
                content_status=None,
                content_workspace_id=None,
                attached_content_id=None,
                file_aliases=0,
                content_aliases=0,
                chunks=0,
                vectors=0,
                summaries=0,
            )

        class Connection:
            async def execute(self, query, args):
                assert args == ("odl_eval_odl_synthetic", "odl_eval_odl", "a" * 64)
                assert "status='failed', indexed=false" in query
                state.update(status="failed", indexed=False)
                return AsyncMock(fetchone=AsyncMock(return_value={"id": args[0]}))

        class Pool:
            @asynccontextmanager
            async def connection(self):
                yield Connection()

        module = sys.modules[__name__]
        with (
            patch.object(module, "ROOT", root),
            patch.object(module, "_index_failure_snapshot", snapshot),
            patch.object(odl_agentic_runtime, "guard_database"),
            patch.object(store, "pool", AsyncMock(return_value=Pool())),
            patch.object(
                store, "abandon_content", AsyncMock(side_effect=abandon)
            ) as cleanup,
        ):
            record = await record_index_failure(
                entry,
                "odl",
                RuntimeError("first failure"),
                evidence={"provider_receipt_sha256": "c" * 64},
            )
            assert record["first_partial_state"] == initial
            assert record["final_state"]["status"] == "failed"
            before = marker.read_bytes()
            repeated = await record_index_failure(
                entry, "odl", RuntimeError("later error")
            )
            assert (
                repeated["error"] == "first failure" and marker.read_bytes() == before
            )
            assert cleanup.await_count == 1
            # An interrupted cleanup leaves the durable marker and resumes it.
            state.clear()
            state.update(initial)
            record["cleanup"] = "pending"
            record.pop("final_state")
            save(marker, record)
            with patch.object(
                store,
                "abandon_content",
                AsyncMock(side_effect=RuntimeError("DB stopped")),
            ):
                try:
                    await record_index_failure(entry, "odl")
                except RuntimeError:
                    pass
                else:
                    raise AssertionError("Interrupted cleanup must remain failed")
            assert read(marker)["cleanup"] == "pending"
            resumed = await record_index_failure(entry, "odl")
            assert (
                resumed["cleanup"] == "complete" and resumed["error"] == "first failure"
            )
            before_calls = cleanup.await_count
            save(target / "chunks.json", [{"text": "changed source"}])
            try:
                await record_index_failure(entry, "odl")
            except ValueError:
                pass
            else:
                raise AssertionError("Changed input must not reuse a failed marker")
            assert cleanup.await_count == before_calls
    print(
        "Passed failure sealing, production cleanup, no retry on resume, "
        "interrupted cleanup recovery and changed-input refusal"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode", choices=("inventory", "caption", "index", "check-failure")
    )
    parser.add_argument("--ids", default="")
    args = parser.parse_args()
    ids = args.ids.split(",") if args.ids else []
    if args.mode == "check-failure":
        asyncio.run(check_failure())
    elif args.mode == "inventory":
        inventory()
    else:
        asyncio.run(captions(ids) if args.mode == "caption" else index(ids))


if __name__ == "__main__":
    main()
