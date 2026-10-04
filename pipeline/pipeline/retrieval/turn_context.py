"""The turn context: one always-current message placed right after the query.

It carries what the model must see on every call but must not compact away:
the file the learner has open, their study preferences, the ledger's todos and
the library excerpts read this message. The loop rebuilds it before each
request; it is never part of the message history.
"""

from __future__ import annotations

from typing import Any

from ..prompts import preferences
from .tools import ToolContext

HEADER = "Turn context (kept outside the message list, always current):"

FINAL_NOTICE = (
    "\nTools are off for this response. Answer now: the materials made so far "
    "and what each covers, which todos are still open, and what the learner can "
    "ask next to continue."
)


def _open_line(resource: dict[str, Any]) -> str:
    if not resource.get("id"):
        return "Open: nothing."
    title = str(resource.get("title") or "").strip() or "untitled"
    return f"Open: {title} ({resource.get('kind') or 'file'} {resource['id']})."


def message(
    ctx: ToolContext, *, final: bool = False, allowance: str = ""
) -> dict[str, Any]:
    lines = [HEADER, _open_line(ctx.open_resource), "\nStudy preferences:"]
    lines.extend(f"- {line}" for line in preferences.lines(ctx.study_preferences))
    ledger = ctx.ledger
    if ledger.todos:
        # Finished todos leave the ledger when it is stored, but an id belongs
        # to its todo for the life of the conversation.
        lines.append("\nLedger todos — pass an id as todo; ids never change:")
        lines.extend(
            f"[{'x' if todo.done else ' '}] {todo.id}. {todo.text}"
            for todo in ledger.todos
        )
    # One line per excerpt: a second page of the same excerpt is the same input,
    # and the model pays for every line on every call.
    sections: dict[str, str] = {}
    for read in ledger.reads:
        sections.setdefault(read.excerpt_id, read.section)
    if sections:
        lines.append("\nLibrary excerpts read for this message:")
        lines.extend(f"- {eid} {section}" for eid, section in sections.items())
    if final:
        lines.append(FINAL_NOTICE)
    elif allowance:
        lines.append(allowance)
    return {"role": "user", "content": "\n".join(lines), "_kind": "ledger"}
