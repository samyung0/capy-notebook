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


SKILLS: dict[str, Skill] = {
    "materials": Skill(
        prompts.MATERIALS_WHEN,
        lambda library: prompts.materials(contract.FORMATS, library=library),
    ),
}

# The skill each write needs. edit_document needs it only for the commands
# that carry the formats.
REQUIRES: dict[str, str] = {
    "create_material": "materials",
    "edit_document": "materials",
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
    requires: dict[str, str] = REQUIRES,
) -> str | None:
    """The skill a write needs and has not read, or None."""
    need = requires.get(name)
    if need is None or need in read:
        return None
    if name == "edit_document" and not any(
        isinstance(command, dict) and command.get("type") in FORMAT_COMMANDS
        for command in args.get("commands") or []
    ):
        return None
    return need


def refusal(need: str) -> str:
    return f'Read the {need} skill first: read_skill({{"name": "{need}"}}), then write.'
