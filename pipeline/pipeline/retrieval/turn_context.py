"""The turn context: one always-current message at the end of each request.

It carries what the model must see on every call but must not compact away:
the file the learner has open, their study preferences, the library excerpts
read this message and the budget left. Chapters come from list_sources
(Epo 2026-10-25).
The loop rebuilds it before each request and sends it last, leaving earlier
copies where they were sent so each request extends the previous one; it never
reaches the stored conversation.
"""

from __future__ import annotations

from typing import Any

from ..prompts import preferences
from .tools import ToolContext

HEADER = "Turn context (current at this step; a later one replaces it):"

# The last response's notice, for a turn that can write (a write landed or the
# writing skill is in the request; writes are refused without it) and for one
# that only answers (Epo 2026-10-14).
FINAL_NOTICE = (
    "\nTools are off for this response. Answer now: the materials made so far "
    "and what each covers, what is left of the request, and what the learner can "
    "ask next to continue."
)
FINAL_ANSWER_NOTICE = (
    "\nTools are off for this response. Answer now with what you found, and say "
    "what is still open."
)
UNSAVED_DECK = " A deck with slides left unwritten was not saved: say so."


def tools_off(messages: list[dict[str, Any]]) -> bool:
    """Whether a request is a tools-off call. The tools stay in the request,
    so its turn context's final notice is the only sign (tests, playground).
    Matches on content because provider messages lose `_kind`."""
    return any(
        m.get("role") == "user"
        and isinstance(m.get("content"), str)
        and (FINAL_NOTICE in m["content"] or FINAL_ANSWER_NOTICE in m["content"])
        for m in messages
    )


# What the learner may do in this workspace, said with the open item.
_ROLE_LINES = {
    "owner": "The learner owns this workspace.",
    "editor": "The learner can edit this workspace.",
    "viewer": "The learner can only view this workspace.",
}


def _open_line(
    resource: dict[str, Any], chapters: list[dict[str, Any]], role: str
) -> str:
    return f"{_open_item(resource, chapters)} {_ROLE_LINES[role]}"


def _open_item(resource: dict[str, Any], chapters: list[dict[str, Any]]) -> str:
    if not resource.get("id"):
        return "Open: nothing."
    title = str(resource.get("title") or "").strip() or "untitled"
    where = next(
        (
            f", in chapter {chapter['name']} [{chapter['id']}]"
            for chapter in chapters
            if chapter["id"] == resource.get("chapter_id")
        ),
        "",
    )
    return f"Open: {title} ({resource.get('kind') or 'file'} {resource['id']}){where}."


def message(
    ctx: ToolContext, *, final: bool = False, allowance: str = "", writing: bool = True
) -> dict[str, Any]:
    lines = [
        HEADER,
        _open_line(ctx.open_resource, ctx.chapters, ctx.role),
        "\nStudy preferences (a request that names one material gets only that material):",
    ]
    lines.extend(f"- {line}" for line in preferences.lines(ctx.study_preferences))
    # One line per excerpt: a second page of the same excerpt is the same input,
    # and the model pays for every line on every call.
    sections: dict[str, str] = {}
    for read in ctx.library_reads.reads:
        sections.setdefault(read.excerpt_id, read.section)
    if sections:
        lines.append("\nLibrary excerpts read for this message:")
        lines.extend(f"- {eid} {section}" for eid, section in sections.items())
    if final and not writing:
        lines.append(FINAL_ANSWER_NOTICE)
    elif final:
        unsaved = any(not record.get("file") for record in ctx.decks.values())
        lines.append(FINAL_NOTICE + (UNSAVED_DECK if unsaved else ""))
    elif allowance:
        lines.append(allowance)
    return {"role": "user", "content": "\n".join(lines), "_kind": "turn_context"}
