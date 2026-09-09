"""Offline check of saved recovery, repeated-image placement and source geometry."""

import argparse
import asyncio
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from bench_java_recovery import (
    captionable_pages,
    captions,
    deduplicate_images,
    ocr_blocks,
    page_recovery_reasons,
    recovery_bands,
    saved_response,
    scan_page_reasons,
)
from evaluate_java_recovery import apply_saved
from measure_java_page_context import main as measure_page_context
from PIL import Image


def main() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        Image.new("RGB", (160, 160), "white").save(root / "first.png")
        (root / "second.png").write_bytes((root / "first.png").read_bytes())
        blocks = [
            {
                "type": "image",
                "page_idx": page,
                "bbox": [100, 200, 500, 800],
                "img_path": name,
            }
            for page, name in [(0, "first.png"), (2, "second.png")]
        ]
        assert captionable_pages(blocks, root, ["first.png"]) == {0, 2}
        assert page_recovery_reasons({"page": 2, "flags": []}, {0, 2}) == [
            "captionable_image"
        ]
        assert (
            page_recovery_reasons({"page": 2, "flags": ["scan", "table"]}, {0, 2}) == []
        )
        job = {
            "id": "reused-image",
            "kind": "java",
            "image_sha256": hashlib.sha256(
                (root / "first.png").read_bytes()
            ).hexdigest(),
            "pdf_sha256": "fixture-pdf",
            "occurrences": [
                {
                    "page": block["page_idx"],
                    "bbox": block["bbox"],
                    "img_path": block["img_path"],
                }
                for block in blocks
            ],
        }
        (root / "run.json").write_text(json.dumps({"jobs": [job]}))
        receipt_source = {
            "job": job["id"],
            "state": "ok",
            "run_sha256": hashlib.sha256((root / "run.json").read_bytes()).hexdigest(),
            "image_sha256": job["image_sha256"],
            "pdf_sha256": job["pdf_sha256"],
        }
        caption = "Species A has a brain volume of 400 cubic centimetres."
        (root / "reused-image.json").write_text(
            json.dumps({**receipt_source, "text": caption})
        )
        counts = apply_saved(blocks, [job], root, "caption")
        assert counts["applied"] == 2
        assert all(block["description"] == caption for block in blocks)
        result = deduplicate_images(blocks, root, root / "artifact")
        assert result["placements"] == 2 and result["unique_files"] == 1
        assert blocks[0]["img_path"] == blocks[1]["img_path"]
        assert [block["page_idx"] for block in blocks] == [0, 2]
        lines = ocr_blocks(
            {
                "size": [200, 100],
                "lines": [
                    {
                        "box": [[50, 10], [150, 10], [150, 20], [50, 20]],
                        "text": "readable",
                        "score": 0.9,
                    }
                ],
            },
            job["occurrences"][1],
        )
        assert lines[0]["page_idx"] == 2 and lines[0]["bbox"] == [200, 260, 400, 320]
        (root / "reused-image.json").write_text(
            json.dumps({**receipt_source, "text": "DECORATIVE"})
        )
        counts = apply_saved([], [job], root, "caption")
        assert counts["decorative"] == 1 and counts["applied"] == 0
        try:
            apply_saved(
                [], [{**job, "image_sha256": "different-image"}], root, "caption"
            )
        except ValueError:
            pass
        else:
            raise AssertionError("a different image must not reuse the saved response")
        original_run = (root / "run.json").read_bytes()
        (root / "run.json").write_text(json.dumps({"jobs": [job], "prompt": "changed"}))
        try:
            saved_response(root, job)
        except ValueError:
            pass
        else:
            raise AssertionError("a response from another prompt was accepted")
        (root / "run.json").write_bytes(original_run)
        legacy = {"job": job["id"], "state": "ok", "text": "Legacy"}
        (root / "reused-image.json").write_text(json.dumps(legacy))
        try:
            saved_response(root, job)
        except ValueError:
            pass
        else:
            raise AssertionError("an unpinned legacy response was accepted")
        binding = {
            "run_sha256": hashlib.sha256(original_run).hexdigest(),
            "responses": {
                job["id"]: hashlib.sha256(
                    (root / "reused-image.json").read_bytes()
                ).hexdigest()
            },
        }
        assert saved_response(root, job, binding)["text"] == "Legacy"
        (root / "reused-image.json").write_text(
            json.dumps({**legacy, "text": "Changed"})
        )
        try:
            saved_response(root, job, binding)
        except ValueError:
            pass
        else:
            raise AssertionError("a changed legacy receipt was accepted")
        outside = ocr_blocks(
            {
                "size": [100, 100],
                "lines": [
                    {
                        "box": [[-2, 0], [10, 0], [10, 10], [-2, 10]],
                        "text": "outside",
                        "score": 0.9,
                    }
                ],
            },
            {"page": 0, "bbox": [0, 0, 1000, 1000]},
        )
        assert outside[0]["bbox"][0] == -20
        assert recovery_bands(
            {
                "width": 600,
                "height": 800,
                "stroke_vector_regions": [[100, 20, 200, 120], [300, 130, 400, 150]],
                "java_tables": [[100, 175, 900, 300]],
            },
            20,
        ) == [[0, 0, 600, 260]]
        (root / "provider.json").write_text(
            json.dumps(
                {
                    "endpoint": "https://example.invalid/chat/completions",
                    "key_env": "TEST_CAPTION_KEY",
                    "body": {
                        "model": "test-vision",
                        "enable_thinking": False,
                        "max_tokens": 128,
                    },
                }
            )
        )
        (root / "credential.env").write_text("TEST_CAPTION_KEY=test-only-credential\n")
        (root / "prompt.txt").write_text("Record the visible labels.")
        input_job = {**job, "image": str(root / "first.png")}
        (root / "caption-jobs.json").write_text(
            json.dumps({"jobs": [input_job, {**input_job, "id": "wrong-model"}]})
        )
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.post.side_effect = [
            httpx.Response(
                200,
                request=httpx.Request(
                    "POST", "https://example.invalid/chat/completions"
                ),
                json={
                    "model": model,
                    "provider_note": "test-only-credential",
                    "choices": [
                        {
                            "message": {"content": "Visible labels"},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 2},
                },
            )
            for model in ["test-vision", "unexpected-model"]
        ]
        with patch("httpx.AsyncClient", return_value=client):
            asyncio.run(
                captions(
                    argparse.Namespace(
                        prompt_file=root / "prompt.txt",
                        key_env=root / "credential.env",
                        provider_config=root / "provider.json",
                        jobs=root / "caption-jobs.json",
                        kinds=["java"],
                        ids=None,
                        request_limit=2,
                        output=root / "provider-results",
                        max_edge=128,
                        concurrency=1,
                    )
                )
            )
        sent = client.post.call_args_list[0].kwargs
        assert (
            sent["json"]["enable_thinking"] is False
            and "reasoning_effort" not in sent["json"]
        )
        assert sent["headers"]["Authorization"] == "Bearer test-only-credential"
        assert (
            json.loads((root / "provider-results/reused-image.json").read_text())[
                "state"
            ]
            == "ok"
        )
        assert (
            json.loads((root / "provider-results/wrong-model.json").read_text())[
                "state"
            ]
            == "error"
        )
        assert all(
            "test-only-credential" not in p.read_text()
            for p in (root / "provider-results").glob("*.json")
        )
        (root / "caption-jobs.json").write_text(
            json.dumps({"jobs": [input_job, input_job]})
        )
        with patch("httpx.AsyncClient", return_value=client):
            try:
                asyncio.run(
                    captions(
                        argparse.Namespace(
                            prompt_file=root / "prompt.txt",
                            key_env=root / "credential.env",
                            provider_config=root / "provider.json",
                            jobs=root / "caption-jobs.json",
                            kinds=["java"],
                            ids=None,
                            request_limit=2,
                        )
                    )
                )
            except ValueError:
                pass
            else:
                raise AssertionError("duplicate request IDs were accepted")
        assert client.post.call_count == 2
        scan_jobs = [{**input_job, "id": name} for name in ["flagged", "plain"]]
        scan_dir = root / "scan"
        scan_dir.mkdir()
        (scan_dir / "run.json").write_text(json.dumps({"jobs": scan_jobs}))
        run_hash = hashlib.sha256((scan_dir / "run.json").read_bytes()).hexdigest()
        for scan_job in scan_jobs:
            receipt = {
                **receipt_source,
                "job": scan_job["id"],
                "run_sha256": run_hash,
                "size": [1000, 1500],
                "lines": [],
            }
            if scan_job["id"] == "flagged":
                receipt["lines"] = [
                    {
                        "box": [[0, 0], [900, 0], [900, 30], [0, 30]],
                        "text": "( )",
                        "score": 0.6,
                    }
                ]
            (scan_dir / f"{scan_job['id']}.json").write_text(json.dumps(receipt))
        assert scan_page_reasons(scan_jobs, scan_dir, job["pdf_sha256"]) == [
            "ocr_empty_line"
        ]
        receipt["image_sha256"] = "swapped"
        (scan_dir / "plain.json").write_text(json.dumps(receipt))
        try:
            scan_page_reasons(scan_jobs, scan_dir, job["pdf_sha256"])
        except ValueError:
            pass
        else:
            raise AssertionError("swapped OCR receipt was accepted")
        failure_args = argparse.Namespace(
            baseline=root,
            root=root,
            trial="native-failure",
            suite="full",
            page_plan=root / "caption-jobs.json",
            models=root,
            threads=8,
            max_edge=2560,
            request_limit=2,
        )
        with (
            patch("argparse.ArgumentParser.parse_args", return_value=failure_args),
            patch("measure_java_page_context.Sampler"),
            patch(
                "measure_java_page_context.subprocess.run",
                side_effect=subprocess.CalledProcessError(1, ["test-native-failure"]),
            ),
        ):
            try:
                measure_page_context()
            except subprocess.CalledProcessError:
                pass
            else:
                raise AssertionError("native failure must propagate")
        failure = json.loads((root / "native-failure/failure.json").read_text())
        assert failure["state"] == "error" and failure["planned"] == 2
        assert failure["saved_response_files"] == 0
        assert not (root / "native-failure/complete.json").exists()
    print("saved captions, image deduplication and OCR/crop geometry: ok")


if __name__ == "__main__":
    main()
