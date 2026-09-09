"""Run one frozen parser configuration on Capy's prepared corpus.

Use isolated CPU containers. Run different configurations sequentially. This
runner saves native outputs and a small adapter to Capy's content-list shape;
it never contacts an application database or an inference provider.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import html
import importlib.metadata
import json
import os
import queue
import shutil
import subprocess
import threading
import time
import traceback
import urllib.request
from collections import Counter
from pathlib import Path

CONFIGS = {
    "mineru-auto": {"engine": "mineru", "method": "auto"},
    "mineru-txt": {"engine": "mineru", "method": "txt"},
    "mineru-ocr": {"engine": "mineru", "method": "ocr"},
    "odl-java": {"engine": "odl"},
    "odl-java-cluster": {"engine": "odl", "table_method": "cluster"},
    "odl-java-headers": {
        "engine": "odl",
        "table_method": "cluster",
        "include_header_footer": True,
    },
    "odl-java-lines": {
        "engine": "odl",
        "table_method": "cluster",
        "keep_line_breaks": True,
    },
    "odl-java-order-off": {
        "engine": "odl",
        "table_method": "cluster",
        "reading_order": "off",
    },
    "odl-java-tags": {"engine": "odl", "tags": True},
    "odl-auto-noocr": {"engine": "odl", "hybrid": "auto", "ocr": "off"},
    "odl-auto-easy": {"engine": "odl", "hybrid": "auto", "ocr": "easyocr"},
    "odl-full-easy": {
        "engine": "odl",
        "hybrid": "full",
        "ocr": "easyocr",
        "force": True,
    },
    "odl-auto-rapid": {"engine": "odl", "hybrid": "auto", "ocr": "rapidocr"},
    "odl-full-rapid-autoocr": {"engine": "odl", "hybrid": "full", "ocr": "rapidocr"},
    "odl-full-easy-autoocr": {"engine": "odl", "hybrid": "full", "ocr": "easyocr"},
    "odl-full-rapid-lang": {
        "engine": "odl",
        "hybrid": "full",
        "ocr": "rapidocr",
        "language_aware": True,
    },
    "odl-full-rapid": {
        "engine": "odl",
        "hybrid": "full",
        "ocr": "rapidocr",
        "force": True,
    },
    "odl-auto-formula": {
        "engine": "odl",
        "hybrid": "auto",
        "ocr": "rapidocr",
        "formula": True,
    },
}

_mineru_ready = False
_mineru_warm_lock = threading.Lock()


def parse_mineru_slice(data, name, part, method):
    """Match Capy's shared-model thread lanes and serialized first model load."""
    from mineru_worker import parse_slice

    global _mineru_ready
    with _mineru_warm_lock:
        if not _mineru_ready:
            result = parse_slice(data, name, part, method)
            _mineru_ready = True
            return result
    return parse_slice(data, name, part, method)


def save(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)


def read_number(name: str) -> int:
    path = Path("/sys/fs/cgroup") / name
    return int(path.read_text().strip())


def cgroup_cpu() -> dict[str, int]:
    path = Path("/sys/fs/cgroup/cpu.stat")
    return {
        line.split()[0]: int(line.split()[1]) for line in path.read_text().splitlines()
    }


class Sampler:
    def __init__(self, path: Path):
        self.path = path
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.peak_memory = 0
        self.peak_swap = 0
        self.peak_anon = 0
        self.peak_file = 0
        self.started = time.monotonic()

    def run(self) -> None:
        with self.path.open("w") as stream:
            stream.write("seconds,memory_bytes,swap_bytes,anon_bytes,file_bytes\n")
            while not self.stop.is_set():
                memory = read_number("memory.current")
                swap = read_number("memory.swap.current")
                stats = {
                    line.split()[0]: int(line.split()[1])
                    for line in Path("/sys/fs/cgroup/memory.stat")
                    .read_text()
                    .splitlines()
                }
                self.peak_memory = max(self.peak_memory, memory)
                self.peak_swap = max(self.peak_swap, swap)
                self.peak_anon = max(self.peak_anon, stats["anon"])
                self.peak_file = max(self.peak_file, stats["file"])
                stream.write(
                    f"{time.monotonic() - self.started:.3f},{memory},{swap},"
                    f"{stats['anon']},{stats['file']}\n"
                )
                stream.flush()
                self.stop.wait(0.25)


