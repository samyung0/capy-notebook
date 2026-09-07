"""Serve the isolated wllama comparison page and append its results locally."""

import argparse
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import random
import threading
import time
from urllib.parse import urlsplit

from benchmark import DATA, MODELS, PROMPT_FILE, SETTINGS, check_batch, digest, grade, parse_output, read_cases, read_results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--models", choices=MODELS, nargs="+", required=True)
    parser.add_argument("--port", type=int, default=18892)
    parser.add_argument("--tokens", type=int, default=80)
    parser.add_argument("--context", type=int, default=1024)
    parser.add_argument("--shuffle-seed", type=int, help="Use the same mixed case order for every browser model")
    args = parser.parse_args()
    cases = read_cases(args.dataset)
    if args.shuffle_seed is not None:
        random.Random(args.shuffle_seed).shuffle(cases)
    indexed = {c["id"]: c for c in cases}
    settings = dict(SETTINGS, max_tokens=args.tokens, n_ctx=args.context)
    assets = {
        "/": (Path(__file__).with_name("browser.html"), "text/html; charset=utf-8"),
        "/browser.js": (Path(__file__).with_name("browser.js"), "text/javascript; charset=utf-8"),
        "/runtime/wllama.js": (DATA / "browser-runtime/node_modules/@wllama/wllama/esm/index.js", "text/javascript"),
        "/runtime/wllama.wasm": (DATA / "browser-runtime/node_modules/@wllama/wllama/esm/wasm/wllama.wasm", "application/wasm"),
    }
    models = []
    for model in args.models:
        file = DATA / "models" / MODELS[model]
        source = json.loads(file.with_suffix(file.suffix + ".source.json").read_text(encoding="utf-8"))
        parts = sorted(file.parent.glob(file.stem + "-split-*.gguf"))
        files = parts or [file]
        urls = []
        for part in files:
            url = f"/models/{model}/{part.name}"
            assets[url] = (part, "application/octet-stream")
            urls.append(url)
        models.append({"id": model, "urls": urls, "source": source})
    config = {"models": models, "settings": settings, "system": grade.GRADE_SYSTEM,
              "cases": [{"id": c["id"], "prompt": c["grade_prompt"]} for c in cases]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    old = read_results(args.output, repair_tail=True)
    for suffix in (".manifest.jsonl", ".events.jsonl"):
        read_results(args.output.with_suffix(suffix), repair_tail=True)
    completed = {r["run_key"] for r in old}
    implementation = digest({"prompt": PROMPT_FILE.read_text(encoding="utf-8"),
                             "browser": Path(__file__).with_name("browser.js").read_text(encoding="utf-8"),
                             "server": Path(__file__).read_text(encoding="utf-8"),
                             "grading": Path(__file__).with_name("benchmark.py").read_text(encoding="utf-8")})
    prompt_sha256 = hashlib.sha256(PROMPT_FILE.read_bytes()).hexdigest()
    case_hashes = [c["case_sha256"] for c in cases]

    def run_config(model, browser):
        return {"model": model["id"], "model_source": model["source"], "runtime": "wllama-3.6.0-webgpu",
                "case_order_seed": args.shuffle_seed,
                "prompt_sha256": prompt_sha256,
                "settings": settings, "browser": browser, "implementation_sha256": implementation}

    lock = threading.Lock()
    count = 0

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, payload, content_type="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == "/config":
                self.reply(200, json.dumps(config).encode())
            elif path in assets:
                file, kind = assets[path]
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(file.stat().st_size))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Cross-Origin-Opener-Policy", "same-origin")
                self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
                self.end_headers()
                with file.open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        self.wfile.write(chunk)
            else:
                self.reply(404, b"{}")

        def do_POST(self):
            nonlocal count
            if self.headers.get("Origin") != f"http://127.0.0.1:{args.port}":
                self.reply(403, b"{}")
                return
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size < 1024 * 1024:
                self.reply(400, b"{}")
                return
            result = json.loads(self.rfile.read(size))
            if self.path == "/pending":
                pending = {}
                with lock, args.output.with_suffix(".manifest.jsonl").open("a", encoding="utf-8") as out:
                    for model in models:
                        configuration = run_config(model, result["browser"])
                        pending[model["id"]] = [c["id"] for c in cases if digest({"case": c["case_sha256"], "config": configuration}) not in completed]
                        batch = digest({"config": configuration, "cases": case_hashes})
                        try:
                            check_batch(old, configuration, batch)
                        except ValueError as exc:
                            self.reply(409, json.dumps({"error": str(exc)}).encode())
                            return
                        out.write(json.dumps({"batch": batch, "config": configuration, "dataset": str(args.dataset),
                                              "expected_cases": len(cases), "case_hashes": case_hashes}) + "\n")
                self.reply(200, json.dumps(pending).encode())
                return
            if self.path == "/event":
                if result.get("model") and result.get("browser"):
                    model = next(m for m in models if m["id"] == result["model"])
                    result["config"] = run_config(model, result["browser"])
                with lock, args.output.with_suffix(".events.jsonl").open("a", encoding="utf-8") as out:
                    out.write(json.dumps(result, ensure_ascii=False) + "\n")
                print(json.dumps(result, ensure_ascii=True)[:1500], flush=True)
            elif self.path == "/result":
                case = indexed[result["case_id"]]
                model = next(m for m in models if m["id"] == result["model"])
                result.update(parse_output(result.get("raw", "")))
                result.update(expected=case["expected"], family=case["family"], domain=case["domain"],
                              language=case["language"], split=case["split"], label_source=case["label_source"],
                              case_sha256=case["case_sha256"], answer_kind=case["answer_kind"],
                              label_ambiguous=case["label_ambiguous"],
                              source_kind=case.get("source_kind", "unspecified"),
                              matched_across_languages=case.get("matched_across_languages", False),
                              challenge=case.get("challenge", "core"),
                              answer_language=case.get("answer_language", case["language"]),
                              config=run_config(model, result["browser"]))
                if result.get("error"):
                    result.update(valid_score=False, valid_output=False, score=None, failure="inference_error")
                result["run_key"] = digest({"case": case["case_sha256"], "config": result["config"]})
                result["batch"] = digest({"config": result["config"], "cases": case_hashes})
                result["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                with lock, args.output.open("a", encoding="utf-8") as out:
                    if result["run_key"] not in completed:
                        out.write(json.dumps(result, ensure_ascii=False) + "\n")
                        completed.add(result["run_key"])
                        count += 1
                if count % 10 == 0:
                    print(f"Browser results saved: {count}", flush=True)
            else:
                self.reply(404, b"{}")
                return
            self.reply(200, b"{}")

    print(f"Browser benchmark: http://127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
