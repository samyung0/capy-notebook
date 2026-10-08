"""Skills the chat agent reads on demand with read_skill.

The read_skill description lists each skill with when to read it; the skill's
text arrives as that tool's result, and later turns replay it from history
(evidence.history_turns). A write that needs a skill is refused until the
skill's text is in the request, which also catches a turn note or checkpoint
that folded it away; the refusal carries the missing skills' text, so the
resent write needs no read_skill.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from ..prompts import skills as prompts
from . import contract, deck


@dataclass(frozen=True)
class Skill:
    when: str
    text: Callable[[bool], str]  # library on -> instructions


EDITING = "editing"
BUILDING = "workspace_building"
DECK = "deck"
SKILLS: dict[str, Skill] = {
    EDITING: Skill(
        prompts.EDITING_WHEN, lambda library: prompts.editing(library=library)
    ),
    BUILDING: Skill(
        prompts.BUILDING_WHEN,
        lambda library: prompts.workspace_building(contract.FORMATS, library=library),
    ),
    DECK: Skill(
        prompts.DECK_WHEN,
        lambda _library: prompts.deck(
            prompts.deck_rules(deck.VIEWBOX),
            deck.DEFAULT_STYLE,
            deck.style_text(deck.DEFAULT_STYLE),
        ),
    ),
}

# The skills each write needs. edit_document needs workspace_building only for
# the commands that carry its formats.
REQUIRES: dict[str, tuple[str, ...]] = {
    "create_ledger": (EDITING,),
    "copy_questions": (EDITING,),
    "create_material": (EDITING, BUILDING),
    "edit_document": (EDITING, BUILDING),
    "create_deck": (EDITING, DECK),
    "write_slide": (EDITING, DECK),
}
FORMAT_COMMANDS = frozenset({"insert_markdown", "add_question", "replace_question"})

_HEADER = "# Skill: "
_HEADER_LINE = re.compile(r"^# Skill: (\S+)$", re.MULTILINE)
# How a write refused for unread skills starts; the skills follow it.
_CARRIED = "Not applied: this write needs the "


def catalog(names: Iterable[str] = SKILLS) -> str:
    """Appended to the read_skill description: the skills this turn offers."""
    return "\n\nSkills:\n" + "\n".join(
        catalog_line(name, SKILLS[name].when) for name in names
    )


def catalog_line(name: str, when: str) -> str:
    return f"- {name}: {when}."


def render(name: str, text: str) -> str:
    return f"{_HEADER}{name}\n\n{text}"


def retained(messages: list[dict[str, Any]]) -> set[str]:
    """Skills whose text is still in the message list: a read_skill result of
    this turn, a replay from history, or the skills a refused write carried."""
    names: set[str] = set()
    for message in messages:
        content = message.get("content")
        if (
            (message.get("role") == "tool" or message.get("_kind") == "skill")
            and isinstance(content, str)
            and content.startswith((_HEADER, _CARRIED))
        ):
            names.update(_HEADER_LINE.findall(content))
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
    """A write refused for the skills it lacks. Their text follows it
    (``carried``), so they count as read from then on and the retry needs no
    read_skill; the write itself is not applied."""
    one = len(needs) == 1
    return (
        f"{_CARRIED}{' and '.join(needs)} skill{'' if one else 's'}, which "
        f"follow{'s' if one else ''} and now count{'s' if one else ''} as read. "
        f"Check the write against {'it' if one else 'them'} and send it again."
    )


def carried(needs: list[str], text: Callable[[str], str]) -> str:
    """The skills a refused write lacks, each under its header."""
    return "\n\n".join(render(name, text(name)) for name in needs)