def node_text(node: dict) -> str:
    content = node.get("content")
    parts = [content] if isinstance(content, str) else []
    parts.extend(
        node_text(child)
        for child in node.get("kids", [])
        + node.get("list items", [])
        + node.get("toc items", [])
    )
    return " ".join(parts)


def odl_content_list(document: dict, pages: list[dict]) -> list[dict]:
    """Map ODL point/bottom-left geometry to Capy's 0..1000 top-left boxes.

    Preserve out-of-bounds boxes for validation. Do not hide parser errors by
    clipping them. Table cells remain HTML so Capy's existing flattener applies.
    """
    blocks = []

    def embedded_images(node: dict) -> None:
        if node.get("type") in {"image", "picture"}:
            visit(node)
            return
        for key in ["kids", "list items", "toc items", "rows", "cells"]:
            for child in node.get(key, []):
                embedded_images(child)

    def visit(node: dict) -> None:
        kind = node.get("type")
        page = node.get("page number")
        box = node.get("bounding box")
        common = {"_native_type": kind, "_native_id": node.get("id")}
        if isinstance(page, int) and 1 <= page <= len(pages):
            common["page_idx"] = page - 1
            width, height = pages[page - 1]["width"], pages[page - 1]["height"]
            if isinstance(box, list) and len(box) == 4:
                x0, y0, x1, y1 = box
                common["bbox"] = [
                    round(x0 / width * 1000, 3),
                    round((height - y1) / height * 1000, 3),
                    round(x1 / width * 1000, 3),
                    round((height - y0) / height * 1000, 3),
                ]
        if kind == "list":
            blocks.append(
                {
                    **common,
                    "type": "list",
                    "list_items": [
                        node_text(item) for item in node.get("list items", [])
                    ],
                }
            )
            embedded_images(node)
            return
        if kind == "table":
            rows = []
            for row in node.get("rows", []):
                cells = []
                for cell in row.get("cells", []):
                    tag = "th" if cell.get("is_header") else "td"
                    rowspan = int(cell.get("row span", 1))
                    colspan = int(cell.get("column span", 1))
                    cells.append(
                        f'<{tag} rowspan="{rowspan}" colspan="{colspan}">'
                        f"{html.escape(node_text(cell))}</{tag}>"
                    )
                rows.append("<tr>" + "".join(cells) + "</tr>")
            blocks.append(
                {
                    **common,
                    "type": "table",
                    "table_body": "<table>" + "".join(rows) + "</table>",
                }
            )
            embedded_images(node)
            return
        if kind in {"image", "picture"}:
            block = {**common, "type": "image", "img_path": node.get("source", "")}
            if node.get("description"):
                block["image_caption"] = [node["description"]]
            blocks.append(block)
            return
        if kind in {"formula", "equation"}:
            blocks.append({**common, "type": "equation", "text": node_text(node)})
            return
        if isinstance(node.get("content"), str) and node["content"].strip():
            block = {**common, "type": "text", "text": node["content"]}
            if kind == "heading":
                block["text_level"] = node.get("heading level", 1)
            blocks.append(block)
            return
        for child in node.get("kids", []) + node.get("toc items", []):
            visit(child)

    visit(document)
    return blocks


def language(entry: dict) -> str:
    if entry["lang"] == "zh":
        return (
            "ch_tra,en"
            if any(x in entry["id"] for x in ["zh_HK", "zh_TW"])
            else "ch_sim,en"
        )
    return "en" if entry["lang"] == "en" else entry["lang"] + ",en"


