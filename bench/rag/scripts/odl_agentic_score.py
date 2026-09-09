"""Validate source reviews and aggregate matched direct-agent benchmark attempts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean

PROTOCOL = (
    Path(__file__).resolve().parents[1]
    / "reports/2026-09-09-odl-agentic-review-protocol.md"
)
AXES = {
    "correctness": (
        "correct",
        {"correct", "partial", "incorrect", "omitted", "uncertain"},
    ),
    "grounding": (
        "supported",
        {"supported", "partial", "unsupported", "missing", "uncertain"},
    ),
    "citation_support": (
        "supported",
        {"supported", "partial", "unsupported", "missing", "uncertain"},
    ),
}
CONFIG_FIELDS = (
    "model",
    "enable_thinking",
    "limits",
    "search_sql_sha256",
    "search_mode",
    "runtime_sources",
    "harness_sources",
    "qwen_endpoint",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def jsonl(path):
    for number, line in enumerate(
        Path(path).read_text(encoding="utf-8").splitlines(), 1
    ):
        require(bool(line.strip()), f"Blank JSONL line: {path}:{number}")
        row = json.loads(line)
        require(isinstance(row, dict), f"Expected object: {path}:{number}")
        yield number, row


def configuration(freeze):
    value = {key: freeze[key] for key in CONFIG_FIELDS}
    value["corpus_sha256"] = freeze.get("corpus_sha256")
    value["page_evidence_generation"] = freeze.get("page_evidence_generation")
    digest = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    return digest, value


def condition_id(arm, prompt, config, source_pages=False):
    return f"{arm}/{prompt}/{config}" + (
        "/source_page_evidence" if source_pages else ""
    )


def index_reviews(reviews, answers):
    indexed = {}
    for review in reviews:
        turn = review["turn_id"]
        require(turn not in indexed, f"Duplicate review for turn {turn}")
        require(turn in answers, f"Review has no attempted answer: {turn}")
        indexed[turn] = review
    require(
        set(indexed) == set(answers),
        f"Missing reviews: {sorted(set(answers) - set(indexed))}",
    )
    return indexed


def score(answer, review, question, sources=None):
    """Recompute strict success; review flags never override the three judgments."""
    turn = answer["turn_id"]
    require(review["schema"] == "odl-agentic-review-v1", f"Review schema: {turn}")
    for field, expected in (
        ("question_id", answer["id"]),
        ("repeat", answer["repeat"]),
        ("split", question["split"]),
        ("run_status", answer["status"]),
    ):
        require(review[field] == expected, f"Review {field} differs: {turn}")
    require(answer["status"] in {"complete", "empty", "error"}, f"Run status: {turn}")
    citations = answer["citations"]
    numbers = sorted({int(n) for n in re.findall(r"\[(\d{1,3})\]", answer["answer"])})
    require(answer["citation_numbers"] == numbers, f"Citation numbers differ: {turn}")
    require(
        answer["invalid_citation_numbers"]
        == [n for n in numbers if not 1 <= n <= len(citations)],
        f"Invalid citation numbers differ: {turn}",
    )
    for value in (answer["scope_valid"], review["scope_valid"], review["strict_pass"]):
        require(type(value) is bool, f"Expected boolean scope/strict flag: {turn}")
    claims = review["claims"]
    indices = [claim["claim_index"] for claim in claims]
    expected = list(range(1, len(question["required_claims"]) + 1))
    require(
        all(type(i) is int for i in indices) and sorted(indices) == expected,
        f"Claim indices must cover the frozen rubric exactly once: {turn}",
    )
    require(bool(expected), f"Empty required-claim rubric: {question['id']}")
    for claim in claims:
        for axis, (_, choices) in AXES.items():
            require(claim[axis] in choices, f"Unknown {axis}: {turn}")
        require(isinstance(claim["seen_evidence"], list), f"Seen evidence list: {turn}")
        require(isinstance(claim["source_checks"], list), f"Source check list: {turn}")
        if claim["grounding"] == "supported":
            require(
                bool(claim["seen_evidence"]),
                f"Supported grounding lacks a locator: {turn}",
            )
            for locator in claim["seen_evidence"]:
                require(
                    isinstance(locator.get("attempt_id"), str)
                    and bool(locator["attempt_id"].strip())
                    and type(locator.get("message_index")) is int
                    and locator["message_index"] >= 0,
                    f"Supported grounding lacks a request/message locator: {turn}",
                )
                index = locator.get("rendered_result_index")
                if index is not None:
                    rendered = answer["rendered_tool_results"]
                    require(
                        type(index) is int and 0 <= index < len(rendered),
                        f"Rendered evidence index out of bounds: {turn}",
                    )
                    excerpt = locator.get("excerpt")
                    require(
                        isinstance(excerpt, str)
                        and bool(excerpt.strip())
                        and excerpt in rendered[index]["text_sent_to_model"],
                        f"Evidence excerpt absent from actual clipped tool text: {turn}",
                    )
        if claim["citation_support"] == "supported":
            checks = claim["source_checks"]
            require(
                any(c.get("support") == "supported" for c in checks),
                f"Supported citation lacks a source check: {turn}",
            )
            for check in checks:
                if check.get("support") == "supported":
                    require(
                        type(check.get("region_index")) is int
                        and check["region_index"] >= 0,
                        f"Page-only citation cannot be fully supported: {turn}",
                    )
                    require(
                        type(check.get("citation_number")) is int
                        and check["citation_number"] in numbers
                        and 1 <= check["citation_number"] <= len(citations),
                        f"Source check citation is not attached to this answer: {turn}",
                    )
                    citation = citations[check["citation_number"] - 1]
                    regions = citation.get("regions", [])
                    require(
                        check["region_index"] < len(regions),
                        f"Citation region index out of bounds: {turn}",
                    )
                    require(
                        type(check.get("pdf_page")) is int
                        and check["pdf_page"] >= 1
                        and regions[check["region_index"]].get("page")
                        == check["pdf_page"],
                        f"Source check page differs from cited region: {turn}",
                    )
                    if sources is not None:
                        source = sources.get(check.get("source_id"))
                        require(
                            source is not None
                            and check.get("pdf_sha256")
                            == source["coordinate_pdf_sha256"]
                            and check["pdf_page"] <= source["pages"],
                            f"Source check PDF identity differs: {turn}",
                        )
    for field in ("additional_unsupported_claims", "uncertainties", "error_tags"):
        require(
            isinstance(review[field], list), f"Expected review list {field}: {turn}"
        )
    negative = question["answerability"] == "unanswerable"
    abstention = review["abstention"]
    if negative:
        require(
            isinstance(abstention, dict), f"Negative lacks abstention review: {turn}"
        )
        require(
            abstention["verdict"] in {"correct", "incorrect", "uncertain"},
            f"Abstention verdict: {turn}",
        )
        for field in ("scope_respected", "adequate_check"):
            require(
                type(abstention[field]) is bool or abstention[field] is None,
                f"Invalid abstention {field}: {turn}",
            )
    unresolved = (
        bool(review["uncertainties"])
        or review["primary_error"] == "uncertain"
        or "uncertain" in review["error_tags"]
    )
    unresolved |= any(c[axis] == "uncertain" for c in claims for axis in AXES)
    unresolved |= bool(
        negative
        and (
            abstention["verdict"] == "uncertain"
            or abstention["adequate_check"] is None
            or abstention["scope_respected"] is None
        )
    )
    fractions = {
        axis: sum(c[axis] == full for c in claims) / len(claims)
        for axis, (full, _) in AXES.items()
    }
    run_ok = (
        answer["status"] == "complete"
        and bool(answer["answer"].strip())
        and not answer["errors"]
    )
    gate = (
        run_ok
        and answer["scope_valid"]
        and review["scope_valid"]
        and not unresolved
        and not review["additional_unsupported_claims"]
        and not answer["invalid_citation_numbers"]
        and review["primary_error"] not in {"runtime", "empty"}
    )
    if negative:
        strict = (
            gate
            and fractions["correctness"] == 1
            and abstention["verdict"] == "correct"
            and abstention["scope_respected"] is True
            and abstention["adequate_check"] is True
            and bool(abstention["evidence_note"].strip())
        )
    else:
        strict = gate and all(value == 1 for value in fractions.values())
    return {
        "turn_id": turn,
        "question_id": question["id"],
        "repeat": answer["repeat"],
        "split": question["split"],
        "family": question["family"],
        "language": question["language"],
        "answerability": question["answerability"],
        "status": answer["status"],
        "fractions": fractions,
        "all_correct": fractions["correctness"] == 1,
        "strict_pass": bool(strict),
        "declared_strict_pass": review["strict_pass"],
        "unresolved": unresolved,
        "scope_valid": answer["scope_valid"] and review["scope_valid"],
        "claim_verdicts": {
            axis: dict(Counter(c[axis] for c in claims)) for axis in AXES
        },
        "unsupported_additions": len(review["additional_unsupported_claims"]),
        "primary_error": review["primary_error"],
        "error_tags": review["error_tags"],
        "elapsed_seconds": answer["elapsed_seconds"],
        "abstention_verdict": abstention["verdict"] if negative else None,
    }


def summarize(rows):
    by_question = defaultdict(list)
    for row in rows:
        by_question[row["question_id"]].append(row)
    per_question = []
    for question_id, attempts in sorted(by_question.items()):
        per_question.append(
            {
                "question_id": question_id,
                "attempts": len(attempts),
                "strict_pass_rate": mean(r["strict_pass"] for r in attempts),
                "all_correct_rate": mean(r["all_correct"] for r in attempts),
                **{
                    axis + "_fraction": mean(r["fractions"][axis] for r in attempts)
                    for axis in AXES
                },
            }
        )
    metrics = (
        "strict_pass_rate",
        "all_correct_rate",
        *(axis + "_fraction" for axis in AXES),
    )
    return {
        "attempts": len(rows),
        "questions": len(by_question),
        "equal_question_weight": {
            key: mean(q[key] for q in per_question) if rows else None for key in metrics
        },
        "status_counts": dict(Counter(r["status"] for r in rows)),
        "strict_pass_attempts": sum(r["strict_pass"] for r in rows),
        "unresolved_attempts": sum(r["unresolved"] for r in rows),
        "invalid_scope_attempts": sum(not r["scope_valid"] for r in rows),
        "unsupported_additions": sum(r["unsupported_additions"] for r in rows),
        "claim_verdict_counts": {
            axis: dict(
                sum((Counter(r["claim_verdicts"][axis]) for r in rows), Counter())
            )
            for axis in AXES
        },
        "primary_errors": dict(
            Counter(r["primary_error"] for r in rows if r["primary_error"])
        ),
        "error_tags": dict(Counter(tag for r in rows for tag in set(r["error_tags"]))),
        "abstentions": dict(
            Counter(r["abstention_verdict"] for r in rows if r["abstention_verdict"])
        ),
        "language_question_counts": dict(
            Counter(attempts[0]["language"] for attempts in by_question.values())
        ),
        "family_question_counts": dict(
            Counter(attempts[0]["family"] for attempts in by_question.values())
        ),
        "per_question": per_question,
    }


def paired(odl, mineru, expected_odl=(), expected_mineru=()):
    """Only identical question/repeat cells pair; missing cells remain visible."""
    left = {(r["question_id"], r["repeat"]): r for r in odl}
    right = {(r["question_id"], r["repeat"]): r for r in mineru}
    require(
        len(left) == len(odl) and len(right) == len(mineru),
        "Duplicate condition/question/repeat",
    )
    verdicts = {
        key: []
        for key in (
            "both_pass",
            "odl_only_pass",
            "mineru_only_pass",
            "neither_pass",
            "unresolved",
        )
    }
    deltas = defaultdict(list)
    for key in sorted(left.keys() & right.keys()):
        a, b = left[key], right[key]
        if a["unresolved"] or b["unresolved"]:
            verdict = "unresolved"
        else:
            verdict = (
                "both_pass"
                if a["strict_pass"] and b["strict_pass"]
                else "odl_only_pass"
                if a["strict_pass"]
                else "mineru_only_pass"
                if b["strict_pass"]
                else "neither_pass"
            )
            deltas[key[0]].append(int(a["strict_pass"]) - int(b["strict_pass"]))
        verdicts[verdict].append({"question_id": key[0], "repeat": key[1]})
    expected = set(expected_odl) | set(expected_mineru) | left.keys() | right.keys()
    missing_left, missing_right = (
        sorted(expected - left.keys()),
        sorted(expected - right.keys()),
    )
    complete = (
        bool(expected)
        and not missing_left
        and not missing_right
        and not verdicts["unresolved"]
    )
    return {
        "matched_attempts": len(left.keys() & right.keys()),
        "matched_questions": len({key[0] for key in left.keys() & right.keys()}),
        "complete_resolved_pairing": complete,
        "counts": {key: len(value) for key, value in verdicts.items()},
        "pairs": verdicts,
        "missing_odl": missing_left,
        "missing_mineru": missing_right,
        "equal_question_strict_delta_odl_minus_mineru": mean(
            mean(x) for x in deltas.values()
        )
        if complete and deltas
        else None,
    }


def aggregate(rows, planned=None):
    planned = planned or {}
    grouped = defaultdict(list)
    cells = set()
    for row in rows:
        key = (row["condition"], row["question_id"], row["repeat"])
        require(key not in cells, f"Duplicate condition/question/repeat: {key}")
        cells.add(key)
        grouped[(row["condition"], row["split"])].append(row)
    conditions = []
    for (condition, split), attempts in sorted(grouped.items()):
        conditions.append(
            {
                "condition": condition,
                "split": split,
                "arm": attempts[0]["arm"],
                "prompt_candidate": attempts[0]["prompt_candidate"],
                "source_page_evidence": attempts[0]["source_page_evidence"],
                "summary": summarize(attempts),
                "by_answerability": {
                    kind: summarize([r for r in attempts if r["answerability"] == kind])
                    for kind in ("answerable", "unanswerable")
                },
            }
        )
    comparisons = {
        (
            row["configuration_sha256"],
            row["prompt_candidate"],
            row["split"],
            row["source_page_evidence"],
        )
        for row in rows
        if row["arm"] == "odl"
        or (
            row["arm"] == "mineru"
            and row["prompt_candidate"] == "baseline"
            and not row["source_page_evidence"]
        )
    }
    comparisons.update(
        (config, prompt, split, pages)
        for arm, prompt, config, split, pages in planned
        if arm == "odl" or (arm == "mineru" and prompt == "baseline" and not pages)
    )
    pairs = []
    for config, prompt, split, source_pages in sorted(comparisons):
        condition = condition_id("odl", prompt, config, source_pages)
        reference = condition_id("mineru", "baseline", config)
        odl = grouped.get((condition, split), [])
        mineru = grouped.get((reference, split), [])
        differences = (["prompt"] if prompt != "baseline" else []) + (
            ["source-page evidence tool"] if source_pages else []
        )
        pairs.append(
            {
                "odl_condition": condition,
                "mineru_condition": reference,
                "split": split,
                "different_prompt": prompt != "baseline",
                "different_source_page_evidence": source_pages,
                "comparison": "parser plus " + " and ".join(differences)
                if differences
                else "same-prompt parser comparison",
                **paired(
                    odl,
                    mineru,
                    planned.get(("odl", prompt, config, split, source_pages), ()),
                    planned.get(("mineru", "baseline", config, split, False), ()),
                ),
            }
        )
    return {
        "conditions": conditions,
        "paired": pairs,
        "declared_strict_mismatches": [
            r["turn_id"] for r in rows if r["strict_pass"] != r["declared_strict_pass"]
        ],
    }


def run(args):
    fixture = read(args.questions)
    require(
        fixture.get("schema") and "draft" not in fixture["schema"].lower(),
        "Question fixture must be frozen",
    )
    questions = {q["id"]: q for q in fixture["questions"]}
    require(len(questions) == len(fixture["questions"]), "Duplicate question IDs")
    question_sha, protocol_sha = sha(args.questions), sha(args.protocol)
    answers, locations, configs, plans = {}, {}, {}, []
    expected_cells, arm_indexes = defaultdict(set), {}
    for path in args.answers:
        freeze = read(path.with_suffix(path.suffix + ".freeze.json"))
        require(
            freeze["questions_sha256"] == question_sha,
            f"Answer fixture hash differs: {path}",
        )
        config, value = configuration(freeze)
        configs[config] = value
        require(
            type(freeze["repeats"]) is int
            and freeze["repeats"] >= 1
            and len(set(freeze["selected_ids"])) == len(freeze["selected_ids"])
            and bool(freeze["selected_ids"])
            and set(freeze["selected_ids"]) <= questions.keys()
            and bool(freeze["arms"])
            and len(set(freeze["arms"])) == len(freeze["arms"]),
            f"Invalid frozen question/arm/repeat plan: {path}",
        )
        source_pages = freeze.get("source_page_evidence", False)
        require(
            type(source_pages) is bool, f"Invalid source_page_evidence flag: {path}"
        )
        for arm in freeze["arms"]:
            index_key = (config, arm)
            state = freeze["index_state"][arm]
            require(
                index_key not in arm_indexes or arm_indexes[index_key] == state,
                f"Same arm uses different frozen indexes: {arm}, {path}",
            )
            arm_indexes[index_key] = state
            for qid in freeze["selected_ids"]:
                key = (
                    arm,
                    freeze["prompt_candidate"],
                    config,
                    questions[qid]["split"],
                    source_pages,
                )
                expected_cells[key].update(
                    (qid, repeat) for repeat in range(freeze["repeats"])
                )
        digest, attempted = sha(path), set()
        for line, answer in jsonl(path):
            turn, qid = answer["turn_id"], answer["id"]
            require(turn not in answers, f"Duplicate attempted turn: {turn}")
            require(
                qid in questions and qid in freeze["selected_ids"],
                f"Unknown/unselected question: {turn}",
            )
            question = questions[qid]
            for field in (
                "question",
                "split",
                "family",
                "language",
                "scope_source_ids",
            ):
                require(
                    answer[field] == question[field],
                    f"Answer {field} differs from frozen fixture: {turn}",
                )
            require(
                answer["arm"] in freeze["arms"]
                and answer["prompt_candidate"] == freeze["prompt_candidate"],
                f"Arm/prompt differs: {turn}",
            )
            require(
                type(answer["repeat"]) is int
                and 0 <= answer["repeat"] < freeze["repeats"],
                f"Repeat differs: {turn}",
            )
            require(
                type(answer.get("source_page_evidence", source_pages)) is bool
                and answer.get("source_page_evidence", source_pages) == source_pages,
                f"Answer source-page capability differs from freeze: {turn}",
            )
            answers[turn] = answer | {
                "configuration_sha256": config,
                "source_page_evidence": source_pages,
            }
            locations[turn] = (digest, line)
            attempted.add((qid, answer["arm"], answer["repeat"]))
        planned = {
            (qid, arm, repeat)
            for qid in freeze["selected_ids"]
            for arm in freeze["arms"]
            for repeat in range(freeze["repeats"])
        }
        plans.append(
            {
                "answer_file": str(path),
                "sha256": digest,
                "attempts": len(attempted),
                "unattempted_plan_cells": sorted(planned - attempted),
            }
        )
    require(bool(answers), "No attempted answers")
    reviews = index_reviews(
        [row for path in args.reviews for _, row in jsonl(path)], answers
    )
    scored = []
    for turn, answer in answers.items():
        review = reviews[turn]
        inputs = review["inputs"]
        require(
            inputs["questions_sha256"] == question_sha
            and inputs["protocol_sha256"] == protocol_sha,
            f"Review fixture/protocol hash differs: {turn}",
        )
        require(
            (inputs["answer_jsonl_sha256"], inputs["answer_line"]) == locations[turn],
            f"Review answer locator differs: {turn}",
        )
        result = score(answer, review, questions[answer["id"]], fixture["sources"])
        result.update(
            {
                key: answer[key]
                for key in (
                    "arm",
                    "prompt_candidate",
                    "configuration_sha256",
                    "source_page_evidence",
                )
            }
        )
        result["condition"] = condition_id(
            answer["arm"],
            answer["prompt_candidate"],
            answer["configuration_sha256"],
            answer["source_page_evidence"],
        )
        scored.append(result)
    return {
        "schema": "odl-agentic-scores-v1",
        "evaluation_kind": fixture.get("evaluation_kind", "primary"),
        "questions_sha256": question_sha,
        "protocol_sha256": protocol_sha,
        "scorer_sha256": sha(__file__),
        "review_files": [{"path": str(p), "sha256": sha(p)} for p in args.reviews],
        "answer_files": plans,
        "configurations": configs,
        "weighting": "Mean within each question across attempted repeats, then mean over questions; failures remain in the denominator and always fail strict. Separate claim fractions describe any reviewed partial output even when a run fails. Claim verdict counts are diagnostics, never pooled success scores.",
        "pairing_note": "Pair only equal model/budget/code/corpus/page-generation configuration, question and repeat, retaining the same frozen index for each arm across files. Prompt and source_page_evidence remain explicit condition dimensions, with their changes labelled in secondary ODL versus baseline MinerU comparisons. Missing planned cells on either or both sides and unresolved pairs suppress the final paired delta.",
        "limits": "Aggregates recorded source judgments and validates clipped-tool excerpts, citation-region bounds and declared PDF identity. It does not independently judge entailment, inspect source pixels, resolve provider receipt/message locators or verify logical source-to-file bindings. No bootstrap interval is estimated.",
        **aggregate(scored, expected_cells),
        "attempts": scored,
    }


def check():
    from copy import deepcopy

    q = {
        "id": "q1",
        "split": "heldout",
        "family": "f",
        "language": "en",
        "answerability": "answerable",
        "required_claims": ["a", "b"],
    }
    a = {
        "id": "q1",
        "turn_id": "t",
        "repeat": 0,
        "status": "complete",
        "answer": "a b [1]",
        "scope_valid": True,
        "errors": [],
        "citation_numbers": [1],
        "invalid_citation_numbers": [],
        "citations": [
            {
                "chunkId": "c",
                "fileId": "f",
                "regions": [{"page": 1, "bbox": [0, 0, 1000, 1000]}],
            }
        ],
        "rendered_tool_results": [{"text_sent_to_model": "a b", "truncated": False}],
        "elapsed_seconds": 1,
    }
    claim = {
        "correctness": "correct",
        "grounding": "supported",
        "citation_support": "supported",
        "seen_evidence": [
            {
                "attempt_id": "source",
                "message_index": 2,
                "rendered_result_index": 0,
                "excerpt": "a b",
            }
        ],
        "source_checks": [
            {
                "support": "supported",
                "region_index": 0,
                "citation_number": 1,
                "pdf_page": 1,
                "source_id": "source",
                "pdf_sha256": "source-sha",
            }
        ],
    }
    r = {
        "schema": "odl-agentic-review-v1",
        "turn_id": "t",
        "question_id": "q1",
        "repeat": 0,
        "split": "heldout",
        "run_status": "complete",
        "scope_valid": True,
        "strict_pass": True,
        "claims": [claim | {"claim_index": i} for i in (1, 2)],
        "additional_unsupported_claims": [],
        "uncertainties": [],
        "error_tags": [],
        "primary_error": None,
        "abstention": None,
    }
    good = score(a, r, q)
    assert good["strict_pass"]
    for field, value in (("region_index", 99), ("pdf_page", 2), ("citation_number", 9)):
        bad = deepcopy(r)
        bad["claims"][0]["source_checks"][0][field] = value
        try:
            score(a, bad, q)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid citation locator accepted")
    for field, value in (
        ("message_index", -1),
        ("rendered_result_index", 9),
        ("excerpt", "clipped away"),
    ):
        bad = deepcopy(r)
        bad["claims"][0]["seen_evidence"][0][field] = value
        try:
            score(a, bad, q)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid submitted-evidence locator accepted")
    for reviews in ([], [r, r], [r | {"turn_id": "other"}]):
        try:
            index_reviews(reviews, {"t": a})
        except ValueError:
            pass
        else:
            raise AssertionError("Missing/duplicate/foreign review accepted")
    for indices in ([1], [1, 1], [1, 3], [True, 2]):
        bad = r | {"claims": [claim | {"claim_index": i} for i in indices]}
        try:
            score(a, bad, q)
        except ValueError:
            pass
        else:
            raise AssertionError("Wrong frozen claim indices accepted")
    bad = deepcopy(r)
    bad["claims"][0]["citation_support"] = "partial"
    assert not score(a, bad, q)["strict_pass"]
    failed = score(
        a | {"status": "error", "errors": ["provider"]}, r | {"run_status": "error"}, q
    )
    assert not failed["strict_pass"]
    failed["repeat"] = 1
    summary = summarize([good, failed])
    assert (
        summary["attempts"] == 2
        and summary["equal_question_weight"]["strict_pass_rate"] == 0.5
    )
    other = good | {"question_id": "q2", "strict_pass": False}
    assert (
        summarize([good, good | {"repeat": 1}, other])["equal_question_weight"][
            "strict_pass_rate"
        ]
        == 0.5
    )
    assert paired([good, failed], [good])["missing_mineru"] == [("q1", 1)]
    assert (
        paired([good, failed], [good])["equal_question_strict_delta_odl_minus_mineru"]
        is None
    )
    uncertain = good | {"unresolved": True, "strict_pass": False}
    assert paired([uncertain], [good])["counts"]["unresolved"] == 1
    incomplete = paired([good], [good], {("q1", 0), ("q2", 0)}, {("q1", 0), ("q2", 0)})
    assert incomplete["missing_odl"] == incomplete["missing_mineru"] == [("q2", 0)]
    assert not incomplete["complete_resolved_pairing"]
    assert incomplete["equal_question_strict_delta_odl_minus_mineru"] is None
    mineru = good | {
        "arm": "mineru",
        "prompt_candidate": "baseline",
        "configuration_sha256": "c",
        "condition": "mineru/baseline/c",
        "source_page_evidence": False,
    }
    assert aggregate([mineru])["paired"][0]["missing_odl"] == [("q1", 0)]
    candidate = mineru | {
        "arm": "odl",
        "prompt_candidate": "table_context",
        "condition": "odl/table_context/c",
    }
    comparison = next(
        p for p in aggregate([mineru, candidate])["paired"] if p["different_prompt"]
    )
    assert comparison["counts"]["both_pass"] == 1
    pages = candidate | {
        "source_page_evidence": True,
        "condition": "odl/table_context/c/source_page_evidence",
    }
    comparison = next(
        p
        for p in aggregate([mineru, pages])["paired"]
        if p["different_source_page_evidence"]
    )
    assert comparison["counts"]["both_pass"] == 1 and "tool" in comparison["comparison"]
    neg = deepcopy(r)
    for c in neg["claims"]:
        c["citation_support"], c["source_checks"] = "missing", []
    neg["abstention"] = {
        "verdict": "correct",
        "scope_respected": True,
        "adequate_check": True,
        "evidence_note": "Read the whole scoped table.",
    }
    assert score(a, neg, q | {"answerability": "unanswerable"})["strict_pass"]
    neg["abstention"]["adequate_check"] = False
    assert not score(a, neg, q | {"answerability": "unanswerable"})["strict_pass"]
    check_files(q, a, r)
    print(
        "Review coverage, actual evidence/citation bounds, strict axes, scoped negatives, frozen plans/index compatibility, capability labels and failure/equal-question denominators passed"
    )


def check_files(question, answer, review):
    """Exercise the file/plan boundary with synthetic records only."""
    from copy import deepcopy
    from tempfile import TemporaryDirectory
    from types import SimpleNamespace

    with TemporaryDirectory(prefix="odl-agentic-score-") as folder:
        root = Path(folder)

        def write(path, value, lines=False):
            path.write_text(
                (
                    "\n".join(json.dumps(row) for row in value)
                    if lines
                    else json.dumps(value)
                )
                + "\n",
                encoding="utf-8",
            )

        q = question | {"question": "Synthetic question", "scope_source_ids": None}
        fixture_path, reviews_path = root / "questions.json", root / "reviews.jsonl"
        write(
            fixture_path,
            {
                "schema": "synthetic-v1",
                "sources": {
                    "source": {"coordinate_pdf_sha256": "source-sha", "pages": 1}
                },
                "questions": [q, q | {"id": "q2"}],
            },
        )
        paths, reviews = [], []
        freezes = []
        for arm in ("odl", "mineru"):
            path = root / f"{arm}.jsonl"
            a = (
                deepcopy(answer)
                | q
                | {
                    "status": "error" if arm == "odl" else "complete",
                    "arm": arm,
                    "prompt_candidate": "baseline",
                    "turn_id": arm,
                    "source_page_evidence": False,
                }
            )
            a["errors"] = ["synthetic provider failure"] if arm == "odl" else []
            write(path, [a], lines=True)
            freeze = {key: {} for key in CONFIG_FIELDS} | {
                "questions_sha256": sha(fixture_path),
                "selected_ids": ["q1", "q2"],
                "arms": [arm],
                "repeats": 1,
                "prompt_candidate": "baseline",
                "source_page_evidence": False,
                "index_state": {arm: {"chunks": "unchanged"}},
                "corpus_sha256": "same-corpus",
            }
            write(path.with_suffix(".jsonl.freeze.json"), freeze)
            inputs = {
                "questions_sha256": sha(fixture_path),
                "protocol_sha256": sha(PROTOCOL),
                "answer_jsonl_sha256": sha(path),
                "answer_line": 1,
            }
            reviews.append(
                deepcopy(review)
                | {"turn_id": arm, "run_status": a["status"], "inputs": inputs}
            )
            paths.append(path)
            freezes.append(freeze)
        write(reviews_path, reviews, lines=True)
        args = SimpleNamespace(
            questions=fixture_path,
            protocol=PROTOCOL,
            answers=paths,
            reviews=[reviews_path],
        )
        result = run(args)
        pair = result["paired"][0]
        assert len(result["attempts"]) == 2 and pair["counts"]["mineru_only_pass"] == 1
        assert pair["missing_odl"] == pair["missing_mineru"] == [("q2", 0)]
        assert pair["equal_question_strict_delta_odl_minus_mineru"] is None
        assert sum(row["strict_pass"] for row in result["attempts"]) == 1

        altered = deepcopy(freezes[0])
        altered["corpus_sha256"] = "other-corpus"
        assert configuration(altered)[0] != configuration(freezes[0])[0]
        altered = deepcopy(freezes[0])
        altered["page_evidence_generation"] = {"caption_max_edge": 99}
        assert configuration(altered)[0] != configuration(freezes[0])[0]
        duplicate = read_lines = [row for _, row in jsonl(paths[0])]
        write(paths[0], duplicate + [duplicate[0] | {"turn_id": "retried"}], lines=True)
        duplicate_review = deepcopy(reviews[0]) | {"turn_id": "retried"}
        expanded = [deepcopy(reviews[0]), deepcopy(reviews[1]), duplicate_review]
        for item in (expanded[0], expanded[2]):
            item["inputs"]["answer_jsonl_sha256"] = sha(paths[0])
        expanded[2]["inputs"]["answer_line"] = 2
        write(reviews_path, expanded, lines=True)
        try:
            run(args)
        except ValueError as exc:
            assert "Duplicate condition/question/repeat" in str(exc)
        else:
            raise AssertionError("A repeated first-attempt cell was accepted")
        write(paths[0], read_lines, lines=True)
        write(reviews_path, reviews, lines=True)
        alternate = root / "alternate.jsonl"
        alternate.write_text("", encoding="utf-8")
        altered = deepcopy(freezes[0])
        altered["index_state"]["odl"]["chunks"] = "changed"
        write(alternate.with_suffix(".jsonl.freeze.json"), altered)
        args.answers.append(alternate)
        try:
            run(args)
        except ValueError as exc:
            assert "different frozen indexes" in str(exc)
        else:
            raise AssertionError("Changed same-arm index accepted")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--answers", type=Path, nargs="+", action="extend", default=[])
    parser.add_argument("--reviews", type=Path, nargs="+", action="extend", default=[])
    parser.add_argument("--questions", type=Path)
    parser.add_argument("--protocol", type=Path, default=PROTOCOL)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
    else:
        if not all((args.answers, args.reviews, args.questions, args.output)):
            parser.error("--answers, --reviews, --questions and --output are required")
        result = run(args)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(
            json.dumps(
                {
                    "attempts": len(result["attempts"]),
                    "conditions": len(result["conditions"]),
                    "output": str(args.output),
                }
            )
        )
