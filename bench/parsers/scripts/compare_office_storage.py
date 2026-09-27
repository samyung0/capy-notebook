"""Assemble complete paired UAT snapshots and native Office payload measurements.

Usage: python compare_office_storage.py NATIVE_JSON INPUT_MANIFEST BEFORE_RUN
       AFTER_RUN OUTPUT_PREFIX
Run IDs can be comma-separated. Only whole file triples enter the comparison.
Run from the repository root. Outputs exact JSON and Markdown tables.
"""

import json
import subprocess
import sys
from pathlib import Path

PHASES = ("initial", "edited", "reparsed")
DB_FIELDS = (
    "chunk_columns_stored",
    "vector_values_stored",
    "descriptor_stored",
    "content_row",
)
EDIT_FIELDS = ("state_stored", "baseline_stored", "effects_stored")


def total(record, fields):
    return sum(int(record.get(field) or 0) for field in fields)


def read_run(run_id):
    directory = Path("e2e/uat/journey-runs") / run_id
    manifest = json.loads((directory / "manifest.json").read_text())
    assert manifest["cleanup"]["failed"] == [], f"Incomplete cleanup: {run_id}"
    releases = []
    for phase in ("before", "after"):
        release = json.loads((directory / f"ingest-release-{phase}.json").read_text())
        assert release["activeRevision"] == manifest["revision"]
        assert len(release["containers"]) == 5
        assert all(c["revision"] == manifest["revision"] for c in release["containers"])
        releases.append(release)
    assert releases[0]["containers"] == releases[1]["containers"], "Runtime changed"
    records = {}
    for path in (directory / "evidence").glob("storage-*.json"):
        row = json.loads(path.read_text())
        row["run_id"] = run_id
        key = (row["set"], row["name"], row["phase"])
        assert key not in records, f"Duplicate snapshot: {key}"
        row["cache_bytes"] = int(row["cache_bytes"])
        row["caption_bytes"] = int(row["caption_bytes"])
        row["editing_values_stored"] = total(row["editing"] or {}, EDIT_FIELDS)
        row["database_values_stored"] = (
            total(row, DB_FIELDS) + row["editing_values_stored"]
        )
        row["active_payload_bytes"] = total(
            row,
            ("size_bytes", "cache_bytes", "caption_bytes", "database_values_stored"),
        )
        row["observed_payload_bytes"] = total(
            row,
            ("object_current_bytes", "object_hidden_bytes", "database_values_stored"),
        )
        groups = {}
        for obj in row.pop("objects"):
            prefix = obj["key"].split("/")[0]
            group = groups.setdefault(prefix, {"current_bytes": 0, "hidden_bytes": 0})
            for field in group:
                group[field] += obj[field]
        row["object_prefixes"] = groups
        assert sum(total(g, g.keys()) for g in groups.values()) == total(
            row, ("object_current_bytes", "object_hidden_bytes")
        )
        records[key] = row
    metadata = {
        "run_id": run_id,
        "revision": manifest["revision"],
        "started_at": manifest["startedAt"],
        "cleanup": manifest["cleanup"]["finishedAt"],
        "cleanup_failed": [],
        "releases": releases,
    }
    return metadata, manifest, records


