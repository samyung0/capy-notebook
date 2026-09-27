"""Flag 12-word overlaps; references must have extracted text beside their PDFs."""

import re


def windows(text):
    words = re.findall(r"\w+", text.casefold())
    return {" ".join(words[i : i + 12]) for i in range(len(words) - 11)}


def question_text(question):
    """Exclude schema keys; include every authored text field, including solutions."""
    if isinstance(question, str):
        return question
    if isinstance(question, list):
        return "\n".join(question_text(v) for v in question)
    if isinstance(question, dict):
        return "\n".join(
            question_text(v)
            for k, v in question.items()
            if k not in {"id", "type", "url", "svg", "layout", "labels", "level"}
        )
    return ""


def overlaps(question, references):
    words = windows(question_text(question))
    return {
        name: sorted(words & windows(text))
        for name, text in references.items()
        if words & windows(text)
    }
