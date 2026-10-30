"""Skills the chat agent reads on demand with read_skill.

The read_skill description lists each skill with when to read it; the skill's
text arrives as that tool's result, and later turns replay it from history
(evidence.history_turns). A write that needs a skill is refused until the
skill's text is in the request, which also catches a turn note or checkpoint
that folded it away; the refusal names the missing skills without their text
(Epo 2026-10-20), so a write takes a read_skill first.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from ..prompts import skills as prompts
from . import contract, deck, markdown_answer


@dataclass(frozen=True)
class Skill:
    when: str
    text: Callable[[], str]
    # The output-files preference (mainFormat) whose chapter explainers it writes.
    builds: str | None = None
    # Account chat's wording, where the text names the workspace.
    account: Callable[[], str] | None = None


EDITING = "editing"
NOTE_BUILDING = "note_building"
DECK_BUILDING = "deck_building"
OFFICE_BUILDING = "office_building"
FIGURES = "figures"
SKILLS: dict[str, Skill] = {
    EDITING: Skill(
        prompts.EDITING_WHEN, prompts.editing, account=prompts.account_editing
    ),
    NOTE_BUILDING: Skill(
        prompts.NOTE_BUILDING_WHEN,
        lambda: prompts.note_building(contract.FORMATS),
        builds="note",
        account=lambda: prompts.account_note_building(contract.FORMATS),
    ),
    DECK_BUILDING: Skill(
        prompts.DECK_BUILDING_WHEN,
        lambda: prompts.deck_building(
            prompts.deck_rules(deck.VIEWBOX),
            deck.DEFAULT_STYLE,
            deck.style_text(deck.DEFAULT_STYLE),
        ),
        builds="deck",
        account=lambda: prompts.account_deck_building(
            prompts.deck_rules(deck.VIEWBOX),
            deck.DEFAULT_STYLE,
            deck.style_text(deck.DEFAULT_STYLE),
        ),
    ),
    # Reading it offers the Office tools for the rest of the conversation
    # (tools._read_skill, Epo 2026-10-20).
    OFFICE_BUILDING: Skill(prompts.OFFICE_BUILDING_WHEN, prompts.office_building),
    # Offered only with the Markdown answer format (ToolContext.answer_format).
    FIGURES: Skill(prompts.FIGURES_WHEN, prompts.figures),
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


def offered(answer_format: str) -> list[str]:
    """The skills read_skill offers: figures only with the Markdown answer
    format, whose figure fences it describes."""
    return [
        name
        for name in SKILLS
        if name != FIGURES or answer_format == markdown_answer.MARKDOWN
    ]


def text(name: str, *, account: bool = False) -> str:
    """A skill's text in the chat's scope (the account profile's wording where
    the workspace one names the workspace)."""
    skill = SKILLS[name]
    return (skill.account or skill.text)() if account else skill.text()


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
    this turn or a replay from history."""
    names: set[str] = set()
    for message in messages:
        content = message.get("content")
        if (
            (message.get("role") == "tool" or message.get("_kind") == "skill")
            and isinstance(content, str)
            and content.startswith(_HEADER)
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


def refusal(needs: list[str], *, write: bool) -> str:
    """A call refused for the skills it lacks, not applied. It carries no
    skill text (Epo 2026-10-20: a refusal that carried the skill made an
    unrequested write one resend away), so a write takes a deliberate
    read_skill first, which a requested write the agent skipped pays for with
    one extra call. A read that needs a skill (inspect_office_document needs
    office_building) is worded as a read."""
    one = len(needs) == 1
    names = " and ".join(needs)
    return (
        f"Not applied: this {'write' if write else 'read'} needs the {names} "
        f"skill{'' if one else 's'}, not read yet. Read "
        f"{'it' if one else 'them'} with read_skill only if the user wants this "
        + (
            "file created or changed; otherwise answer without writing."
            if write
            else "file read; otherwise answer without reading it."
        )
    )
