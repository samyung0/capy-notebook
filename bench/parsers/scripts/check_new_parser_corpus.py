"""Check source hashes, selected-page order and raster lineage end to end."""

import argparse
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pymupdf
from bench_java_recovery import page_contexts
from prepare_new_parser_corpus import page_reference, prepare, save, sha


def main() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / "inputs").mkdir()
        source = root / "inputs" / "sample.pdf"
        with pymupdf.open() as document:
            for label in ["FIRST", "SECOND"]:
                document.new_page().insert_text((72, 72), label)
            document.save(source)
        manifest = root / "sources.json"
        save(
            manifest,
            {
                "sources": [
                    {
                        "id": "sample",
                        "sha256": sha(source),
                        "screen_pages": [2, 1],
                        "raster_pages": [2],
                        "lang": "en",
                        "kind": "digital",
                        "role": "development",
                    }
                ]
            },
        )
        frozen_manifest = manifest.read_bytes()

        def read_and_change_manifest(path):
            manifest.write_text(
                manifest.read_text().replace("development", "validation")
            )
            return page_reference(path)

        with patch(
            "prepare_new_parser_corpus.page_reference", read_and_change_manifest
        ):
            prepare(manifest, root)
        corpus = json.loads((root / "corpus.json").read_text())
        entries = corpus["entries"]
        assert (root / "source-manifest.json").read_bytes() == frozen_manifest
        assert corpus["source_manifest_sha256"] == sha(root / "source-manifest.json")
        assert all(e["role"] == "development" for e in entries)
        assert entries[0]["source_sha256"] == entries[0]["pdf_sha256"] == sha(source)
        assert entries[1]["source_pages"] == [1, 0]
        assert entries[2]["source_pages"] == [1]
        with pymupdf.open(root / entries[1]["pdf"]) as document:
            assert [page.get_text().strip() for page in document] == ["SECOND", "FIRST"]
        with pymupdf.open(root / entries[2]["pdf"]) as document:
            assert len(document) == 1 and not document[0].get_text()
            assert document[0].get_images()
        for job in json.loads((root / "source-page-jobs.json").read_text())["jobs"]:
            assert sha(Path(job["image"])) == job["image_sha256"]
            assert job["source_page"] == [1, 0][job["page"]]
        # Page-selection receipts must retain a non-default native run.
        entry = entries[1]
        native = root / "results" / "explicit-native" / entry["id"]
        native.mkdir(parents=True)
        save(native / "content_list.json", [])
        save(
            root / "evaluation.json",
            {
                "records": [
                    {
                        "run": "explicit-native",
                        "case": entry["id"],
                        "state": "ok",
                        "input_sha256": entry["pdf_sha256"],
                        "captionable_paths": [],
                    }
                ]
            },
        )
        inventory = root / "inventory.json"
        save(
            inventory,
            {
                "records": [
                    {
                        **entry,
                        "pages": [
                            {
                                "page": 0,
                                "source_page": 1,
                                "flags": ["table"],
                            }
                        ],
                    }
                ]
            },
        )
        output = root / "context"
        page_contexts(
            argparse.Namespace(
                baseline=root,
                inventory=inventory,
                output=output,
                suite="screen",
                native_run="explicit-native",
                ocr_binding=None,
                ocr_run=None,
                ocr_image_root=None,
                repaired_encoding=False,
                max_edge=2560,
            )
        )
        selection = json.loads((output / "jobs.json").read_text())
        assert selection["native_run"] == "explicit-native"
        assert len(selection["jobs"]) == 1
        # A new output directory must still reject changed source bytes.
        second = root / "changed"
        (second / "inputs").mkdir(parents=True)
        (second / "inputs/sample.pdf").write_bytes(source.read_bytes() + b"changed")
        try:
            prepare(manifest, second)
        except ValueError as exc:
            assert str(exc) == "source hash changed"
        else:
            raise AssertionError("changed source was accepted")
    print("new parser corpus check passed")


if __name__ == "__main__":
    main()
