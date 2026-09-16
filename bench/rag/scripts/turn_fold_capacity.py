"""How far one curate-mode chat turn gets before live compaction refuses it.

Offline and deterministic: synthetic textbook sections, mocked tool results and
a stub summarizer. No provider call, no database, no credentials. This measures
the compaction *mechanism* only -- fold count, kept exchanges, admitted request
size, and the note-saturation arithmetic under the 12,000-token note ceiling.
Note quality is not measured; a real summarizer writes different notes.

The simulated turn mirrors ``agent.py``: system prompt, the query tagged
``_kind: "query"``, then tool exchanges, with ``compact.compact_messages``
called under the same keyword arguments before every model response.

    uv run --extra test python bench/rag/scripts/turn_fold_capacity.py
    uv run --extra test python bench/rag/scripts/turn_fold_capacity.py --files 16
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pipeline.prompts import chat as chat_prompts
from pipeline.registry import ModelConfig
from pipeline.retrieval import accounting, capture, compact, contract, tools

REPORTS = Path(__file__).resolve().parents[1] / "reports"
DEFAULT_OUT = REPORTS / "2026-09-16-turn-fold-capacity"
WINDOWS = (32_000, 64_000, 128_000, 200_000)

EXCERPT_RE = re.compile(r"ex_f\d+s\d+")
FACT_RE = re.compile(r"KEY-F\d+S\d+-[A-Z0-9]{4}")

# capture_page attachments accumulate for the whole turn and ride outside
# ``messages``; ``cfg.captures_per_turn`` caps them at 8 (config.py).
CAPTURES_PER_TURN = 8
IMAGE_SIZES = ((1024, 768), (1280, 960), (1400, 1120))

QUERY = (
    "Go through the linear algebra and cell biology books in the library, "
    "make one study note per section, and finish with a quiz that covers the "
    "sections you judged hardest."
)

# ---------------------------------------------------------------- synthetic corpus

BOOKS = (
    ("Introductory Cell Biology", "biology"),
    ("Statistics for the Life Sciences", "statistics"),
    ("Genetics and Inheritance", "biology"),
    ("Applied Probability", "statistics"),
)

TOPICS = {
    "biology": (
        "Membrane transport",
        "Enzyme kinetics",
        "Cellular respiration",
        "Signal transduction",
        "The cell cycle",
        "Protein folding",
    ),
    "statistics": (
        "Sampling distributions",
        "Confidence intervals",
        "Hypothesis tests",
        "Regression diagnostics",
        "Conditional probability",
        "Experimental design",
    ),
}

BANK = {
    "biology": {
        "concept": (
            "membrane transport",
            "enzyme saturation",
            "mitochondrial coupling",
            "signal transduction",
            "cell cycle control",
            "osmotic balance",
        ),
        "actor": (
            "the plasma membrane",
            "a carrier protein",
            "the ribosome",
            "an ion channel",
            "the chloroplast",
            "a regulatory enzyme",
        ),
        "verb": ("moves", "binds", "releases", "regulates", "buffers", "accumulates"),
        "object": (
            "sodium ions",
            "glucose molecules",
            "ATP",
            "the substrate",
            "messenger RNA",
            "calcium",
        ),
        "condition": (
            "the gradient is steep",
            "the substrate is scarce",
            "temperature rises",
            "an inhibitor is present",
            "oxygen is limited",
        ),
        "observation": (
            "the observed reaction rate",
            "the measured uptake curve",
            "the growth of the culture",
            "the resting potential",
        ),
    },
    "statistics": {
        "concept": (
            "the sampling distribution",
            "the central limit theorem",
            "interval estimation",
            "the null hypothesis",
            "residual analysis",
            "conditional probability",
        ),
        "actor": (
            "the estimator",
            "a random sample",
            "the test statistic",
            "the fitted model",
            "the prior",
            "the experimenter",
        ),
        "verb": (
            "shifts",
            "concentrates",
            "overstates",
            "accounts for",
            "stabilises",
            "recovers",
        ),
        "object": (
            "the sample mean",
            "the standard error",
            "the observed spread",
            "the coverage rate",
            "the effect size",
            "the residuals",
        ),
        "condition": (
            "the sample is small",
            "the variance is unknown",
            "observations are dependent",
            "the design is unbalanced",
            "outliers are present",
        ),
        "observation": (
            "the reported p-value",
            "the width of the interval",
            "the fitted slope",
            "the rejection rate",
        ),
    },
}

TEMPLATES = (
    "{Concept} explains how {actor} {verb} {object} when {condition}.",
    "In practice {actor} {verb} {object}, and the effect is largest when {condition}.",
    (
        "Students are asked to measure {object} and decide whether {concept} "
        "accounts for {observation}."
    ),
    (
        "A common mistake is to read {concept} as a claim about {object} rather "
        "than about {observation}."
    ),
    "Because {condition}, {object} changes more slowly than {observation} does.",
    (
        "The worked problems return to {concept}, where {actor} {verb} {object} "
        "one step at a time."
    ),
    (
        "{Observation} is reported alongside {object} so that {concept} can be "
        "checked rather than assumed."
    ),
    (
        "Nothing in {concept} requires that {actor} {verb} {object} before "
        "{condition}, and the figure makes that ordering explicit."
    ),
    (
        "When {condition}, the chapter recommends reporting {observation} together "
        "with the uncertainty attached to {object}."
    ),
    (
        "The summary table lists {object}, {observation}, and the assumptions that "
        "{concept} places on {actor}."
    ),
)

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


@dataclass(frozen=True)
class Section:
    sid: str
    file_index: int
    index: int
    book: str
    subject: str
    title: str
    excerpt_id: str
    fact_code: str
    text: str
    image_tokens: int


def _sentence(rng: random.Random, subject: str) -> str:
    bank = BANK[subject]
    slots = {key: rng.choice(values) for key, values in bank.items()}
    slots["Concept"] = slots["concept"][0].upper() + slots["concept"][1:]
    slots["Observation"] = slots["observation"][0].upper() + slots["observation"][1:]
    return rng.choice(TEMPLATES).format(**slots)


def _prose(rng: random.Random, subject: str, marker: str) -> str:
    target = rng.randint(600, 800)
    sentences: list[str] = []
    words = 0
    while words < target:
        sentence = _sentence(rng, subject)
        sentences.append(sentence)
        words += len(sentence.split())
    sentences.insert(len(sentences) // 3, marker)
    paragraphs: list[str] = []
    cursor = 0
    while cursor < len(sentences):
        size = rng.randint(4, 7)
        paragraphs.append(" ".join(sentences[cursor : cursor + size]))
        cursor += size
    return "\n\n".join(paragraphs)


def build_corpus(files: int, sections: int, seed: int) -> list[Section]:
    """Deterministic textbook sections; every section plants a unique id pair."""
    corpus: list[Section] = []
    for file_index in range(files):
        book, subject = BOOKS[file_index % len(BOOKS)]
        volume = file_index // len(BOOKS) + 1
        title = f"{book}, Volume {volume}"
        for index in range(sections):
            rng = random.Random(f"{seed}:{file_index}:{index}")
            sid = f"f{file_index:02d}s{index}"
            excerpt_id = f"ex_{sid}"
            fact_code = "KEY-{}-{}".format(
                sid.upper(), "".join(rng.choice(ALPHABET) for _ in range(4))
            )
            topic = TOPICS[subject][index % len(TOPICS[subject])]
            marker = (
                f"Worked example {excerpt_id} records the reference value "
                f"{fact_code}, which the end-of-chapter questions reuse."
            )
            image = rng.random() < 1 / 3
            width, height = rng.choice(IMAGE_SIZES)
            corpus.append(
                Section(
                    sid=sid,
                    file_index=file_index,
                    index=index,
                    book=title,
                    subject=subject,
                    title=f"{file_index + 1}.{index + 1} {topic}",
                    excerpt_id=excerpt_id,
                    fact_code=fact_code,
                    text=_prose(rng, subject, marker),
                    image_tokens=(
                        capture.patch_tokens(width, height) if image else 0
                    ),
                )
            )
    return corpus


# ------------------------------------------------------------------ tool results


def _hit_list(rng: random.Random, corpus: list[Section], focus: Section) -> str:
    """A ranked hit list of 1k to 2k estimated tokens, excerpt ids included."""
    target = rng.randint(1000, 2000)
    pool = [focus, *rng.sample(corpus, min(len(corpus), 24))]
    lines = [f"Hits for the library search (scope: {focus.book})."]
    for rank, section in enumerate(pool, start=1):
        snippet = " ".join(section.text.split())[: rng.randint(280, 420)]
        lines.append(
            f"[{rank}] {section.excerpt_id} | {section.book} | {section.title} "
            f"| score {rng.uniform(0.55, 0.93):.2f}\n    {snippet}"
        )
        if tools.estimate_tokens("\n".join(lines)) >= target:
            break
    return tools.limit_tool_result("\n".join(lines))


def _read_result(section: Section) -> str:
    header = (
        f"{section.excerpt_id} | {section.book} | {section.title} "
        f"| words {len(section.text.split())}"
    )
    figure = (
        "\n[figure on this page: extraction confidence 0.71]"
        if section.image_tokens
        else ""
    )
    return tools.limit_tool_result(f"{header}{figure}\n\n{section.text}")


def _receipt(section: Section, serial: int) -> str:
    return tools.limit_tool_result(
        f"Created material m_{serial:04d} in the workspace.\n"
        f"Title: {section.title}\n"
        f"Kind: note. Blocks: 9. Status: ready.\n"
        f"Provenance recorded: {section.book}, {section.excerpt_id}.\n"
        "The attribution footer renders from the provenance column and is not "
        "editable in the document body."
    )


# ------------------------------------------------------------------ message shapes


def _assistant(content: str, calls: list[tuple[str, str, dict[str, Any]]]) -> dict:
    return {
        "role": "assistant",
        "content": content,
        "tool_calls": [
            {
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
            for call_id, name, args in calls
        ],
    }


def _tool(call_id: str, content: str) -> dict:
    return {"role": "tool", "tool_call_id": call_id, "content": content}


@dataclass
class Exchange:
    phase: str
    section: str | None
    messages: list[dict] = field(default_factory=list)
    image_tokens: int = 0


def plan_turn(corpus: list[Section], seed: int) -> list[Exchange]:
    """Per section: a search exchange, a read exchange, a write exchange.

    The turn closes with one exchange re-reading up to four sections and one
    exchange creating the quiz.
    """
    rng = random.Random(seed ^ 0x5EED)
    plan: list[Exchange] = []
    counter = 0

    def call_id() -> str:
        nonlocal counter
        counter += 1
        return f"c{counter:04d}"

    for position, section in enumerate(corpus):
        searches = [
            (call_id(), "search_knowledge", {"query": f"{section.title} explained"})
            for _ in range(rng.randint(1, 4))
        ]
        plan.append(
            Exchange(
                "search",
                section.sid,
                [
                    _assistant(f"Looking for {section.title}.", searches),
                    *(
                        _tool(cid, _hit_list(rng, corpus, section))
                        for cid, _, _ in searches
                    ),
                ],
            )
        )

        neighbours = [section]
        if rng.random() < 0.5:
            neighbours.append(corpus[(position + 1) % len(corpus)])
        reads = [
            (call_id(), "read_knowledge", {"excerpt_id": item.excerpt_id})
            for item in neighbours
        ]
        plan.append(
            Exchange(
                "read",
                section.sid,
                [
                    _assistant("Reading the section in full.", reads),
                    *(
                        _tool(cid, _read_result(item))
                        for (cid, _, _), item in zip(reads, neighbours)
                    ),
                ],
                image_tokens=sum(item.image_tokens for item in neighbours),
            )
        )

        write = call_id()
        plan.append(
            Exchange(
                "write",
                section.sid,
                [
                    _assistant(
                        "Writing the study note.",
                        [
                            (
                                write,
                                "create_material",
                                {"title": section.title, "kind": "note"},
                            )
                        ],
                    ),
                    _tool(write, _receipt(section, position + 1)),
                ],
            )
        )

    step = max(1, len(corpus) // 4)
    quiz_sections = corpus[::step][:4]
    reads = [
        (call_id(), "read_knowledge", {"excerpt_id": item.excerpt_id})
        for item in quiz_sections
    ]
    plan.append(
        Exchange(
            "quiz_read",
            None,
            [
                _assistant("Re-reading the sections the quiz will cover.", reads),
                *(
                    _tool(cid, _read_result(item))
                    for (cid, _, _), item in zip(reads, quiz_sections)
                ),
            ],
            image_tokens=sum(item.image_tokens for item in quiz_sections),
        )
    )
    quiz = call_id()
    plan.append(
        Exchange(
            "quiz_write",
            None,
            [
                _assistant(
                    "Creating the quiz.",
                    [(quiz, "create_material", {"title": "Quiz", "kind": "quiz"})],
                ),
                _tool(
                    quiz,
                    tools.limit_tool_result(
                        "Created material m_quiz in the workspace.\n"
                        "Kind: quiz. Questions: 12. Status: ready.\n"
                        "Provenance recorded: "
                        + ", ".join(item.excerpt_id for item in quiz_sections)
                    ),
                ),
            ],
        )
    )
    # The admission that would precede the final answer text.
    plan.append(Exchange("answer", None, []))
    return plan


# ------------------------------------------------------------------ stub summarizer


def _step_line(index: int, step: dict[str, Any]) -> str:
    """One note line per folded step: the call, the outcome, ids and facts."""
    blob = json.dumps(step, ensure_ascii=False)
    ids = sorted(set(EXCERPT_RE.findall(blob)))
    facts = sorted(set(FACT_RE.findall(blob)))
    if step.get("tool_calls"):
        head = "call " + ",".join(
            f"{c['name']}({c['arguments']})" for c in step["tool_calls"]
        )
    else:
        head = f"result {step.get('tool_call_id', '-')} ok"
    parts = [f"s{index:03d} {head}"]
    if ids:
        parts.append("ids=" + " ".join(ids))
    if facts:
        parts.append("facts=" + " ".join(facts))
    return " ".join(parts)


class StubSummarizer:
    """Deterministic stand-in for the note model.

    Keeps one line per folded step, every excerpt id and every fact code it
    saw, and drops the oldest lines first once the note passes the ceiling.
    """

    def __init__(self, ceiling: int = chat_prompts.SUMMARY_MAX_TOKENS) -> None:
        self.ceiling = ceiling
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.dropped_lines = 0

    async def complete_text(self, messages: list[dict], **_kwargs) -> str:
        payload = json.loads(messages[-1]["content"])
        self.calls += 1
        self.input_tokens += accounting.estimate_context_value(messages)
        prior = str(payload.get("previous_note") or "")
        lines = [line for line in prior.split("\n") if line.strip()]
        offset = len(lines)
        lines.extend(
            _step_line(offset + n, step)
            for n, step in enumerate(payload.get("steps") or [])
        )
        while (
            len(lines) > 1
            and accounting.estimate_context_value("\n".join(lines)) > self.ceiling
        ):
            lines.pop(0)
            self.dropped_lines += 1
        note = "\n".join(lines)
        self.output_tokens += accounting.estimate_context_value(note)
        return note


# ------------------------------------------------------------------ the simulation


def curate_schemas() -> list[dict[str, Any]]:
    """Real contract schemas plus the two curate-mode knowledge tools.

    ``search_knowledge`` and ``read_knowledge`` have no contract definition yet,
    so they are clones of their workspace equivalents under the new names.
    """
    schemas = [contract.model_schema(name) for name in contract.DEFINITIONS]
    for source, name in (
        ("search_workspace", "search_knowledge"),
        ("read_document", "read_knowledge"),
    ):
        clone = json.loads(json.dumps(contract.model_schema(source)))
        clone["function"]["name"] = name
        schemas.append(clone)
    return schemas


def model_spec(window: int) -> ModelConfig:
    """A non-Anthropic chat model, so the output reserve is a flat 8,192."""
    return ModelConfig(
        version=1,
        provider_name="DeepSeek",
        model_name="Flash",
        provider_slug="deepseek",
        model_slug="deepseek-v4-flash",
        platform_enabled=True,
        byok_enabled=True,
        thinking_levels=("instant", "low"),
        default_thinking="instant",
        context_window_tokens=window,
    )


def current_note(messages: list[dict]) -> str:
    return "\n\n".join(
        str(message.get("_note") or "")
        for message in messages
        if message.get("_kind") == "turn_note"
    ).strip()


def kept_exchanges(messages: list[dict]) -> int:
    """Exchanges still verbatim in the turn; each one opens with an assistant row."""
    return sum(1 for message in messages if message.get("role") == "assistant")


async def run_window(
    corpus: list[Section], plan: list[Exchange], window: int, seed: int
) -> dict[str, Any]:
    spec = model_spec(window)
    schemas = curate_schemas()
    stub = StubSummarizer()
    compact.models.complete_text = stub.complete_text  # type: ignore[assignment]

    messages: list[dict] = [
        {"role": "system", "content": chat_prompts.system_prompt("en")},
        {"role": "user", "content": QUERY, "_kind": "query"},
    ]
    image_tokens = 0
    captures = 0
    seen_ids: set[str] = set()
    seen_facts: set[str] = set()
    note_ids: set[str] = set()
    note_facts: set[str] = set()
    steps: list[dict[str, Any]] = []
    failure: dict[str, Any] | None = None
    sections_done = 0
    saturation: dict[str, Any] | None = None

    for index, exchange in enumerate(plan):
        folds_before = stub.calls
        try:
            messages = await compact.compact_messages(
                messages,
                spec,
                schemas=schemas,
                extra=image_tokens,
                protect_live_chain=True,
                allow_summary=True,
            )
        except (compact.ContextTooLarge, compact.InvalidSummary) as exc:
            failure = {
                "step": index,
                "phase": exchange.phase,
                "section": exchange.section,
                "sections_completed": sections_done,
                "error": type(exc).__name__,
                "message": str(exc),
            }
            break

        note = current_note(messages)
        ids = set(EXCERPT_RE.findall(note))
        facts = set(FACT_RE.findall(note))
        if saturation is None and (note_ids - ids or note_facts - facts):
            saturation = {
                "step": index,
                "phase": exchange.phase,
                "sections_completed": sections_done,
                "dropped_excerpt_ids": sorted(note_ids - ids),
                "dropped_fact_codes": sorted(note_facts - facts),
            }
        note_ids, note_facts = ids, facts
        measured = compact.request_context(messages, spec, schemas=schemas)
        steps.append(
            {
                "step": index,
                "phase": exchange.phase,
                "section": exchange.section,
                "request_tokens": measured.total_tokens + image_tokens,
                "schema_tokens": measured.tool_tokens,
                "image_tokens": image_tokens,
                "folded": stub.calls > folds_before,
                "summarizer_calls": stub.calls,
                "note_tokens": accounting.estimate_context_value(note),
                "note_excerpt_ids": len(ids),
                "note_fact_codes": len(facts),
                "kept_exchanges": kept_exchanges(messages),
            }
        )

        messages.extend(exchange.messages)
        blob = json.dumps(exchange.messages, ensure_ascii=False)
        seen_ids.update(EXCERPT_RE.findall(blob))
        seen_facts.update(FACT_RE.findall(blob))
        if exchange.image_tokens and captures < CAPTURES_PER_TURN:
            captures += 1
            image_tokens += exchange.image_tokens
        if exchange.phase == "write":
            sections_done += 1

    peak = max((step["request_tokens"] for step in steps), default=0)
    final_note = current_note(messages)
    # What the model can still read at the end: the note plus whatever stayed
    # verbatim. Excerpt ids also leak in through hit lists, so fact codes (which
    # only appear in a full read) are the per-section signal.
    final_request = json.dumps(messages, ensure_ascii=False)
    quiz_read = next(item for item in plan if item.phase == "quiz_read")
    quiz_ids = sorted(
        set(EXCERPT_RE.findall(json.dumps(quiz_read.messages, ensure_ascii=False)))
    )
    return {
        "window_tokens": window,
        "usable_input_limit": compact.usable_input_limit(spec),
        "seed": seed,
        "files": len({section.file_index for section in corpus}),
        "sections": len(corpus),
        "planned_steps": len(plan),
        "completed_steps": len(steps),
        "sections_completed": sections_done,
        "folds": stub.calls,
        "peak_request_tokens": peak,
        "summarizer_input_tokens": stub.input_tokens,
        "summarizer_output_tokens": stub.output_tokens,
        "note_lines_dropped": stub.dropped_lines,
        "final_note_tokens": accounting.estimate_context_value(final_note),
        "excerpt_ids_seen": len(seen_ids),
        "fact_codes_seen": len(seen_facts),
        "excerpt_ids_in_final_note": len(set(EXCERPT_RE.findall(final_note))),
        "fact_codes_in_final_note": len(set(FACT_RE.findall(final_note))),
        "excerpt_ids_in_final_request": len(set(EXCERPT_RE.findall(final_request))),
        "fact_codes_in_final_request": len(set(FACT_RE.findall(final_request))),
        "quiz_excerpt_ids_needed": quiz_ids,
        "quiz_excerpt_ids_in_final_request": sorted(
            set(quiz_ids) & set(EXCERPT_RE.findall(final_request))
        ),
        "saturation": saturation,
        "failure": failure,
        "steps": steps,
    }


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--files", type=int, default=8)
    parser.add_argument("--sections", type=int, default=4, help="sections per file")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--windows",
        default=",".join(str(w) for w in WINDOWS),
        help="comma separated context windows in tokens",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    corpus = build_corpus(args.files, args.sections, args.seed)
    plan = plan_turn(corpus, args.seed)
    args.out.mkdir(parents=True, exist_ok=True)

    rows = []
    for window in [int(w) for w in args.windows.split(",") if w.strip()]:
        result = await run_window(corpus, plan, window, args.seed)
        name = f"{args.files}x{args.sections}-w{window}.json"
        (args.out / name).write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        rows.append(result)

    header = (
        f"{'window':>8} {'sections':>9} {'folds':>6} {'peak req':>9} "
        f"{'note tok':>9} {'facts':>9} {'summ in/out':>14}  outcome"
    )
    print(f"corpus: {args.files} files x {args.sections} sections, seed {args.seed}")
    print(f"planned steps: {rows[0]['planned_steps']}, records in {args.out}")
    print(header)
    for row in rows:
        outcome = (
            f"{row['failure']['error']} at step {row['failure']['step']}"
            f" ({row['failure']['phase']})"
            if row["failure"]
            else "completed"
        )
        print(
            f"{row['window_tokens']:>8} "
            f"{row['sections_completed']:>4}/{row['sections']:<4} "
            f"{row['folds']:>6} {row['peak_request_tokens']:>9} "
            f"{row['final_note_tokens']:>9} "
            f"{row['fact_codes_in_final_request']:>4}/{row['fact_codes_seen']:<4} "
            f"{row['summarizer_input_tokens']:>6}/{row['summarizer_output_tokens']:<7} "
            f"{outcome}"
        )


if __name__ == "__main__":
    asyncio.run(main())
