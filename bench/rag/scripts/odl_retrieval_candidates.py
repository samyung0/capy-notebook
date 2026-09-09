"""Prompt-only retrieval candidates for isolated, matched agent benchmarks.

The harness appends the selected text once to the current system prompt. This
module neither patches production functions nor changes tools, ranking or output
schemas. Freeze this file before evaluating held-out questions.
"""

SUPPORTED_CANDIDATES = ("baseline", "table_context")

TABLE_CONTEXT_ADDON = (
    "\n- Before answering from a table, formula, or list, check that the evidence "
    "makes the relevant row, column and group labels, units, conditions, "
    "ordering, and notes clear. If a hit is cut off or those relationships are "
    "ambiguous, use its displayed file_id and start to call read_document from "
    "one chunk before the hit (minimum start 0), with count=3. Read further "
    "when needed context is visibly cut off or an explicit source reference "
    "points elsewhere. Keep each passage's citation attached to the evidence "
    "it actually provides. Do not assign nearby numbers to labels or reconstruct "
    "formula or list structure by guesswork. If the needed relationship remains "
    "unclear after checking that context and relevant references, identify that "
    "specific uncertainty rather than claiming the whole source is silent."
)


def system_prompt_addon(name: str) -> str:
    if name == "baseline":
        return ""
    if name == "table_context":
        return TABLE_CONTEXT_ADDON
    raise ValueError(f"Unknown retrieval candidate: {name}")


if __name__ == "__main__":
    assert system_prompt_addon("baseline") == ""
    assert system_prompt_addon("table_context") == TABLE_CONTEXT_ADDON
    try:
        system_prompt_addon("unknown")
    except ValueError:
        pass
    else:
        raise AssertionError("Unknown candidates must fail explicitly")
    print("Baseline identity and explicit candidate selection passed")
