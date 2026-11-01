"""Import real chats from a target database as playground runs, so a tuning
session can open one and continue it (Epo 2026-10-30).

Each assistant answer of a conversation becomes one run: the earlier messages
as its history, the learner message before it as its question and the stored
answer with its toolEvidence as the turn's done event. Opening the run in the
page restores that conversation; the next question runs under the selected
config, which must name the conversation's user in ``account`` (or its
workspace) to reach the same files.

    uv run --project pipeline python lab/playground/scripts/import_chat.py --target uat conv_a8be00792c ...

Read-only: one SELECT per conversation. Runs land in local/runs/uat-<conversation>-t<n>-<question>.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

from common import LOCAL, OPENED, TARGETS, prepare_environment

RUNS = LOCAL / "runs"


def slug(text: str) -> str:
    words = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return words[:40].rstrip("-") or "turn"


def history_row(row: dict) -> dict:
    """A message as the page keeps it and the gateway sends it."""
    meta = row["metadata"] or {}
    item = {"id": row["id"], "role": row["role"], "content": row["content"] or ""}
    if row["role"] == "user":
        item["workspaceOnly"] = bool(meta.get("workspaceOnly"))
    elif meta.get("toolEvidence"):
        item["toolEvidence"] = meta["toolEvidence"]
    return item


def runs_of(conversation: dict, rows: list[dict], target: str) -> list[dict]:
    out = []
    turn = 0
    for i, row in enumerate(rows):
        if row["role"] != "assistant" or i == 0 or rows[i - 1]["role"] != "user":
            continue
        turn += 1
        question = rows[i - 1]
        meta = row["metadata"] or {}
        model = {
            "provider_slug": meta.get("providerSlug"),
            "model_slug": meta.get("modelSlug"),
            "version": int(meta["modelVersion"]) if meta.get("modelVersion") else None,
        }
        workspace = conversation["workspace_id"]
        config = (
            {"workspace_id": workspace}
            if workspace
            else {"account": {"user_id": conversation["user_id"]}}
        ) | {"model": model}
        out.append(
            {
                "id": f"{target}-{conversation['id']}-t{turn}-{slug(question['content'] or '')}",
                "imported": {
                    "target": target,
                    "conversation": conversation["id"],
                    "message": row["id"],
                    "status": row["status"],
                    "created_at": row["created_at"].isoformat(),
                },
                "config": config,
                "question": question["content"] or "",
                "history": [history_row(r) for r in rows[: i - 1]],
                "workspace_only": bool((question["metadata"] or {}).get("workspaceOnly")),
                "system_prompt": f"(imported from {target}: the prompt the stored answer was written under is not recorded)",
                "answer": row["content"] or "",
                "events": [
                    {
                        "type": "done",
                        "answer": row["content"] or "",
                        "toolEvidence": meta.get("toolEvidence"),
                        "telemetry": {"stopReason": f"imported ({row['status']})"},
                    }
                ],
                "materials": [],
                "checkpoint_in": None,
            }
        )
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=sorted(TARGETS), default="uat")
    parser.add_argument("conversations", nargs="+")
    args = parser.parse_args()
    try:
        imported(args, prepare_environment(args.target))
    finally:
        for tunnel in OPENED:
            tunnel.terminate()


def imported(args: argparse.Namespace, dsn: str) -> None:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        conn.read_only = True
        for conversation_id in args.conversations:
            conversation = conn.execute(
                "SELECT id, user_id, workspace_id FROM conversations WHERE id = %s",
                (conversation_id,),
            ).fetchone()
            if conversation is None:
                print(f"{conversation_id}: no such conversation", file=sys.stderr)
                continue
            rows = conn.execute(
                "SELECT id, role, content, status, metadata, created_at FROM messages "
                "WHERE conversation_id = %s ORDER BY created_at, id",
                (conversation_id,),
            ).fetchall()
            for run in runs_of(conversation, rows, args.target):
                path = RUNS / run["id"] / "run.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")
                print(run["id"])


if __name__ == "__main__":
    main()
