"""Continue the frozen plan after a transport failure, keeping each first attempt."""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, "/lab")
import run_agent
from index_corpus import ROOT, guard


def main():
    guard()
    freeze = json.loads((ROOT / "chat-freeze.json").read_text())
    for name, digest in freeze["files"].items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, name
    assert (
        hashlib.sha256(Path("/lab/lab_server.py").read_bytes()).hexdigest()
        == freeze["lab_server_sha256"]
    )
    attempted = [
        json.loads(line) for line in (ROOT / "chat.jsonl").read_text().splitlines()
    ]
    amendment = {
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "reason": "Continue remaining planned turns after a stream read error; each first attempt, including failure, remains in the primary denominator. No failed turn is retried.",
        "original_recorder_sha256": freeze["recorder_sha256"],
        "resumed_recorder_sha256": hashlib.sha256(
            Path(run_agent.__file__).read_bytes()
        ).hexdigest(),
        "attempts_before_resume": len(attempted),
        "failed_messages": [r["message_id"] for r in attempted if r["errors"]],
    }
    path = ROOT / "resume-amendments.jsonl"
    with path.open("a") as stream:
        stream.write(json.dumps(amendment) + "\n")
    questions = json.loads((ROOT / "corpus/questions.json").read_text())
    locales = {
        f"eval {q['id']} {v} {i}": "zh" if q["language"] == "zh" else "en"
        for q in questions
        for v in freeze["variants"]
        for i in range(2)
    }
    request = run_agent.request
    original = request("http://127.0.0.1:8082/api/me")["locale"]

    def with_locale(url, data=None, **kwargs):
        if url.endswith("/conversations") and isinstance(data, dict):
            request(
                "http://127.0.0.1:8082/api/me/locale",
                {"locale": locales[data["title"]]},
                method="PATCH",
            )
        return request(url, data, **kwargs)

    run_agent.request = with_locale
    try:
        run_agent.run(
            ROOT,
            argparse.Namespace(
                variants="baseline,follow_links_ids",
                split="holdout",
                repeats=2,
                output="chat.jsonl",
                ids=None,
                skip_attempted=True,
            ),
        )
    finally:
        request(
            "http://127.0.0.1:8082/api/me/locale", {"locale": original}, method="PATCH"
        )


if __name__ == "__main__":
    main()
