"""Two real playground curate turns: a note, then flashcards from the same topic.

The playground must already be running with read-only database access. This
uses its selected config unchanged and writes only the playground's local runs.
Run: python bench/rag/scripts/knowledge_retention_agent.py --config curate
"""

import argparse
import json
from collections import Counter
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--url", default="http://127.0.0.1:18765")
    args = parser.parse_args()

    def get(path):
        with urlopen(args.url + path, timeout=30) as response:
            return json.load(response)

    config = get("/api/configs/" + args.config)["raw"]
    assert config["curate"], "Choose a curate config"
    history, ledger, checkpoint = [], None, None
    next_id = 1
    questions = [
        (
            "Create one short study note, at most 250 words, explaining diffusion "
            "and osmosis across cell membranes for an introductory college student. "
            "Only one note for now."
        ),
        "Now make four flashcards on the same material.",
    ]
    for question in questions:
        request = Request(
            args.url + "/api/turn",
            data=json.dumps(
                {
                    "config": config,
                    "question": question,
                    "history": history,
                    "ledger": ledger,
                    "checkpoint": checkpoint,
                }
            ).encode(),
            headers={"Content-Type": "application/json"},
        )
        history.append({"id": f"m{next_id}", "role": "user", "content": question})
        next_id += 1
        done, run_id = None, None
        print(json.dumps({"question": question}), flush=True)
        with urlopen(request, timeout=600) as response:
            for line in response:
                if not line.startswith(b"data: "):
                    continue
                event = json.loads(line[6:])
                kind = event.get("type")
                if kind == "ledger":
                    ledger = event["stored"]
                elif kind == "checkpoint":
                    checkpoint = {k: v for k, v in event.items() if k != "type"}
                    cut = next(
                        (
                            i
                            for i, m in enumerate(history)
                            if m["id"] == event["throughMessageId"]
                        ),
                        -1,
                    )
                    history = history[cut + 1 :]
                elif kind == "done":
                    done = event
                elif kind == "error":
                    raise RuntimeError(event)
                elif kind == "run_saved":
                    run_id = event["id"]
        assert done is not None and run_id is not None, "Incomplete turn"
        run = get("/api/runs/" + run_id)
        ledger = run["ledger"]["stored"]
        history.append(
            {
                "id": f"m{next_id}",
                "role": "assistant",
                "content": done["answer"],
                "toolEvidence": done["toolEvidence"],
            }
        )
        next_id += 1
        print(
            json.dumps(
                {
                    "run": run_id,
                    "tools": dict(Counter(c["name"] for c in run["calls"])),
                    "refused": [
                        c["name"] for c in run["calls"] if c["outcome"] != "succeeded"
                    ],
                    "retained_pages": len(
                        done["toolEvidence"].get("libraryExcerpts", [])
                    ),
                    "first_input_tokens": run["provider_calls"][0]["input_tokens"],
                    "first_history_tokens_est": run["provider_calls"][0]["context"][
                        "parts"
                    ]["history"],
                    "materials": [
                        {"id": m["id"], "kind": m["kind"], "title": m["title"]}
                        for m in run["materials"]
                    ],
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    main()