def arm(run_ids, inputs):
    runs, complete, handoffs = [], {}, []
    for run_id in run_ids.split(","):
        metadata, manifest, records = read_run(run_id)
        metadata["completed_files"] = []
        for item in inputs:
            file_key = (item["set"], item["name"])
            keys = [(*file_key, phase) for phase in PHASES]
            if not all(key in records for key in keys):
                continue
            assert file_key not in complete, f"Duplicate complete file: {file_key}"
            triple = [records[key] for key in keys]
            assert triple[0]["source_sha256"] == item["sha256"]
            assert all(row["upload_bytes"] == item["bytes"] for row in triple)
            assert total(triple[1]["editing"], ("state_bytes",)) > 0
            assert all(
                total(row["editing"] or {}, ("state_bytes",)) == 0
                for row in (triple[0], triple[2])
            )
            complete[file_key] = triple
            metadata["completed_files"].append(item["name"])
            file_ids = {
                r["details"]["fileId"]
                for r in manifest["resources"]
                if r["kind"] == "blob"
                and r["details"].get("sourceSha256") == item["sha256"]
            }
            assert len(file_ids) == 1
            file_id = file_ids.pop()
            receipts = {}
            for path in (Path("e2e/uat/journey-runs") / run_id / "evidence").glob(
                f"{file_id}-*.json"
            ):
                evidence = json.loads(path.read_text())
                if isinstance(evidence, dict) and "receipt" in evidence:
                    receipt = evidence["receipt"]
                    receipts[receipt["key"]] = {
                        k: receipt[k] for k in ("size", "sha256")
                    }
            assert len(receipts) == 2, "Need both local parser handoffs"
            handoffs.append(
                {
                    "set": item["set"],
                    "name": item["name"],
                    "receipts": list(receipts.values()),
                    "zip_bytes": sum(r["size"] for r in receipts.values()),
                }
            )
        runs.append(metadata)
    assert len(complete) == 6, (
        "Need six complete files, without mixing phases between runs"
    )
    assert len({run["revision"] for run in runs}) == 1, "An arm must use one runtime"
    return {
        "revision": runs[0]["revision"],
        "runs": runs,
        "local_handoffs": handoffs,
        "records": [
            row for item in inputs for row in complete[(item["set"], item["name"])]
        ],
    }