def backend_language(entry: dict, config: dict) -> str:
    if config.get("ocr") == "easyocr":
        return language(entry)
    if config.get("language_aware"):
        if entry["lang"] == "zh":
            return "chinese_cht" if language(entry) == "ch_tra,en" else "ch"
        return "japan" if entry["lang"] == "ja" else entry["lang"]
    return "default"


class Hybrid:
    def __init__(self, root: Path, config: dict, logs: Path, port: int = 5002):
        self.root, self.config, self.logs = root, config, logs
        self.port = port
        self.process = None
        self.key = None
        self.logfile = None
        self.starts = []

    def close(self) -> None:
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None
        if self.logfile is not None:
            self.logfile.close()

    def ensure(self, entry: dict) -> None:
        if not self.config.get("hybrid"):
            return
        lang = backend_language(entry, self.config)
        if (
            self.key == lang
            and self.process is not None
            and self.process.poll() is None
        ):
            return
        self.close()
        self.key = lang
        command = [
            "opendataloader-pdf-hybrid",
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            "--device",
            "cpu",
        ]
        if self.config["ocr"] == "off":
            command.append("--no-ocr")
        else:
            command.extend(["--ocr-engine", self.config["ocr"]])
        if lang != "default":
            command.extend(["--ocr-lang", lang])
        if self.config.get("force"):
            command.append("--force-ocr")
        if self.config.get("formula"):
            command.append("--enrich-formula")
        suffix = f"-{self.port}" if self.port != 5002 else ""
        log = self.logs / f"backend-{lang}{suffix}.log"
        self.logfile = log.open("a")
        start = time.monotonic()
        self.process = subprocess.Popen(
            command, stdout=self.logfile, stderr=subprocess.STDOUT
        )
        while time.monotonic() - start < 900:
            if self.process.poll() is not None:
                raise RuntimeError(
                    f"hybrid backend exited {self.process.returncode}; see {log}"
                )
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{self.port}/health", timeout=1
                ) as response:
                    if response.status == 200:
                        self.starts.append(
                            {"command": command, "ready_s": time.monotonic() - start}
                        )
                        return
            except OSError:
                pass
            time.sleep(0.5)
        raise TimeoutError("hybrid backend did not start within 900 seconds")


