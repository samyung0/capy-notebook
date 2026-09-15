"""One-shot public-source search checks; credentials come from a hidden prompt."""

import argparse
import getpass
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def request(url, payload=None, key=None):
    headers = {"User-Agent": "CapyNotebook-search-feasibility/0.1"}
    if key:
        headers["Authorization"] = "Bearer " + key
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, data=data, headers=headers), timeout=150
        ) as response:
            status = response.status
            body = json.load(response)
    except urllib.error.HTTPError as error:
        status = error.code
        body = {"error": error.read().decode(errors="replace")}
    except (OSError, ValueError) as error:
        status = None
        body = {"error": str(error)}
    # An upstream error must not echo credentials into the saved record.
    if key:
        body = json.loads(json.dumps(body).replace(key, "[REDACTED]"))
    return {
        "at": datetime.now(timezone.utc).isoformat(),
        "seconds": round(time.perf_counter() - started, 3),
        "http_status": status,
        "response": body,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("provider", choices=["alibaba", "commons", "openverse"])
    parser.add_argument("--host")
    parser.add_argument("--model")
    parser.add_argument("--thinking", action="store_true")
    parser.add_argument(
        "--tool",
        action="append",
        choices=["web_search", "web_search_image", "web_extractor"],
    )
    parser.add_argument("--query", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    key = None
    payload = None
    if args.provider == "alibaba":
        if not args.host or not args.model or not args.tool:
            parser.error("Alibaba requires --host, --model, and --tool")
        if not args.host.endswith(".cn-beijing.maas.aliyuncs.com"):
            parser.error("This experiment accepts only a Beijing workspace hostname")
        url = "https://" + args.host + "/compatible-mode/v1/responses"
        payload = {
            "model": args.model,
            "input": args.query,
            "tools": [{"type": tool} for tool in args.tool],
            "max_output_tokens": 3000,
            "enable_thinking": args.thinking,
        }
        key = getpass.getpass("API key: ").replace("\\_", "_")
    elif args.provider == "commons":
        params = {
            "action": "query",
            "format": "json",
            "generator": "search",
            "gsrsearch": args.query,
            "gsrnamespace": 6,
            "gsrlimit": 10,
            "prop": "imageinfo",
            "iiprop": "url|size|extmetadata",
            "iiurlwidth": 640,
            "iiextmetadatafilter": "Artist|LicenseShortName|LicenseUrl|AttributionRequired|ImageDescription",
        }
        url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(
            params
        )
    else:
        params = {"q": args.query, "page_size": 10}
        url = "https://api.openverse.org/v1/images/?" + urllib.parse.urlencode(params)
    result = request(url, payload, key)
    result.update(provider=args.provider, query=args.query, request=payload)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    summary = {k: result[k] for k in ("provider", "seconds", "http_status")}
    summary["output"] = str(args.output)
    body = result["response"]
    if isinstance(body, dict):
        summary["status"] = body.get("status")
        summary["usage"] = body.get("usage")
        summary["error"] = body.get("error")
        if isinstance(body.get("output"), list):
            summary["output_types"] = [item.get("type") for item in body["output"]]
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