def main():
    native_path, input_path, before_id, after_id, output = sys.argv[1:]
    native = json.loads(Path(native_path).read_text())
    assert len(native["records"]) == 18
    inputs = json.loads(Path(input_path).read_text())
    assert len(inputs) == 6
    before, after = arm(before_id, inputs), arm(after_id, inputs)
    # Test/docs-only commits may follow the native run without changing its code.
    subprocess.run(
        [
            "git",
            "diff",
            "--exit-code",
            native["capy_revision"],
            after["revision"],
            "--",
            "bench/parsers/scripts/office_storage.ts",
            "collaboration",
            "vendor/betteroffice",
        ],
        check=True,
        stdout=subprocess.PIPE,
    )
    assert all(row["cache_bytes"] > 0 for row in before["records"])
    assert all(
        row["cache_bytes"] == 0 and row["caption_bytes"] == 0
        for row in after["records"]
    )
    data = {"native": native, "inputs": inputs, "before": before, "after": after}
    Path(output + ".json").write_text(json.dumps(data, indent=2) + "\n")
    lines = [
        "# Office storage without durable parse bundles",
        "",
        "All sizes use decimal KB, 1 KB = 1,000 bytes.",
        "",
    ]

    def table(headers, rows):
        lines.append("| " + " | ".join(headers) + " |")
        lines.append("| " + " | ".join(["---"] + ["---:"] * (len(headers) - 1)) + " |")
        lines.extend("| " + " | ".join(str(x) for x in row) + " |" for row in rows)
        lines.append("")

    def kb(value):
        return f"{value / 1000:,.2f}"

    lines.extend(["## Native file and editing payload", ""])
    table(
        [
            "File",
            "Original",
            "In-memory seed",
            "One saved edit",
            "Calculated publication overlap with later save",
            "Published, quiet",
            "Published, later edit rebased",
        ],
        [
            [
                Path(r["file"]).name,
                *map(
                    kb,
                    [
                        r["source_bytes"],
                        r["seed_bytes"],
                        r["source_bytes"] + total(r["one_edit"], EDIT_FIELDS),
                        r["source_bytes"]
                        + r["exported_bytes"]
                        + total(r["during_refresh"], EDIT_FIELDS)
                        + r["captured_state_stored"],
                        r["exported_bytes"],
                        r["exported_bytes"]
                        + total(r["rebased_with_later_edit"], EDIT_FIELDS),
                    ],
                ),
            ]
            for r in native["records"]
        ],
    )
    lines.extend(["## Native quota for the application files", ""])
    table(
        [
            "File",
            "Original charge",
            "Charge after one edit",
            "Quiet publication",
            "Publication with a later edit",
        ],
        [
            [
                Path(r["file"]).name,
                *map(
                    kb,
                    [
                        r["source_bytes"],
                        r["source_bytes"] + r["one_edit"]["quota_extra"],
                        r["exported_bytes"],
                        r["exported_bytes"]
                        + r["rebased_with_later_edit"]["quota_extra"],
                    ],
                ),
            ]
            for r in native["records"][:6]
        ],
    )
    lines.extend(["## Paired live payload", ""])
    paired = list(zip(before["records"], after["records"], strict=True))
    table(
        ["File", "Phase", "Before", "After", "Saved", "Removed bundle"],
        [
            [
                b["name"],
                b["phase"],
                *map(
                    kb,
                    [
                        b["active_payload_bytes"],
                        a["active_payload_bytes"],
                        b["active_payload_bytes"] - a["active_payload_bytes"],
                        b["cache_bytes"],
                    ],
                ),
            ]
            for b, a in paired
        ],
    )
    lines.extend(["## Published storage including retained B2 copies", ""])
    table(
        [
            "File",
            "Uploaded",
            "New source",
            "Active before",
            "Active after",
            "Reduction",
            "Observed before",
            "Observed after",
        ],
        [
            [
                b["name"],
                kb(a["upload_bytes"]),
                kb(a["size_bytes"]),
                kb(b["active_payload_bytes"]),
                kb(a["active_payload_bytes"]),
                f"{100 * (1 - a['active_payload_bytes'] / b['active_payload_bytes']):.2f}%",
                kb(b["observed_payload_bytes"]),
                kb(a["observed_payload_bytes"]),
            ]
            for b, a in paired
            if a["phase"] == "reparsed"
        ],
    )
    lines.extend(["## What remains after publication", ""])
    table(
        [
            "File",
            "New source",
            "Chunks",
            "Chunk columns",
            "Embeddings",
            "Descriptor + content metadata",
            "Editing values before publication",
            "B2 parse cache",
        ],
        [
            [
                after["records"][i]["name"],
                kb(after["records"][i + 2]["size_bytes"]),
                after["records"][i + 2]["chunks"],
                kb(after["records"][i + 2]["chunk_columns_stored"]),
                kb(after["records"][i + 2]["vector_values_stored"]),
                kb(
                    total(after["records"][i + 2], ("descriptor_stored", "content_row"))
                ),
                kb(after["records"][i + 1]["editing_values_stored"]),
                kb(after["records"][i + 2]["cache_bytes"]),
            ]
            for i in range(0, 18, 3)
        ],
    )
    lines.extend(["## Reparse component sum", ""])
    table(
        [
            "File",
            "Before: two index generations, sources and saved state",
            "After: same components",
            "Reduction",
        ],
        [
            [
                before["records"][i]["name"],
                *map(
                    kb,
                    [
                        sum(
                            r["active_payload_bytes"]
                            for r in before["records"][i + 1 : i + 3]
                        ),
                        sum(
                            r["active_payload_bytes"]
                            for r in after["records"][i + 1 : i + 3]
                        ),
                        sum(
                            b["active_payload_bytes"] - a["active_payload_bytes"]
                            for b, a in paired[i + 1 : i + 3]
                        ),
                    ],
                ),
            ]
            for i in range(0, 18, 3)
        ],
    )
    lines.extend(["## Temporary local handoff bytes", ""])
    after_handoffs = {row["name"]: row for row in after["local_handoffs"]}
    table(
        ["File", "Before: initial + refreshed ZIP", "After: initial + refreshed ZIP"],
        [
            [
                row["name"],
                kb(row["zip_bytes"]),
                kb(after_handoffs[row["name"]]["zip_bytes"]),
            ]
            for row in before["local_handoffs"]
        ],
    )
    Path(output + ".md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
