"""copy_questions: question-bank questions copied by id instead of written out.

Playground-only until todo-learning.md 2.5 gives Go the copy (Go already holds
the bank's DSN). The model names questions and a destination; the copy is
exact, carries each question's bank sources, and costs no output tokens, so a
large quiz no longer streams back as one silent tool call.
"""

from __future__ import annotations

from typing import Any

from jsonschema import Draft202012Validator

NAME = "copy_questions"
MAX_QUESTIONS = 20
SCHEMA = {
    "type": "function",
    "function": {
        "name": NAME,
        "description": (
            "Copy question-bank questions by id, exactly as published with their worked "
            "solutions, marking schemes and sources, instead of writing them out. Give "
            "exactly one destination: title (and optional chapter_id) for a new quiz, "
            "quiz_id for a quiz this conversation made, or note_id for a note this "
            "conversation made, where they go in as one embedded quiz at its end. Pass "
            "todo while the ledger has open todos."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": MAX_QUESTIONS,
                    "uniqueItems": True,
                },
                "title": {"type": "string", "minLength": 1, "maxLength": 200},
                "chapter_id": {"type": "string"},
                "quiz_id": {"type": "string"},
                "note_id": {"type": "string"},
                "todo": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Id of the open ledger todo this write completes.",
                },
            },
            "required": ["question_ids"],
            "additionalProperties": False,
        },
    },
}
ADDON = (
    "\n\nCopy question-bank questions with copy_questions by id instead of writing "
    "them out; read_question is for judging a question before choosing it."
)
_validator = Draft202012Validator(SCHEMA["function"]["parameters"])


def validate(args: dict[str, Any]) -> str:
    """Schema errors or a destination count other than one; empty when valid."""
    error = next(iter(sorted(_validator.iter_errors(args), key=str)), None)
    if error is not None:
        where = "/".join(str(p) for p in error.absolute_path)
        return f"{NAME} arguments invalid at {where or '$'}: {error.message}"
    chosen = [k for k in ("title", "quiz_id", "note_id") if args.get(k)]
    if len(chosen) != 1:
        return f"{NAME} takes exactly one destination: title, quiz_id or note_id"
    if args.get("chapter_id") and chosen != ["title"]:
        return f"{NAME}: chapter_id files a new quiz; it goes with title"
    return ""


def source(row: dict[str, Any]) -> dict[str, Any]:
    """What a copy records of its bank question."""
    return {
        "id": row["id"],
        "exam": row["exam"],
        "subject": row["subject"],
        "topic": row["topic"],
        "sources": row.get("sources") or [],
    }
