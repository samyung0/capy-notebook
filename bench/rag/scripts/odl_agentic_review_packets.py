"""Export neutral-labeled source-review packets without judging answers.

Requires current adjacent answer freeze files with index_state[arm].files.
Only attempted questions get packets; missing frozen plan cells are reported.
Raw arm/prompt metadata is retained, so these are not fully blinded reviews.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from collections import defaultdict
from pathlib import Path

from odl_agentic_score import PROTOCOL, configuration, require


def sha(data):
    return hashlib.sha256(data).hexdigest()


def label(index):
    result = ""
    while index >= 0:
        index, remainder = divmod(index, 26)
        result = chr(65 + remainder) + result
        index -= 1
    return result


def export(
    questions_path, answer_paths, provider_paths, output, protocol_path=PROTOCOL
):
    output = Path(output).resolve()
    require(not output.exists(), "Export directory already exists; choose a fresh path")
    inputs = {}

    def load(path, *, lines=False, text=False):
        path = Path(path).resolve()
        data = path.read_bytes()
        binding = {
            "path": Path(os.path.relpath(path, output)).as_posix(),
            "sha256": sha(data),
        }
        inputs[path] = binding
        if text:
            return data, binding
        if not lines:
            return json.loads(data), binding
        records = []
        for number, raw in enumerate(data.splitlines(keepends=True), 1):
            require(bool(raw.strip()), f"Blank JSONL line: {path}:{number}")
            row = json.loads(raw)
            require(isinstance(row, dict), f"Non-object JSONL line: {path}:{number}")
            records.append((number, row, raw))
        return records, binding

    require(answer_paths and provider_paths, "Answer and provider files are required")
    for paths in (answer_paths, provider_paths):
        require(
            len({Path(p).resolve() for p in paths}) == len(paths),
            "Duplicate input path",
        )
    fixture, question_binding = load(questions_path)
    protocol, protocol_binding = load(protocol_path, text=True)
    require(
        fixture.get("schema") and "draft" not in fixture["schema"].lower(),
        "Question fixture must be frozen",
    )
    questions = {q["id"]: q for q in fixture["questions"]}
    require(len(questions) == len(fixture["questions"]), "Duplicate question IDs")
    source_ids = set(fixture["sources"])
    for q in questions.values():
        require(
            q["required_claims"] and set(q["source_ids"]) <= source_ids,
            f"Invalid frozen claims/sources: {q['id']}",
        )
        scope = q["scope_source_ids"]
        require(
            scope is None
            or (
                isinstance(scope, list)
                and scope
                and len(set(scope)) == len(scope)
                and set(scope) <= source_ids
            ),
            f"Invalid frozen source scope: {q['id']}",
        )

    answers, plans, cells = {}, [], set()
    for path in answer_paths:
        path = Path(path)
        freeze, freeze_binding = load(path.with_suffix(path.suffix + ".freeze.json"))
        require(
            freeze["questions_sha256"] == question_binding["sha256"],
            f"Answer fixture hash differs: {path}",
        )
        config, _ = configuration(freeze)
        source_pages = freeze.get("source_page_evidence", False)
        require(type(source_pages) is bool, f"Invalid frozen capability flag: {path}")
        selected, arms, repeats = (
            freeze["selected_ids"],
            freeze["arms"],
            freeze["repeats"],
        )
        require(
            selected
            and len(set(selected)) == len(selected)
            and set(selected) <= questions.keys()
            and arms
            and len(set(arms)) == len(arms)
            and type(repeats) is int
            and repeats > 0,
            f"Invalid frozen plan: {path}",
        )
        workspaces = [freeze["index_state"][arm] for arm in arms]
        require(
            len({w["workspace_id"] for w in workspaces}) == len(workspaces),
            f"Parser arms share a workspace: {path}",
        )
        for state in workspaces:
            require(
                set(state["files"]) == source_ids,
                f"Frozen logical sources do not match fixture: {path}",
            )
            require(
                len(set(state["files"].values())) == len(source_ids),
                f"Duplicate file IDs in frozen source map: {path}",
            )
            require(
                set(state["files"].values())
                == {f["id"] for f in state["outline"]["files"]},
                f"Source mapping differs from frozen outline: {path}",
            )
        rows, answer_binding = load(path, lines=True)
        attempted = set()
        for number, answer, _ in rows:
            turn, qid = answer["turn_id"], answer["id"]
            require(
                isinstance(turn, str) and turn and turn not in answers,
                f"Duplicate/invalid answer turn: {turn}",
            )
            require(
                qid in selected and answer["arm"] in arms,
                f"Answer outside frozen plan: {turn}",
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
                    answer[field] == question[field], f"Frozen {field} differs: {turn}"
                )
            require(
                type(answer["repeat"]) is int and 0 <= answer["repeat"] < repeats,
                f"Invalid repeat: {turn}",
            )
            require(
                answer["prompt_candidate"] == freeze["prompt_candidate"]
                and type(answer.get("source_page_evidence", source_pages)) is bool
                and answer.get("source_page_evidence", source_pages) == source_pages,
                f"Answer capability differs from freeze: {turn}",
            )
            require(
                answer["status"] in {"complete", "empty", "error"},
                f"Invalid answer status: {turn}",
            )
            state = freeze["index_state"][answer["arm"]]
            expected_scope = [
                state["files"][s] for s in question["scope_source_ids"] or []
            ]
            require(
                answer["workspace_id"] == state["workspace_id"]
                and answer["resolved_file_ids"] == expected_scope,
                f"Answer workspace/source scope differs: {turn}",
            )
            cell = (qid, answer["arm"], answer["repeat"])
            require(cell not in attempted, f"Duplicate frozen attempt cell: {cell}")
            full_cell = (config, answer["prompt_candidate"], source_pages, *cell)
            require(
                full_cell not in cells,
                f"Duplicate condition/question/repeat: {full_cell}",
            )
            cells.add(full_cell)
            attempted.add(cell)
            answers[turn] = {
                "record": answer,
                "answer_input": answer_binding,
                "answer_line": number,
                "freeze_input": freeze_binding,
                "source_files": state["files"],
                "receipts": [],
            }
        planned = {
            (q, arm, r) for q in selected for arm in arms for r in range(repeats)
        }
        plans.append(
            {
                "answer_input": answer_binding,
                "freeze_input": freeze_binding,
                "missing_plan_cells": sorted(planned - attempted),
            }
        )
    require(bool(answers), "No attempted answers to export")

    attempts = set()
    for path in provider_paths:
        rows, binding = load(path, lines=True)
        for number, receipt, raw in rows:
            turn, attempt = receipt.get("turn_id"), receipt.get("attempt_id")
            require(
                turn in answers, f"Provider receipt has no answer turn: {path}:{number}"
            )
            require(
                isinstance(attempt, str) and attempt and attempt not in attempts,
                f"Duplicate/invalid provider attempt: {attempt}",
            )
            attempts.add(attempt)
            answer = answers[turn]["record"]
            for field, expected in (
                ("question_id", answer["id"]),
                ("arm", answer["arm"]),
                ("repeat", answer["repeat"]),
                ("prompt_candidate", answer["prompt_candidate"]),
            ):
                require(
                    receipt.get(field) == expected,
                    f"Receipt {field} differs: {attempt}",
                )
            require(
                isinstance(receipt.get("body"), dict),
                f"Missing outbound body: {attempt}",
            )
            answers[turn]["receipts"].append(
                {
                    "record": receipt,
                    "input": {**binding, "line": number},
                    "raw": raw,
                }
            )
    for turn, item in answers.items():
        require(
            item["receipts"] or item["record"]["status"] == "error",
            f"Non-error answer has no provider receipts: {turn}",
        )
    require(
        all(
            sha(path.read_bytes()) == binding["sha256"]
            for path, binding in inputs.items()
        ),
        "An input changed during export",
    )

    # All validation precedes the first write; existing exports are never replaced.
    output.mkdir(parents=True, exist_ok=False)
    (output / "providers").mkdir()
    (output / "protocol.md").write_bytes(protocol)
    groups = defaultdict(list)
    for turn, item in answers.items():
        groups[item["record"]["id"]].append((turn, item))
    templates, packet_index = [], []
    for index, (qid, group) in enumerate(sorted(groups.items()), 1):
        question = questions[qid]
        stem = f"packet-{index:04d}"
        packet = {
            "schema": "odl-agentic-review-packet-v1",
            "question": question,
            "source_inventory": fixture["sources"],
            "answers": [],
            "protocol": {"path": "protocol.md", "sha256": protocol_binding["sha256"]},
            "label_note": "Neutral labels only; raw records retain arm/prompt metadata.",
            "path_note": "Artifact locators are relative to the export directory. Source paths are preserved verbatim from the fixture.",
        }
        # Stable arbitrary order avoids making A consistently the same parser.
        for position, (turn, item) in enumerate(
            sorted(group, key=lambda pair: sha(pair[0].encode()))
        ):
            answer_id = "neutral-" + label(position)
            provider_path = f"providers/{stem}-{label(position)}.jsonl"
            receipts = sorted(
                item["receipts"],
                key=lambda r: (
                    r["record"].get("started_unix", 0),
                    r["record"]["attempt_id"],
                ),
            )
            provider_bytes = b"".join(
                r["raw"] if r["raw"].endswith(b"\n") else r["raw"] + b"\n"
                for r in receipts
            )
            (output / provider_path).write_bytes(provider_bytes)
            binding = {
                "questions_sha256": question_binding["sha256"],
                "answer_jsonl": item["answer_input"]["path"],
                "answer_jsonl_sha256": item["answer_input"]["sha256"],
                "answer_line": item["answer_line"],
                "provider_jsonl": provider_path,
                "provider_jsonl_sha256": sha(provider_bytes),
                "protocol_sha256": protocol_binding["sha256"],
            }
            packet["answers"].append(
                {
                    "answer_id": answer_id,
                    "inputs": binding,
                    "record": item["record"],
                    "freeze_input": item["freeze_input"],
                    "source_files": item["source_files"],
                    "provider_receipts": [
                        {
                            "export_line": n,
                            "original_input": r["input"],
                            "record": r["record"],
                        }
                        for n, r in enumerate(receipts, 1)
                    ],
                    "receipt_note": "No provider request was recorded for this error turn."
                    if not receipts
                    else None,
                }
            )
            templates.append(
                {
                    "schema": "odl-agentic-review-v1-draft",
                    "question_id": qid,
                    "answer_id": answer_id,
                    "turn_id": turn,
                    "repeat": item["record"]["repeat"],
                    "split": question["split"],
                    "reviewer": None,
                    "inputs": binding,
                    "run_status": item["record"]["status"],
                    "scope_valid": None,
                    "claims": [
                        {
                            "claim_index": n,
                            "correctness": None,
                            "grounding": None,
                            "citation_support": None,
                            "answer_excerpt": None,
                            "seen_evidence": [],
                            "source_checks": [],
                            "note": None,
                        }
                        for n in range(1, len(question["required_claims"]) + 1)
                    ],
                    "additional_unsupported_claims": [],
                    "abstention": {
                        "verdict": None,
                        "scope_respected": None,
                        "adequate_check": None,
                        "evidence_note": None,
                    }
                    if question["answerability"] == "unanswerable"
                    else None,
                    "primary_error": None,
                    "error_tags": [],
                    "strict_pass": None,
                    "uncertainties": [],
                    "adjudication": None,
                }
            )
        packet_path = output / f"{stem}.json"
        packet_path.write_text(
            json.dumps(packet, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        packet_index.append(
            {
                "question_id": qid,
                "path": packet_path.name,
                "sha256": sha(packet_path.read_bytes()),
                "answers": len(group),
            }
        )
    template_path = output / "reviews-template.jsonl"
    template_path.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in templates),
        encoding="utf-8",
    )
    manifest = {
        "schema": "odl-agentic-review-export-v1",
        "exporter_sha256": sha(Path(__file__).read_bytes()),
        "inputs": list(inputs.values()),
        "plans": plans,
        "packets": packet_index,
        "unattempted_fixture_questions": sorted(questions.keys() - groups.keys()),
        "review_template": {
            "path": template_path.name,
            "sha256": sha(template_path.read_bytes()),
        },
        "attempts": len(answers),
        "provider_attempts": len(attempts),
        "instructions": "Fill every claim judgment and evidence locator using protocol.md. Change the review schema to odl-agentic-review-v1 only after completing the review. No judgments were generated by this exporter.",
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def check():
    """Synthetic bindings only; never read or judge real benchmark answers."""
    import tempfile
    from copy import deepcopy

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)

        def write(name, value, lines=False):
            path = root / name
            path.write_text(
                "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in value)
                if lines
                else json.dumps(value, ensure_ascii=False),
                encoding="utf-8",
            )
            return path

        question = {
            "id": "q1",
            "question": "Synthetic question",
            "split": "dev",
            "family": "synthetic",
            "language": "en",
            "scope_source_ids": None,
            "source_ids": ["source"],
            "answerability": "answerable",
            "required_claims": ["first", "second"],
            "evidence": [],
        }
        fixture = {
            "schema": "frozen",
            "questions": [question],
            "sources": {
                "source": {
                    "coordinate_pdf": "source.pdf",
                    "coordinate_pdf_sha256": "a" * 64,
                    "pages": 1,
                }
            },
        }
        questions = write("questions.json", fixture)
        protocol = root / "protocol.md"
        protocol.write_text("Synthetic review protocol", encoding="utf-8")
        freeze = {
            "questions_sha256": sha(questions.read_bytes()),
            "model": {},
            "enable_thinking": False,
            "limits": {},
            "search_sql_sha256": "synthetic",
            "search_mode": "synthetic",
            "runtime_sources": {},
            "harness_sources": {},
            "qwen_endpoint": "https://example.invalid",
            "selected_ids": ["q1"],
            "arms": ["left", "right"],
            "repeats": 1,
            "prompt_candidate": "baseline",
            "index_state": {
                arm: {
                    "workspace_id": arm,
                    "files": {"source": arm + "-file"},
                    "outline": {"files": [{"id": arm + "-file"}]},
                }
                for arm in ("left", "right")
            },
        }
        rows = [
            {
                **{
                    k: question[k]
                    for k in (
                        "id",
                        "question",
                        "split",
                        "family",
                        "language",
                        "scope_source_ids",
                    )
                },
                "turn_id": arm,
                "arm": arm,
                "repeat": 0,
                "workspace_id": arm,
                "resolved_file_ids": [],
                "prompt_candidate": "baseline",
                "status": "complete",
                "answer": "Synthetic text [1]",
                "citations": [],
                "rendered_tool_results": [],
                "page_evidence": {"receipts": []},
            }
            for arm in ("left", "right")
        ]
        answers = write("answers.jsonl", rows, lines=True)
        freeze_path = write("answers.jsonl.freeze.json", freeze)
        records = [
            {
                "turn_id": arm,
                "attempt_id": str(n),
                "question_id": "q1",
                "arm": arm,
                "repeat": 0,
                "prompt_candidate": "baseline",
                "phase": "agent",
                "started_unix": n,
                "body": {"messages": [{"role": "tool", "content": "literal α text"}]},
            }
            for n, arm in enumerate(("left", "right", "left"))
        ]
        first = write("providers1.jsonl", records[:2], lines=True)
        second = write("providers2.jsonl", records[2:], lines=True)
        originals = {
            p: p.read_bytes()
            for p in (questions, protocol, answers, freeze_path, first, second)
        }
        output = root / "export"
        manifest = export(questions, [answers], [first, second], output, protocol)
        assert manifest["attempts"] == 2 and manifest["provider_attempts"] == 3
        packet = json.loads((output / "packet-0001.json").read_bytes())
        assert {a["answer_id"] for a in packet["answers"]} == {"neutral-A", "neutral-B"}
        assert (
            packet["question"] == question
            and packet["source_inventory"] == fixture["sources"]
        )
        for a in packet["answers"]:
            turn = a["record"]["turn_id"]
            assert a["record"] == next(row for row in rows if row["turn_id"] == turn)
            binding = a["inputs"]
            assert (output / binding["answer_jsonl"]).resolve() == answers
            assert rows[binding["answer_line"] - 1] == a["record"]
            exported = output / binding["provider_jsonl"]
            assert sha(exported.read_bytes()) == binding["provider_jsonl_sha256"]
            exported_rows = [
                json.loads(line) for line in exported.read_bytes().splitlines()
            ]
            assert exported_rows == [r["record"] for r in a["provider_receipts"]]
            for receipt in a["provider_receipts"]:
                loc = receipt["original_input"]
                original = (output / loc["path"]).resolve()
                assert sha(original.read_bytes()) == loc["sha256"]
                assert (
                    json.loads(original.read_bytes().splitlines()[loc["line"] - 1])
                    == receipt["record"]
                )
        for template in (output / "reviews-template.jsonl").read_text().splitlines():
            template = json.loads(template)
            assert (
                template["schema"].endswith("-draft")
                and template["strict_pass"] is None
            )
            assert [c["claim_index"] for c in template["claims"]] == [1, 2]
            assert all(c["correctness"] is None for c in template["claims"])
        assert all(p.read_bytes() == data for p, data in originals.items())
        try:
            export(questions, [answers], [first, second], output, protocol)
        except ValueError:
            pass
        else:
            raise AssertionError("Existing export was overwritten")
        cases = [
            (answers, rows + [rows[0]], True),
            (answers, [rows[0] | {"status": "unknown"}], True),
            (answers, [rows[0] | {"source_page_evidence": 0}], True),
            (first, records[:2] + [records[0]], True),
            (first, [records[0] | {"turn_id": "foreign"}], True),
            (first, [records[0] | {"question_id": "foreign"}], True),
        ]
        bad_freeze = deepcopy(freeze)
        bad_freeze["index_state"]["left"]["files"] = {"wrong-source": "left-file"}
        cases.append((freeze_path, bad_freeze, False))
        for n, (path, value, lines) in enumerate(cases):
            write(path.name, value, lines=lines)
            destination = root / f"invalid-{n}"
            try:
                export(questions, [answers], [first, second], destination, protocol)
            except ValueError:
                pass
            else:
                raise AssertionError("Invalid binding accepted")
            assert not destination.exists()
            path.write_bytes(originals[path])
        repeated = write(
            "second-answers.jsonl",
            [row | {"turn_id": row["turn_id"] + "-again"} for row in rows],
            lines=True,
        )
        write("second-answers.jsonl.freeze.json", freeze)
        try:
            export(
                questions,
                [answers, repeated],
                [first, second],
                root / "duplicate-cell",
                protocol,
            )
        except ValueError as exc:
            assert "Duplicate condition/question/repeat" in str(exc)
        else:
            raise AssertionError("Cross-file competing attempts were accepted")
        assert not (root / "duplicate-cell").exists()
    print(
        "Passed synthetic packet/receipt/template identity, neutral labels, "
        "source/turn binding, input preservation and overwrite rejection"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--questions", type=Path)
    parser.add_argument("--answers", type=Path, nargs="+")
    parser.add_argument("--providers", type=Path, nargs="+")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--protocol", type=Path, default=PROTOCOL)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not all((args.questions, args.answers, args.providers, args.output)):
        parser.error("--questions, --answers, --providers and --output are required")
    result = export(
        args.questions, args.answers, args.providers, args.output, args.protocol
    )
    print(json.dumps({k: result[k] for k in ("attempts", "provider_attempts")}))


if __name__ == "__main__":
    main()
