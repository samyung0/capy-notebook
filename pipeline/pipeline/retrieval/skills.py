"""Skills the chat agent reads on demand with read_skill.

The read_skill description lists each skill with when to read it; the skill's
text arrives as that tool's result. A write that needs a skill is refused
until the skill's result is in the request, which also catches a turn note
that folded the result away.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..prompts import skills as prompts
from . import contract


@dataclass(frozen=True)
class Skill:
    when: str
    text: Callable[[bool], str]  # library on -> instructions


EDITING = "editing"
BUILDING = "workspace_building"
SKILLS: dict[str, Skill] = {
    EDITING: Skill(
        prompts.EDITING_WHEN, lambda library: prompts.editing(library=library)
    ),
    BUILDING: Skill(
        prompts.BUILDING_WHEN,
        lambda library: prompts.workspace_building(contract.FORMATS, library=library),
    ),
}

# The skills each write needs. edit_document needs workspace_building only for
# the commands that carry its formats.
REQUIRES: dict[str, tuple[str, ...]] = {
    "create_ledger": (EDITING,),
    "copy_questions": (EDITING,),
    "create_material": (EDITING, BUILDING),
    "edit_document": (EDITING, BUILDING),
}
FORMAT_COMMANDS = frozenset({"insert_markdown", "add_question", "replace_question"})

_HEADER = "# Skill: "


def catalog() -> str:
    """Appended to the read_skill description."""
    return "\n\nSkills:\n" + "\n".join(
        catalog_line(name, skill.when) for name, skill in SKILLS.items()
    )


def catalog_line(name: str, when: str) -> str:
    return f"- {name}: {when}."


def render(name: str, text: str) -> str:
    return f"{_HEADER}{name}\n\n{text}"


def retained(messages: list[dict[str, Any]]) -> set[str]:
    """Skills whose read_skill result is still in the message list."""
    names: set[str] = set()
    for message in messages:
        content = message.get("content")
        if (
            message.get("role") == "tool"
            and isinstance(content, str)
            and content.startswith(_HEADER)
        ):
            names.add(content[len(_HEADER) :].partition("\n")[0])
    return names


def missing(
    name: str,
    args: dict[str, Any],
    read: set[str],
    requires: dict[str, tuple[str, ...]] = REQUIRES,
) -> list[str]:
    """The skills a write needs and has not read."""
    needs = requires.get(name, ())
    if name == "edit_document" and not any(
        isinstance(command, dict) and command.get("type") in FORMAT_COMMANDS
        for command in args.get("commands") or []
    ):
        needs = tuple(n for n in needs if n != BUILDING)
    return [n for n in needs if n not in read]


def refusal(needs: list[str]) -> str:
    calls = " and ".join(f'read_skill({{"name": "{n}"}})' for n in needs)
    return f"Read the skills this write needs first: {calls}, then write."
