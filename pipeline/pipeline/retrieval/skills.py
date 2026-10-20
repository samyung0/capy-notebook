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
    # The output-files preference (mainFormat) whose chapter explainers it writes.
    builds: str | None = None


EDITING = "editing"
NOTE_BUILDING = "note_building"
DECK_BUILDING = "deck_building"
OFFICE_BUILDING = "office_building"
SKILLS: dict[str, Skill] = {
    EDITING: Skill(
        prompts.EDITING_WHEN, lambda library: prompts.editing(library=library)
    ),
    NOTE_BUILDING: Skill(
        prompts.NOTE_BUILDING_WHEN,
        lambda library: prompts.note_building(contract.FORMATS, library=library),
        builds="note",
    ),
    DECK_BUILDING: Skill(
        prompts.DECK_BUILDING_WHEN,
        lambda _library: prompts.deck_building(
            prompts.deck_rules(deck.VIEWBOX),
            deck.DEFAULT_STYLE,
            deck.style_text(deck.DEFAULT_STYLE),
        ),
        builds="deck",
    ),
    # Reading it offers the Office tools for the rest of the conversation
    # (tools._read_skill, Epo 2026-10-20).
    OFFICE_BUILDING: Skill(
        prompts.OFFICE_BUILDING_WHEN, lambda _library: prompts.office_building()
    ),
}

# The skills each tool needs: editing for every write, note_building for note
# markdown (a note created, or edit_document's commands that carry it),
# deck_building for a deck, office_building for every Office read and write.
REQUIRES: dict[str, tuple[str, ...]] = {
    "create_material": (EDITING, NOTE_BUILDING),
    "add_questions": (EDITING,),
    "add_question_media": (EDITING,),
    "edit_document": (EDITING, NOTE_BUILDING),
    "create_deck": (EDITING, DECK_BUILDING),
    "write_slide": (EDITING, DECK_BUILDING),
    "inspect_office_document": (OFFICE_BUILDING,),
    "edit_office_document": (EDITING, OFFICE_BUILDING),
}
FORMAT_COMMANDS = frozenset({"insert_markdown", "replace_block"})

_HEADER = "# Skill: "
_HEADER_LINE = re.compile(r"^# Skill: (\S+)$", re.MULTILINE)
# How a write refused for unread skills starts; the skills follow it.
_CARRIED = "Not applied: this call needs the "


def catalog(main_format: str, names: Iterable[str] = SKILLS) -> str:
    """Appended to the read_skill description: the skills this turn offers,
    the building skill of the output-files preference as the one for the
    chapters and the other for a request that asks for its format."""
    return "\n\nSkills:\n" + "\n".join(
        catalog_line(name, when(name, main_format)) for name in names
    )


def when(name: str, main_format: str) -> str:
    skill = SKILLS[name]
    if skill.builds is None:
        return skill.when
    if skill.builds == main_format:
        return f"{skill.when}; the chapters' main explainers are {skill.builds}s"
    return f"{skill.when}, only when the request asks for a {skill.builds}"


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
    note_markdown = (
        args.get("kind") == "note"
        if name == "create_material"
        else any(
            isinstance(command, dict) and command.get("type") in FORMAT_COMMANDS
            for command in args.get("commands") or []
        )
    )
    if name in ("create_material", "edit_document") and not note_markdown:
        needs = tuple(n for n in needs if n != NOTE_BUILDING)
    return [n for n in needs if n not in read]


def refusal(needs: list[str]) -> str:
    """A write refused for the skills it lacks. Their text follows it
    (``carried``), so they count as read from then on and the retry needs no
    read_skill; the write itself is not applied."""
    one = len(needs) == 1
    return (
        f"{_CARRIED}{' and '.join(needs)} skill{'' if one else 's'}, which "
        f"follow{'s' if one else ''} and now count{'s' if one else ''} as read. "
        f"Check the call against {'it' if one else 'them'} and send it again."
    )


def carried(needs: list[str], text: Callable[[str], str]) -> str:
    """The skills a refused write lacks, each under its header."""
    return "\n\n".join(render(name, text(name)) for name in needs)
