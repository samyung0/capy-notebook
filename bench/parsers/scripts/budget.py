"""Parser performance budget: fixed fixtures through one parser build.

    prepare --out DIR
        Materializes fixtures/budget/budget.json into DIR/fixtures: committed
        files plus the generated ones (the 1,400-page cap, a 120-page scan).
        Fails when a fixture breaks the upload limits it is meant to sit in.
    run --out DIR (--service URL --container NAME | --inprocess)
        Parses every fixture once, one at a time, and writes DIR/results.jsonl.
        --service: the parser image through the production artifact route;
          peaks from the container's cgroup, VmPeak of the parse children,
          LibreOffice and Java from /proc (Linux; run as root for the spool).
          CI runs this.
        --inprocess: parser/app.run_document (normalization, Java, repairs,
          thumbnail, VLM page renders) in a fresh child per fixture; peaks from the process
          tree. Compares two revisions on one machine; never judged by the CI
          budgets.
    check --out DIR --machine NAME
        Exit 1 when a fixture fails, breaks an invariant or exceeds its budget
        for that machine. Without budgets it only checks invariants.
    propose DIR [DIR ...]
        Budgets from several runs: the slowest run plus 25%, for review.
    compare BASE CANDIDATE
        Per-fixture time and memory deltas between two runs, and whether each
        fixture's output is the same (SHA-256 of its content_list.json).

Execution time excludes queue wait; it is what the 900 s document deadline
bounds. "OCR pages" are the text-less pages rendered for the ingest worker's VLM.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "bench/parsers/fixtures/budget/budget.json"
ENV_EXAMPLE = ROOT / "deploy/ingest-host.env.example"
GIB = 1 << 30


def manifest() -> dict:
    return json.loads(MANIFEST.read_text())


def limits() -> dict[str, int]:
    values = dict(
        line.split("=", 1)
        for line in ENV_EXAMPLE.read_text().splitlines()
        if line.startswith("CAPY_PARSE_") and "=" in line
    )
    return {
        "pages": int(values["CAPY_PARSE_MAX_PAGES"]),
        "ocr_pages": int(values["CAPY_PARSE_OCR_PAGE_CAP"]),
        "document_timeout_s": int(values["CAPY_PARSE_DOCUMENT_TIMEOUT"]),
    }


def prepare(out: Path) -> None:
    import pymupdf

    spec = manifest()
    cap = limits()
    base = MANIFEST.parent
    target = out / "fixtures"
    target.mkdir(parents=True, exist_ok=True)
    rows = []
    for fixture in spec["fixtures"]:
        if "file" in fixture:
            source = (base / fixture["file"]).resolve()
            path = target / f"{fixture['id']}{source.suffix}"
            shutil.copyfile(source, path)
        else:
            path = target / f"{fixture['id']}.pdf"
            generate(fixture["generate"], base, path)
        pages = ocr = None
        if path.suffix == ".pdf":
            with pymupdf.open(path) as document:
                pages = document.page_count
                ocr = sum(len(p.get_text().strip()) < 40 for p in document)
            if pages > cap["pages"] or ocr > cap["ocr_pages"]:
                raise SystemExit(
                    f"{fixture['id']}: {pages} pages / {ocr} text-less pages exceed the upload limits"
                )
        size = path.stat().st_size
        if size > spec["source_cap_bytes"]:
            raise SystemExit(f"{fixture['id']}: {size} bytes exceed the source cap")
        rows.append(
            {
                "id": fixture["id"],
                "file": path.name,
                "bytes": size,
                "pages": pages,
                "textless_pages": ocr,
            }
        )
        print(json.dumps(rows[-1]), flush=True)
    (out / "fixtures.json").write_text(json.dumps(rows, indent=1))


def generate(spec: dict, base: Path, path: Path) -> None:
    import pymupdf

    with pymupdf.open() as out:
        if "concat" in spec:
            for name in spec["concat"]:
                with pymupdf.open(base / name) as part:
                    out.insert_pdf(part)
        else:
            with pymupdf.open(base / spec["raster"]) as source:
                for index in range(spec["first"], spec["first"] + spec["count"]):
                    page = source[index]
                    pixmap = page.get_pixmap(dpi=spec["dpi"], colorspace=pymupdf.csGRAY)
                    blank = out.new_page(width=page.rect.width, height=page.rect.height)
                    blank.insert_image(blank.rect, stream=pixmap.tobytes("jpg", jpg_quality=75))
        out.save(path, garbage=3, deflate=True, no_new_id=True)


def content_sha256(blocks: list[dict]) -> str:
    """The SHA-256 of the artifact's content_list.json bytes (as app.py writes them)."""
    data = json.dumps(blocks, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(data).hexdigest()


def content_stats(blocks: list[dict]) -> dict:
    """Coarse output size, so a fast build that drops content is visible."""
    chars = 0
    for block in blocks:
        for key in ("text", "table_body"):
            chars += len(block.get(key) or "")
        chars += sum(len(item) for item in block.get("list_items") or [])
    return {"blocks": len(blocks), "text_chars": chars}


# --- service mode -----------------------------------------------------------


def run_service(args, fixtures: list[dict], out: Path) -> list[dict]:
    sys.path.insert(0, str(Path(__file__).parent))
    from stress_parser import SCHEMA, Sampler, cgroup_dir, post, spool_dir, wait_healthy

    token = os.environ["PARSER_TOKEN"]
    cpu = next(
        (
            line.split(":", 1)[1].strip()
            for line in Path("/proc/cpuinfo").read_text().splitlines()
            if line.startswith("model name")
        ),
        "unknown",
    )
    spool = spool_dir(args.container)
    health = wait_healthy(args.service, token)
    sampler = Sampler(cgroup_dir(args.container), out / "samples.csv")
    sampler.start()
    results = []
    for fixture in fixtures:
        wait_healthy(args.service, token)
        time.sleep(args.gap)
        path = out / "fixtures" / fixture["file"]
        data = path.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        fingerprint = hashlib.sha256(f"{uuid.uuid4()}:{sha}".encode()).hexdigest()
        key = f"sources/budget-{fingerprint[:16]}{path.suffix}"
        shutil.copyfile(path, spool / key)
        os.chown(spool / key, 10001, 10001)
        (spool / key).chmod(0o640)
        body = {
            "source_key": key,
            "source_sha256": sha,
            "output_key": f"artifacts/{fingerprint}.zip",
            "filename": path.name,
            "artifact_schema": SCHEMA,
            "parser_version": health["parser_version"],
            "source_fingerprint": fingerprint,
            "request_id": str(uuid.uuid4()),
        }
        status, payload = post(f"{args.service}/file_parse", token, body, 3600)
        ended = time.time()
        stats = {}
        artifact = spool / body["output_key"]
        if status == 200 and artifact.exists():
            with zipfile.ZipFile(artifact) as archive:
                content = archive.read("content_list.json")
            stats = {
                **content_stats(json.loads(content)),
                "content_sha256": hashlib.sha256(content).hexdigest(),
            }
        (spool / key).unlink(missing_ok=True)
        artifact.unlink(missing_ok=True)
        queue = (payload.get("_queue_ms") or 0) / 1000
        execution = (payload.get("_server_parse_s") or 0) - queue
        window = sampler.window(ended - execution, ended) if execution > 0 else {}
        results.append(
            {
                "id": fixture["id"],
                "status": status,
                "error": None if status == 200 else payload.get("code") or payload.get("detail"),
                "parser_version": health["parser_version"],
                "cpu": cpu,
                "execution_s": round(execution, 2) if execution > 0 else None,
                "page_count": payload.get("_page_count"),
                "ocr_pages": payload.get("_ocr_page_count"),
                "phases": payload.get("_phases"),
                "stages": payload.get("_stages"),
                "drawing_steps": payload.get("_drawing_steps"),
                # Anonymous memory is what the parser holds; the cgroup total
                # also counts reclaimable page cache from reading the fixtures.
                "peak_gib": window.get("peak_anon_gib"),
                "peak_cgroup_gib": window.get("peak_current_gib"),
                # Peak virtual size, which a per-process RLIMIT_AS bounds: the
                # parse children's (over their life so far), LibreOffice's and
                # the JVM's. Recorded, not judged.
                "child_vmpeak_gib": window.get("peak_child_vmpeak_gib"),
                "office_vmpeak_gib": window.get("peak_office_vmpeak_gib"),
                "java_vmpeak_gib": window.get("peak_java_vmpeak_gib"),
                "avg_cores": window.get("avg_cores"),
                "oom_kills": window.get("oom_kills"),
                **stats,
            }
        )
        print(json.dumps(results[-1]), flush=True)
    sampler.finish()
    return results


# --- in-process mode --------------------------------------------------------

CHILD = r"""
import json, os, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from app import Document, run_document
if os.environ.get("BUDGET_SOFFICE"):  # LibreOffice outside /usr/bin, e.g. Homebrew
    import odl.document
    odl.document.SOFFICE = os.environ["BUDGET_SOFFICE"]
data = Path(sys.argv[2]).read_bytes()
started = time.perf_counter()
result = run_document(Document(data, Path(sys.argv[2]).name))
elapsed = time.perf_counter() - started
json.dump({"elapsed": elapsed, "page_count": result.get("_page_count"),
           "ocr_pages": len(result.get("_vlm_pages") or []), "phases": result.get("_phases"),
           "stages": result.get("_stages"), "content_list": result.get("content_list") or []},
          open(sys.argv[3], "w"))
"""


def tree_rss(root) -> int:
    import psutil

    total = 0
    for process in [root, *root.children(recursive=True)]:
        try:
            total += process.memory_info().rss
        except psutil.Error:
            pass
    return total


def run_inprocess(args, fixtures: list[dict], out: Path) -> list[dict]:
    import psutil

    work = out / "work"
    work.mkdir(exist_ok=True)
    env = {
        **os.environ,
        "CAPY_PARSE_MAX_PAGES": str(limits()["pages"]),
        "CAPY_PARSE_WORKERS": "1",
        "CAPY_PARSE_WORK_DIR": str(work),
        "CAPY_PARSE_SHARED_DIR": str(work / "spool"),
        "RELEASE_SHA": os.environ.get("RELEASE_SHA", "0" * 40),
    }
    if shutil.which("soffice") and not Path("/usr/bin/soffice").exists():
        env.setdefault("BUDGET_SOFFICE", shutil.which("soffice"))
    version = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; sys.path.insert(0, sys.argv[1]); import app; print(app.PARSER_VERSION)",
            str(ROOT / "parser"),
        ],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    results = []
    for fixture in fixtures:
        time.sleep(args.gap)
        path = out / "fixtures" / fixture["file"]
        reply = work / f"{fixture['id']}.json"
        reply.unlink(missing_ok=True)
        child = subprocess.Popen(
            [sys.executable, "-c", CHILD, str(ROOT / "parser"), str(path), str(reply)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        process = psutil.Process(child.pid)
        peak = 0
        output: list[str] = []
        drain = threading.Thread(
            target=lambda out=output, proc=child: out.append(proc.stdout.read()), daemon=True
        )
        drain.start()
        while child.poll() is None:
            peak = max(peak, tree_rss(process))
            time.sleep(0.1)
        drain.join()
        if child.returncode != 0 or not reply.exists():
            results.append(
                {
                    "id": fixture["id"],
                    "status": 500,
                    "error": f"exit {child.returncode}: {''.join(output)[-300:]}",
                    "parser_version": version,
                }
            )
        else:
            body = json.loads(reply.read_text())
            results.append(
                {
                    "id": fixture["id"],
                    "status": 200,
                    "error": None,
                    "parser_version": version,
                    "execution_s": round(body["elapsed"], 2),
                    "page_count": body["page_count"],
                    "ocr_pages": body["ocr_pages"],
                    "phases": {k: round(v, 3) for k, v in (body["phases"] or {}).items()},
                    "stages": {k: round(v, 3) for k, v in (body["stages"] or {}).items()},
                    "peak_gib": round(peak / GIB, 2),
                    **content_stats(body["content_list"]),
                    "content_sha256": content_sha256(body["content_list"]),
                }
            )
        print(json.dumps(results[-1]), flush=True)
    shutil.rmtree(work, ignore_errors=True)
    return results


def run(args) -> None:
    out = Path(args.out)
    prepared = {row["id"]: row for row in json.loads((out / "fixtures.json").read_text())}
    wanted = set(args.only.split(",")) if args.only else None
    fixtures = [
        prepared[f["id"]] for f in manifest()["fixtures"] if not wanted or f["id"] in wanted
    ]
    results = (
        run_service(args, fixtures, out) if args.service else run_inprocess(args, fixtures, out)
    )
    mode = "service" if args.service else "inprocess"
    with (out / "results.jsonl").open("w") as handle:
        for row in results:
            handle.write(json.dumps({**row, "mode": mode}) + "\n")


# --- checks -----------------------------------------------------------------


def load(directory: Path) -> dict[str, dict]:
    rows = {
        row["id"]: row
        for row in map(json.loads, (directory / "results.jsonl").read_text().splitlines())
    }
    for row in rows.values():  # runs before 2026-10-12 kept anon under its own key
        if "peak_anon_gib" in row:
            row["peak_gib"] = row.pop("peak_anon_gib")
    return rows


def check(args) -> None:
    spec = manifest()
    results = load(Path(args.out))
    prepared = {
        row["id"]: row for row in json.loads((Path(args.out) / "fixtures.json").read_text())
    }
    budgets = spec["budgets"].get(args.machine, {})
    deadline = limits()["document_timeout_s"]
    failures = []
    lines = [
        f"Parser budget ({args.machine}): {next(iter(results.values()))['parser_version']}",
        "",
        "| Fixture | Pages | OCR | Execution s | Budget s | Peak GiB | Budget GiB "
        "| VmPeak GiB child / LibreOffice | Blocks | Result |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for fixture in spec["fixtures"]:
        row = results.get(fixture["id"])
        problems = []
        if row is None:
            problems.append("not run")
            row = {}
        elif row["status"] != 200:
            problems.append(f"failed: {row['error']}")
        else:
            expected = prepared[fixture["id"]]["pages"]
            if expected is not None and row["page_count"] != expected:
                problems.append(f"{row['page_count']} pages parsed, {expected} expected")
            if row["ocr_pages"] < fixture.get("expect", {}).get("ocr_pages_min", 0):
                problems.append(f"only {row['ocr_pages']} OCR pages")
            if not row.get("blocks"):
                problems.append("no content")
            if row.get("oom_kills"):
                problems.append("OOM kill")
            if row["execution_s"] is not None and row["execution_s"] > deadline:
                problems.append("past the document deadline")
            budget = budgets.get(fixture["id"], {})
            if budget.get("execution_s") and row["execution_s"] > budget["execution_s"]:
                problems.append(f"slower than {budget['execution_s']} s")
            if budget.get("peak_gib") and (row.get("peak_gib") or 0) > budget["peak_gib"]:
                problems.append(f"more than {budget['peak_gib']} GiB")
        budget = budgets.get(fixture["id"], {})
        failures += [f"{fixture['id']}: {p}" for p in problems]
        lines.append(
            f"| {fixture['id']} | {row.get('page_count', '')} | {row.get('ocr_pages', '')} "
            f"| {row.get('execution_s', '')} | {budget.get('execution_s', '—')} "
            f"| {row.get('peak_gib', '')} | {budget.get('peak_gib', '—')} "
            f"| {row.get('child_vmpeak_gib', '')} / {row.get('office_vmpeak_gib', '')} "
            f"| {row.get('blocks', '')} "
            f"| {'; '.join(problems) or 'ok'} |"
        )
    if not budgets:
        lines += ["", f"No budgets recorded for `{args.machine}`: invariants only."]
    print("\n".join(lines))
    if failures:
        raise SystemExit("Budget failures:\n" + "\n".join(failures))


def propose(args) -> None:
    runs = [load(Path(d)) for d in args.dirs]
    proposal = {}
    for fixture in manifest()["fixtures"]:
        rows = [r[fixture["id"]] for r in runs if r.get(fixture["id"], {}).get("status") == 200]
        if len(rows) != len(runs):
            continue
        slowest = max(r["execution_s"] for r in rows)
        largest = max(r["peak_gib"] or 0 for r in rows)
        proposal[fixture["id"]] = {
            "execution_s": round(max(slowest * 1.25, slowest + 2), 1),
            "peak_gib": round(max(largest * 1.25, largest + 0.25), 2),
        }
    print(json.dumps(proposal, indent=1))


def compare(args) -> None:
    base, candidate = load(Path(args.base)), load(Path(args.candidate))
    print(
        f"{next(iter(base.values()))['parser_version']} -> {next(iter(candidate.values()))['parser_version']}\n"
    )
    print(
        "| Fixture | Base s | Candidate s | Δ | Base GiB | Candidate GiB | Blocks | Text chars | Output |"
    )
    print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |")
    totals = [0.0, 0.0]
    for fixture in manifest()["fixtures"]:
        a, b = base.get(fixture["id"]), candidate.get(fixture["id"])
        if not a or not b or a["status"] != 200 or b["status"] != 200:
            print(
                f"| {fixture['id']} | {a and a.get('execution_s')} | {b and b.get('execution_s')} | — | | | | | |"
            )
            continue
        hashes = a.get("content_sha256"), b.get("content_sha256")
        output = "—" if None in hashes else "same" if hashes[0] == hashes[1] else "differs"
        totals[0] += a["execution_s"]
        totals[1] += b["execution_s"]
        delta = (b["execution_s"] - a["execution_s"]) / max(a["execution_s"], 0.01)
        print(
            f"| {fixture['id']} | {a['execution_s']} | {b['execution_s']} | {delta:+.0%} "
            f"| {a['peak_gib']} | {b['peak_gib']} | {a['blocks']} → {b['blocks']} "
            f"| {a['text_chars']} → {b['text_chars']} | {output} |"
        )
    print(
        f"| **total** | {totals[0]:.1f} | {totals[1]:.1f} | {(totals[1] - totals[0]) / max(totals[0], 0.01):+.0%} | | | | | |"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--out", required=True)
    r = sub.add_parser("run")
    r.add_argument("--out", required=True)
    mode = r.add_mutually_exclusive_group(required=True)
    mode.add_argument("--service")
    mode.add_argument("--inprocess", action="store_true")
    r.add_argument("--container")
    r.add_argument("--only", help="comma-separated fixture ids")
    r.add_argument("--gap", type=float, default=3)
    c = sub.add_parser("check")
    c.add_argument("--out", required=True)
    c.add_argument("--machine", required=True)
    o = sub.add_parser("propose")
    o.add_argument("dirs", nargs="+")
    d = sub.add_parser("compare")
    d.add_argument("base")
    d.add_argument("candidate")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(Path(args.out))
    elif args.command == "run":
        if args.service and not args.container:
            parser.error("--service needs --container")
        run(args)
    else:
        {"check": check, "propose": propose, "compare": compare}[args.command](args)


if __name__ == "__main__":
    main()
