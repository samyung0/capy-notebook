"""Bounded, first-attempt-only OCR/caption comparison on frozen page images."""

import argparse
import asyncio
import base64
import hashlib
import json
import time
from pathlib import Path

import httpx
from bench_java_recovery import encode
from dotenv import dotenv_values


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def request(arm: str, url: str, prompt: str) -> tuple[str, dict]:
    if arm == "ocr-document":
        return "/api/v1/services/aigc/multimodal-generation/generation", {
            "model": "qwen3.5-ocr",
            "input": {
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "image": url,
                                "min_pixels": 3072,
                                "max_pixels": 8388608,
                                "enable_rotate": False,
                            }
                        ],
                    }
                ]
            },
            "parameters": {
                "ocr_options": {"task": "document_parsing"},
                "max_tokens": 16384,
            },
        }
    model = {"ocr-chat": "qwen3.5-ocr", "flash-chat": "qwen3.8-flash"}[arm]
    body = {
        "model": model,
        "max_tokens": 16384,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": url}},
                ],
            }
        ],
    }
    if arm == "flash-chat":
        body["enable_thinking"] = False
    return "/compatible-mode/v1/chat/completions", body


async def run(args: argparse.Namespace) -> None:
    manifest = json.loads(args.manifest.read_text())
    pages = manifest["pages"]
    if args.ids:
        pages = [p for p in pages if p["id"] in args.ids]
        if {p["id"] for p in pages} != set(args.ids):
            raise ValueError("unknown page ID")
    jobs = [(page, arm) for page in pages for arm in args.arms]
    if not jobs or len(jobs) > args.request_limit or not 1 <= args.concurrency <= 4:
        raise ValueError("invalid explicit request count or concurrency")
    if len({(p["id"], arm) for p, arm in jobs}) != len(jobs):
        raise ValueError("duplicate jobs")
    key = dotenv_values(args.key_env).get("ALIBABA_API_KEY")
    if not key:
        raise ValueError("provider credential missing")
    args.output.mkdir(parents=True, exist_ok=False)
    prompt = args.prompt.read_text()
    receipt = {
        "manifest": manifest,
        "manifest_sha256": digest(args.manifest.read_bytes()),
        "prompt": prompt,
        "prompt_sha256": digest(prompt.encode()),
        "host": args.host,
        "arms": args.arms,
        "concurrency": args.concurrency,
        "request_limit": args.request_limit,
        "max_edge": 2560,
        "encoding": "shared bench_java_recovery.encode: JPEG quality80; no upscaling",
        "started_unix": time.time(),
        "script_sha256": digest(Path(__file__).read_bytes()),
        "encoder_script_sha256": digest(
            Path(__file__).with_name("bench_java_recovery.py").read_bytes()
        ),
    }
    save(args.output / "run.json", receipt)
    (args.output / "runner.py.snapshot").write_bytes(Path(__file__).read_bytes())
    (args.output / "encoder.py.snapshot").write_bytes(
        Path(__file__).with_name("bench_java_recovery.py").read_bytes()
    )
    gate = asyncio.Semaphore(args.concurrency)
    started = time.monotonic()
    async with httpx.AsyncClient(
        timeout=240, limits=httpx.Limits(max_connections=args.concurrency)
    ) as client:

        async def one(page: dict, arm: str) -> dict:
            async with gate:
                call_started = time.monotonic()
                record = {
                    "page": page["id"],
                    "arm": arm,
                    "state": "error",
                    "started_unix": time.time(),
                }
                try:
                    source = Path(page["image"])
                    if digest(source.read_bytes()) != page["image_sha256"]:
                        raise ValueError("source hash mismatch")
                    data, size = encode(source, 2560)
                    url = "data:image/jpeg;base64," + base64.b64encode(data).decode()
                    route, body = request(arm, url, prompt)
                    _, options = request(
                        arm, "[image bytes identified by encoded_sha256]", prompt
                    )
                    record.update(
                        source=page,
                        encoded_sha256=digest(data),
                        encoded_bytes=len(data),
                        encoded_size=size,
                        endpoint=args.host + route,
                        request=options,
                    )
                    response = await client.post(
                        args.host + route,
                        headers={"Authorization": "Bearer " + key},
                        json=body,
                    )
                    record["http_status"] = response.status_code
                    record["response_raw"] = response.text.replace(key, "[REDACTED]")
                    response.raise_for_status()
                    payload = json.loads(record["response_raw"])
                    record["response"] = payload
                    choices = (
                        payload["output"]["choices"]
                        if arm == "ocr-document"
                        else payload["choices"]
                    )
                    choice = choices[0]
                    content = choice["message"]["content"]
                    record.update(
                        content=content,
                        finish_reason=choice.get("finish_reason"),
                        usage=payload.get("usage"),
                    )
                    record["state"] = (
                        "ok"
                        if content and choice.get("finish_reason") == "stop"
                        else "incomplete"
                    )
                except (
                    httpx.HTTPError,
                    ValueError,
                    KeyError,
                    TypeError,
                    IndexError,
                    OSError,
                ) as exc:
                    record["error_type"] = type(exc).__name__
                record["seconds"] = time.monotonic() - call_started
                save(args.output / f"{page['id']}--{arm}.json", record)
                print(
                    page["id"],
                    arm,
                    record["state"],
                    round(record["seconds"], 2),
                    flush=True,
                )
                return record

        records = await asyncio.gather(*(one(page, arm) for page, arm in jobs))
    save(
        args.output / "complete.json",
        {
            "requests": len(records),
            "ok": sum(r["state"] == "ok" for r in records),
            "seconds": time.monotonic() - started,
        },
    )


def check() -> None:
    route, body = request(
        "ocr-document", "data:image/jpeg;base64,eA==", "source prompt"
    )
    assert (
        route.startswith("/api/v1/")
        and body["parameters"]["ocr_options"]["task"] == "document_parsing"
    )
    assert body["input"]["messages"][0]["content"][0]["enable_rotate"] is False
    route, body = request("flash-chat", "image", "source prompt")
    assert (
        body["enable_thinking"] is False
        and body["messages"][0]["content"][0]["text"] == "source prompt"
    )
    assert "enable_thinking" not in request("ocr-chat", "image", "prompt")[1]
    assert "response_format" not in body and body["max_tokens"] == 16384
    print("OCR request contract check passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--prompt", type=Path)
    parser.add_argument("--key-env", type=Path)
    parser.add_argument("--host")
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--arms", nargs="+", choices=["ocr-document", "ocr-chat", "flash-chat"]
    )
    parser.add_argument("--ids", nargs="+")
    parser.add_argument("--request-limit", type=int)
    parser.add_argument("--concurrency", type=int)
    arguments = parser.parse_args()
    if arguments.check:
        check()
    else:
        if any(
            getattr(arguments, field) is None
            for field in [
                "manifest",
                "prompt",
                "key_env",
                "host",
                "output",
                "arms",
                "request_limit",
                "concurrency",
            ]
        ):
            parser.error("all run options except --ids are required")
        if not arguments.host.startswith("https://") or "/" in arguments.host[8:]:
            parser.error("host must be an HTTPS origin")
        asyncio.run(run(arguments))