def convert(
    root: Path, entry: dict, target: Path, config: dict, args: argparse.Namespace
) -> dict:
    source = root / entry["pdf"]
    reference_path = root / entry.get(
        "reference", f"prepared/{entry['id']}.reference.json"
    )
    reference = json.loads(reference_path.read_text())
    slice_pages = getattr(args, "odl_slice_pages", None)
    if config["engine"] == "odl" and slice_pages and entry["pages"] > slice_pages:
        return convert_odl_slices(root, entry, target, config, args, reference)
    if config["engine"] == "mineru":
        from mineru_worker import merge_slices, page_slices

        data = source.read_bytes()
        slices = page_slices(entry["pages"], 26)
        if len(slices) == 1:
            results = [
                parse_mineru_slice(data, entry["id"], slices[0], config["method"])
            ]
        else:
            with concurrent.futures.ThreadPoolExecutor(
                max_workers=args.slice_workers,
            ) as executor:
                futures = [
                    executor.submit(
                        parse_mineru_slice, data, entry["id"], part, config["method"]
                    )
                    for part in slices
                ]
                results = [future.result() for future in futures]
        merged = merge_slices(results)
        images = merged.pop("images")
        (target / "images").mkdir(exist_ok=True)
        for name, body in images.items():
            (target / "images" / name).write_bytes(base64.b64decode(body))
        (target / "output.md").write_text(merged["md"], encoding="utf-8")
        blocks = merged.pop("content_list")
        save(target / "content_list.json", blocks)
        save(
            target / "native_metadata.json",
            {k: v for k, v in merged.items() if k != "md"},
        )
        return {
            "blocks": len(blocks),
            "types": dict(Counter(x.get("type") for x in blocks)),
            "ocr_pages": merged["_ocr_pages"],
            "slice_executor": "shared_model_threads" if len(slices) > 1 else "inline",
        }

    command = [
        "opendataloader-pdf",
        str(source),
        "--output-dir",
        str(target),
        "--format",
        "json,markdown",
        "--image-output",
        "external",
        "--markdown-with-html",
        "--threads",
        str(args.java_threads),
    ]
    if config.get("table_method"):
        command.extend(["--table-method", config["table_method"]])
    if config.get("tags"):
        command.append("--use-struct-tree")
    if config.get("include_header_footer"):
        command.append("--include-header-footer")
    if config.get("keep_line_breaks"):
        command.append("--keep-line-breaks")
    if config.get("reading_order"):
        command.extend(["--reading-order", config["reading_order"]])
    if config.get("hybrid"):
        command.extend(
            [
                "--hybrid",
                "docling-fast",
                "--hybrid-mode",
                config["hybrid"],
                "--hybrid-url",
                f"http://127.0.0.1:{getattr(args, 'hybrid_port', 5002)}",
                "--hybrid-timeout",
                str(args.timeout * 1000),
            ]
        )
    with (target / "converter.log").open("w") as log:
        subprocess.run(
            command,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=True,
            timeout=args.timeout,
        )
    native = json.loads((target / f"{source.stem}.json").read_text())
    if native["number of pages"] != entry["pages"]:
        raise ValueError("output page count does not match input")
    blocks = odl_content_list(native, reference)
    save(target / "content_list.json", blocks)
    (target / "output.md").write_text(
        (target / f"{source.stem}.md").read_text(), encoding="utf-8"
    )
    return {
        "blocks": len(blocks),
        "types": dict(Counter(x.get("type") for x in blocks)),
        "command": command,
    }


def convert_odl_slices(
    root: Path,
    entry: dict,
    target: Path,
    config: dict,
    args: argparse.Namespace,
    reference: list[dict],
) -> dict:
    """Bound candidate requests like Capy's existing 26-page slice admission."""
    from pypdf import PdfReader, PdfWriter

    source = PdfReader(root / entry["pdf"])
    parts = []
    for start in range(0, entry["pages"], args.odl_slice_pages):
        end = min(entry["pages"], start + args.odl_slice_pages)
        identity = f"{entry['id']}__p{start + 1}-{end}"
        folder = target / "parts" / identity
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{identity}.pdf"
        writer = PdfWriter()
        for page in range(start, end):
            writer.add_page(source.pages[page])
        with path.open("wb") as stream:
            writer.write(stream)
        reference_path = folder / f"{identity}.reference.json"
        save(reference_path, reference[start:end])
        part = {
            **entry,
            "id": identity,
            "pdf": str(path.relative_to(root)),
            "reference": str(reference_path.relative_to(root)),
            "pages": end - start,
        }
        parts.append((start, part, folder))
    ports = queue.Queue()
    for index in range(args.slice_workers):
        ports.put(5002 + index % getattr(args, "hybrid_workers", 1))

    def convert_part(part: dict, folder: Path) -> dict:
        port = ports.get()
        try:
            slice_args = argparse.Namespace(
                **(
                    vars(args)
                    | {"timeout": min(args.timeout, 600), "hybrid_port": port}
                )
            )
            return convert(root, part, folder, config, slice_args)
        finally:
            ports.put(port)

    # Only independent JVM clients run in these threads; model work stays in the
    # hybrid servers, as in the separate four-document capacity test.
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.slice_workers) as pool:
        futures = [pool.submit(convert_part, part, folder) for _, part, folder in parts]
        try:
            for future in futures:
                future.result()
        except Exception:
            for future in futures:
                future.cancel()
            raise
    native = {"number of pages": entry["pages"], "kids": []}
    markdown = []
    (target / "images").mkdir(exist_ok=True)

    def relocate(value: object, start: int, folder: Path, replacements: dict) -> None:
        if isinstance(value, list):
            for child in value:
                relocate(child, start, folder, replacements)
        elif isinstance(value, dict):
            if isinstance(value.get("page number"), int):
                value["page number"] += start
            if value.get("type") in {"image", "picture"} and value.get("source"):
                original = value["source"]
                relative = f"images/p{start:04d}-{Path(original).name}"
                shutil.copy2(folder / original, target / relative)
                value["source"] = relative
                replacements[original] = relative
            for child in value.values():
                if isinstance(child, (dict, list)):
                    relocate(child, start, folder, replacements)

    for start, part, folder in parts:
        document = json.loads((folder / f"{part['id']}.json").read_text())
        replacements = {}
        relocate(document, start, folder, replacements)
        native["kids"].extend(document["kids"])
        text = (folder / "output.md").read_text()
        for original, relative in replacements.items():
            text = text.replace(original, relative)
        markdown.append(text)
    save(target / f"{entry['id']}.json", native)
    blocks = odl_content_list(native, reference)
    save(target / "content_list.json", blocks)
    (target / "output.md").write_text("\n\n".join(markdown))
    return {
        "blocks": len(blocks),
        "types": dict(Counter(block.get("type") for block in blocks)),
        "slices": len(parts),
        "slice_executor": "concurrent_jvm_clients",
        "slice_pages": args.odl_slice_pages,
        "hybrid_workers": getattr(args, "hybrid_workers", 1),
    }


def measured(
    root: Path, entry: dict, target: Path, config: dict, args: argparse.Namespace
) -> dict:
    target.mkdir(parents=True, exist_ok=True)
    record = {
        "id": entry["id"],
        "config": args.config,
        "pages": entry["pages"],
        "input_sha256": entry["pdf_sha256"],
        "state": "running",
        "started_unix": time.time(),
    }
    save(target / "result.json", record)
    start = time.monotonic()
    sampler = Sampler(target / "resources.csv")
    sampler.thread.start()
    before = cgroup_cpu()

    def abort() -> None:
        save(
            target / "result.json",
            {
                **record,
                "state": "timeout",
                "wall_s": time.monotonic() - start,
                "peak_memory_bytes": sampler.peak_memory,
                "peak_swap_bytes": sampler.peak_swap,
                "peak_anon_bytes": sampler.peak_anon,
                "peak_file_bytes": sampler.peak_file,
            },
        )
        save(
            target / "cgroup-timeout.json",
            {
                name: (Path("/sys/fs/cgroup") / name).read_text()
                for name in ["memory.peak", "memory.events", "memory.stat", "cpu.stat"]
            },
        )
        # A native parser cannot safely recover from an interrupted model call.
        os._exit(124)

    deadline = threading.Timer(args.timeout, abort)
    deadline.daemon = True
    deadline.start()
    try:
        result = convert(root, entry, target, config, args)
        record.update(result, state="ok")
    except Exception:  # noqa: BLE001 - record parser failures as benchmark evidence
        record.update(state="error", error=traceback.format_exc())
    finally:
        deadline.cancel()
        sampler.stop.set()
        sampler.thread.join()
    after = cgroup_cpu()
    record.update(
        wall_s=time.monotonic() - start,
        peak_memory_bytes=sampler.peak_memory,
        peak_swap_bytes=sampler.peak_swap,
        peak_anon_bytes=sampler.peak_anon,
        peak_file_bytes=sampler.peak_file,
        cpu={k: after[k] - before.get(k, 0) for k in after},
    )
    save(target / "result.json", record)
    print(
        json.dumps(
            {
                k: record.get(k)
                for k in [
                    "id",
                    "config",
                    "state",
                    "wall_s",
                    "peak_memory_bytes",
                    "peak_swap_bytes",
                ]
            }
        ),
        flush=True,
    )
    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--config", required=True, choices=CONFIGS)
    parser.add_argument("--suite", choices=["screen", "full", "long"], default="screen")
    parser.add_argument("--ids", nargs="*")
    parser.add_argument("--run", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--slice-workers", type=int, default=4)
    parser.add_argument("--odl-slice-pages", type=int, choices=[26])
    parser.add_argument("--hybrid-workers", type=int, choices=[1, 4], default=1)
    parser.add_argument("--java-threads", type=int, default=2)
    parser.add_argument("--warmup", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()
    config = CONFIGS[args.config]
    if args.hybrid_workers > 1 and (
        not config.get("hybrid") or not args.odl_slice_pages or args.slice_workers < 4
    ):
        parser.error("four hybrid workers require hybrid mode and four sliced clients")
    corpus = json.loads((args.root / "corpus.json").read_text())["entries"]
    entries = (
        [e for e in corpus if e["id"] in args.ids]
        if args.ids
        else [e for e in corpus if e["suite"] == args.suite]
    )
    if args.ids and set(args.ids) != {e["id"] for e in entries}:
        raise ValueError("unknown corpus id")
    entries.sort(key=lambda e: (language(e), e["id"]))
    output = args.root / "results" / args.run
    output.mkdir(parents=True, exist_ok=False)
    versions = {}
    for name in [
        "mineru",
        "opendataloader-pdf",
        "docling",
        "torch",
        "easyocr",
        "rapidocr",
        "pypdfium2",
    ]:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            pass
    save(
        output / "run.json",
        {
            "args": vars(args) | {"root": str(args.root)},
            "config": config,
            "versions": versions,
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "mineru_worker_sha256": hashlib.sha256(
                (args.root / "scripts/mineru_worker.py").read_bytes()
            ).hexdigest(),
            "environment": {
                k: os.environ.get(k)
                for k in [
                    "OMP_NUM_THREADS",
                    "MKL_NUM_THREADS",
                    "OPENBLAS_NUM_THREADS",
                    "MINERU_INTRA_OP_NUM_THREADS",
                    "MINERU_INTER_OP_NUM_THREADS",
                    "MINERU_DEVICE_MODE",
                    "MINERU_PROCESSING_WINDOW_SIZE",
                ]
            },
        },
    )
    configuration_started = time.monotonic()
    hybrids = [
        Hybrid(args.root, config, output, port=5002 + index)
        for index in range(args.hybrid_workers)
    ]
    warm_keys = set()
    try:
        for entry in entries:
            for hybrid in hybrids:
                hybrid.ensure(entry)
            key = backend_language(entry, config)
            if args.warmup and key not in warm_keys:
                warm = next(
                    e for e in corpus if e["id"] == "screen__office-canary__docx"
                )
                for hybrid in hybrids:
                    warm_args = argparse.Namespace(
                        **(vars(args) | {"hybrid_port": hybrid.port})
                    )
                    warm_result = measured(
                        args.root,
                        warm,
                        output / f"_warmup-{key}-{hybrid.port}",
                        config,
                        warm_args,
                    )
                    if warm_result["state"] != "ok":
                        raise RuntimeError(
                            "warmup failed; prepare the parser before measuring this configuration"
                        )
                warm_keys.add(key)
            measured(args.root, entry, output / entry["id"], config, args)
    finally:
        for hybrid in hybrids:
            hybrid.close()
        save(
            output / "backend-starts.json",
            [start for hybrid in hybrids for start in hybrid.starts],
        )
        save(
            output / "cgroup-final.json",
            {
                name: (Path("/sys/fs/cgroup") / name).read_text()
                for name in ["memory.peak", "memory.events", "memory.stat", "cpu.stat"]
            },
        )
        states = Counter()
        for entry in entries:
            result_path = output / entry["id"] / "result.json"
            states[
                json.loads(result_path.read_text())["state"]
                if result_path.exists()
                else "not_run"
            ] += 1
        save(
            output / "complete.json",
            {
                "finished_unix": time.time(),
                "configuration_wall_s": time.monotonic() - configuration_started,
                "states": dict(states),
            },
        )


if __name__ == "__main__":
    main()
