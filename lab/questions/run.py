"""Local clean-room question authoring. Every model invocation is an explicit stage."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
import time
import urllib.request
import uuid
from pathlib import Path
from tempfile import TemporaryDirectory

import schema
from copycheck import overlaps
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from pipeline.prompts.generate import QUESTION_CONTRACT

# Recorded in every receipt and packet hash; packets made for another model stay unused.
MODEL = {"model": "claude-opus-5-5", "effort": "medium"}


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PendingStage(Exception):
    """A frozen packet needs a fresh subagent before this stage can resume."""


def validate_stage_output(stage, payload, value):
    if stage == "write" and len(value["questions"]) != payload["count"]:
        raise ValueError("Writer returned a different question count")
    if stage == "passage":
        if len(value["questions"]) != 1:
            raise ValueError("A passage packet returns one question")
        types = value["question_types"]
        allowed = {t["id"] for t in payload["question_types"]}
        if len(set(types)) != len(types) or not set(types) <= allowed:
            raise ValueError("Passage question types must be distinct vocabulary ids")
    if stage == "solve":
        parts = payload["question"]["parts"]
        answers = value["answers"]
        if len(answers) != len(parts) or {a["part_id"] for a in answers} != {
            p["id"] for p in parts
        }:
            raise ValueError("Solver did not answer each part exactly once")
    if stage == "fix":
        if len(value["questions"]) != 1:
            raise ValueError("Fix must return one question")
        if len(value["questions"][0]["parts"]) != len(payload["question"]["parts"]):
            raise ValueError("Fix changed part count")
    if stage == "references" and any(
        not ref["url"].startswith("https://") for ref in value["references"]
    ):
        raise ValueError("Reference download requires HTTPS")


def verify_packet(packet, receipt):
    for name, key in (
        ("input.json", "input_sha256"),
        ("schema.json", "schema_sha256"),
        ("prompt.md", "prompt_sha256"),
    ):
        if sha(packet / name) != receipt[key]:
            raise ValueError("Frozen agent packet was modified")
    if receipt["stage"] in ("solve", "judge"):
        digest = receipt.get("learner_image_sha256")
        image = packet / "learner.png"
        if (
            not digest
            or not image.is_file()
            or sha(image) != digest
            or read(packet / "input.json").get("learner_image")
            != {"path": "learner.png", "sha256": digest}
        ):
            raise ValueError("Frozen learner image is missing or changed")


def invoke(topic, stage, payload, shape, learner_image=None):
    """Prepare a packet, then admit the explicitly bound worker's output."""
    prompt = (Path(__file__).parent / "prompts" / (stage + ".md")).read_text(
        encoding="utf-8"
    )
    image_bytes = learner_image.read_bytes() if learner_image else None
    if stage in ("solve", "judge"):
        if image_bytes is None:
            raise ValueError("Solve/judge packets require a learner image")
        payload = {
            **payload,
            "learner_image": {
                "path": "learner.png",
                "sha256": hashlib.sha256(image_bytes).hexdigest(),
            },
        }
    identity = json.dumps(
        {
            "stage": stage,
            "input": payload,
            "schema": shape,
            "prompt": prompt,
            **MODEL,
        },
        sort_keys=True,
        ensure_ascii=False,
        allow_nan=False,
    )
    run_id = stage + "-" + hashlib.sha256(identity.encode()).hexdigest()[:20]
    receipt_dir = topic / "receipts" / run_id
    receipt_path = receipt_dir / "receipt.json"
    if not receipt_path.exists():
        receipt_dir.mkdir(parents=True, exist_ok=True)
        save(receipt_dir / "input.json", payload)
        save(receipt_dir / "schema.json", shape)
        (receipt_dir / "prompt.md").write_text(prompt, encoding="utf-8")
        if image_bytes is not None:
            (receipt_dir / "learner.png").write_bytes(image_bytes)
        save(
            receipt_path,
            {
                "stage": stage,
                **MODEL,
                "provider": "claude_code_subagent",
                "agent_id": None,
                "input_sha256": sha(receipt_dir / "input.json"),
                "schema_sha256": sha(receipt_dir / "schema.json"),
                "prompt_sha256": sha(receipt_dir / "prompt.md"),
                "runner_sha256": sha(Path(__file__)),
                **(
                    {"learner_image_sha256": payload["learner_image"]["sha256"]}
                    if image_bytes is not None
                    else {}
                ),
                "status": "awaiting_agent",
                "created_at": time.time(),
                "usage": None,
                "usage_note": "Not exposed by the subagent tool",
                "retries": 0,
            },
        )
    receipt = read(receipt_path)
    verify_packet(receipt_dir, receipt)
    output = receipt_dir / "output.json"
    if not output.exists():
        print("Awaiting subagent: " + str(receipt_dir))
        raise PendingStage()
    if not receipt.get("agent_id"):
        raise ValueError("Bind the dispatched agent with run.py bind before admission")
    value = read(output)
    Draft202012Validator(shape).validate(value)
    validate_stage_output(stage, payload, value)
    digest = sha(output)
    if receipt["status"] == "complete" and receipt["output_sha256"] != digest:
        raise ValueError("Admitted agent output changed; prepare a new run")
    if receipt["status"] != "complete":
        receipt.update(
            status="complete", output_sha256=digest, completed_at=time.time()
        )
        save(receipt_path, receipt)
    return value


def questions(topic):
    paths = sorted((topic / "questions").glob("*.json"))
    if not paths:
        raise ValueError("No questions; run write first")
    return [(p, read(p)) for p in paths]


def learner(question):
    view = copy.deepcopy(question)
    for part in view["parts"]:
        answer = part["answer"]
        visible = {"type": answer["type"]}
        if answer["type"] in ("mcq", "multi", "matching"):
            visible["options"] = answer["options"]
        if answer["type"] == "matching":
            visible["left"] = [p["left"] for p in answer["pairs"]]
        if answer["type"] == "ordering":
            # Stable permutation without publishing the correct stored order.
            visible["items"] = sorted(
                answer["items"],
                key=lambda text: hashlib.sha256(text.encode()).hexdigest(),
            )
        if "unit" in answer:
            visible["unit"] = answer["unit"]
        part["answer"] = visible
        part.pop("markscheme", None)
        part.pop("solution")
    for blocks in [view["stem"], *(part["blocks"] for part in view["parts"])]:
        for index, block in enumerate(blocks):
            if block["type"] in ("graph", "image"):
                blocks[index] = {
                    "type": "image",
                    "image": {"url": "learner.png"},
                    "description": block["description"],
                    "width": block["width"],
                    "height": block["height"],
                    **(
                        {"attribution": block["attribution"]}
                        if "attribution" in block
                        else {}
                    ),
                }
    return view


def learner_image(topic, path, question):
    evidence = read(topic / "render" / "learner-manifest.json")[question["id"]]
    image = topic / "render" / (question["id"] + ".learner.png")
    if evidence != {"question_sha256": sha(path), "image_sha256": sha(image)}:
        raise ValueError("Missing/stale learner render; render before solving")
    return image


def assign_ids(question, previous=None):
    question["id"] = previous["id"] if previous else str(uuid.uuid4())
    if previous and len(question["parts"]) != len(previous["parts"]):
        raise ValueError(
            "Fix changed part count; publish a new authored question instead"
        )
    for index, part in enumerate(question["parts"]):
        part["id"] = previous["parts"][index]["id"] if previous else str(uuid.uuid4())
    return question


def closed_correct(answer, value):
    kind = answer["type"]
    if kind == "mcq" and type(value) is int:
        value = [value]  # The solve schema admits a bare index for a single choice.
    if kind in ("mcq", "multi"):
        return (
            isinstance(value, list)
            and all(type(v) is int for v in value)
            and sorted(value) == sorted(answer["correct"])
        )
    if kind == "boolean":
        return type(value) is bool and value == answer["correct"]
    if kind == "short":
        return isinstance(value, str) and value.strip().casefold() in {
            v.strip().casefold() for v in answer["accepted"]
        }
    if kind == "matching":
        return (
            isinstance(value, list)
            and all(type(v) is int for v in value)
            and value == [p["right"] for p in answer["pairs"]]
        )
    if kind == "ordering":
        return value == answer["items"]
    raise ValueError("Open answers require the explicit judge stage model")


def reference_text(topic):
    paths = sorted((topic / "references").glob("*.txt"))
    if not paths:
        raise ValueError(
            "No extracted reference text. Add approved local references and UTF-8 .txt extractions first"
        )
    return {p.name: p.read_text(encoding="utf-8") for p in paths}


WEB_SOURCE_KEYS = (
    "url",
    "title",
    "authors",
    "publisher",
    "license",
    "licenseUrl",
    "retrievedAt",
)


def passage_source(passage):
    """The bank source for a passage entry: a library excerpt or a licensed web page."""
    if passage.get("kind") == "web":
        return {
            "kind": "web",
            **{k: passage[k] for k in WEB_SOURCE_KEYS if k in passage},
        }
    return {
        "kind": "library",
        **{k: passage[k] for k in ("excerptId", "bookId", "version")},
    }


def check():
    graph = {
        "type": "graph",
        "description": "A plotted curve",
        "width": 600,
        "height": 400,
        "board": {"bbox": [-5, 5, 5, -5]},
        "elements": [{"type": "functiongraph", "term": "secret", "hidden": True}],
        "image": {"svg": "secret"},
    }
    q = {
        "id": "q",
        "stem": [graph],
        "parts": [
            {
                "id": "p",
                "blocks": [graph],
                "answer": {
                    "type": "matching",
                    "options": ["a", "b"],
                    "pairs": [{"left": "x", "right": 1}],
                },
                "marks": 1,
                "solution": [{"type": "text", "text": "secret"}],
            }
        ],
    }
    visible = learner(q)
    assert (
        "secret" not in json.dumps(visible)
        and "pairs" not in visible["parts"][0]["answer"]
    )
    assert q["parts"][0]["solution"] == [{"type": "text", "text": "secret"}]
    for block in (visible["stem"][0], visible["parts"][0]["blocks"][0]):
        assert block == {
            "type": "image",
            "image": {"url": "learner.png"},
            "description": "A plotted curve",
            "width": 600,
            "height": 400,
        }
    assert q["stem"][0]["elements"][0]["term"] == "secret"
    assert closed_correct({"type": "short", "accepted": ["12"], "unit": "cm"}, "12")
    assert not closed_correct(
        {"type": "short", "accepted": ["12"], "unit": "cm"}, "12 cm"
    )
    assert overlaps(
        {"text": "one two three four five six seven eight nine ten eleven twelve"},
        {"r": "one two three four five six seven eight nine ten eleven twelve"},
    )
    Draft202012Validator.check_schema(schema.WRITE)
    with TemporaryDirectory(prefix="capy-bank-check-") as directory:
        topic = Path(directory)
        payload = {"offline": True}
        try:
            invoke(topic, "style", payload, schema.STYLE)
        except PendingStage:
            pass
        else:
            raise AssertionError("An unrun packet must remain pending")
        packet = next((topic / "receipts").iterdir())
        save(packet / "output.json", {"style": "Original style notes"})
        try:
            invoke(topic, "style", payload, schema.STYLE)
        except ValueError as error:
            assert "Bind" in str(error)
        else:
            raise AssertionError("Unbound agent output was admitted")
        receipt = read(packet / "receipt.json")
        receipt["agent_id"] = "offline-test"
        save(packet / "receipt.json", receipt)
        assert invoke(topic, "style", payload, schema.STYLE)["style"]
        save(packet / "output.json", {"style": "Changed after admission"})
        try:
            invoke(topic, "style", payload, schema.STYLE)
        except ValueError as error:
            assert "changed" in str(error)
        else:
            raise AssertionError("Changed admitted output was accepted")
    for stage, payload, invalid, valid in (
        ("write", {"count": 1}, {"questions": []}, {"questions": [{}]}),
        (
            "solve",
            {"question": {"parts": [{"id": "p"}]}},
            {"answers": [{"part_id": "wrong", "answer": "x"}]},
            {"answers": [{"part_id": "p", "answer": "x"}]},
        ),
    ):
        with TemporaryDirectory(prefix="capy-bank-check-") as directory:
            topic = Path(directory)
            image = topic / "source.png" if stage == "solve" else None
            if image:
                image.write_bytes(b"offline learner image")
            try:
                invoke(topic, stage, payload, {"type": "object"}, image)
            except PendingStage:
                pass
            packet = next((topic / "receipts").iterdir())
            receipt = read(packet / "receipt.json")
            receipt["agent_id"] = "offline-test"
            save(packet / "receipt.json", receipt)
            save(packet / "output.json", invalid)
            try:
                invoke(topic, stage, payload, {"type": "object"}, image)
            except ValueError:
                assert read(packet / "receipt.json")["status"] == "awaiting_agent"
            else:
                raise AssertionError("Semantically invalid output was admitted")
            save(packet / "output.json", valid)
            assert invoke(topic, stage, payload, {"type": "object"}, image) == valid
            if image:
                (packet / "learner.png").write_bytes(b"changed image")
                for admission in (False, True):
                    try:
                        if admission:
                            invoke(topic, stage, payload, {"type": "object"}, image)
                        else:
                            verify_packet(packet, read(packet / "receipt.json"))
                    except ValueError as error:
                        assert "learner image" in str(error)
                    else:
                        raise AssertionError("Changed learner image was accepted")
    print(
        "Offline checks passed: blind projection, fixed-unit exact answers, overlap detection, schema and frozen subagent output admission"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "stage",
        choices=[
            "check",
            "bind",
            "references",
            "style",
            "write",
            "passage",
            "solve",
            "compare",
            "fix",
            "copycheck",
            "prepare-publish",
        ],
    )
    parser.add_argument("topic", type=Path, nargs="?")
    parser.add_argument("--count", type=int)
    parser.add_argument("--agent-id")
    args = parser.parse_args()
    if args.stage == "check":
        check()
        return
    if args.topic is None:
        parser.error("topic directory is required")
    topic = args.topic.resolve()
    if not topic.is_relative_to((ROOT / "data/question-bank").resolve()):
        parser.error("topic directory must be under ignored data/question-bank")
    if args.stage == "bind":
        if not args.agent_id:
            parser.error("bind requires --agent-id from the dispatched subagent")
        receipt = read(topic / "receipt.json")
        verify_packet(topic, receipt)
        if receipt.get("agent_id") not in (None, args.agent_id):
            raise ValueError("Packet already belongs to a different agent")
        receipt["agent_id"] = args.agent_id
        save(topic / "receipt.json", receipt)
        return
    metadata = read(topic / "topic.json")
    for key in ("exam", "subject", "topic"):
        if not all(k in metadata[key] for k in ("id", "label", "position")):
            raise ValueError("topic.json needs exam/subject/topic id, label, position")
    if not metadata["topic"].get("syllabus_reference"):
        raise ValueError("Supply a verified syllabus reference before generation")
    if args.stage == "references":
        found = invoke(topic, "references", metadata, schema.REFERENCES)
        save(topic / "references" / "sources.json", found)
        for ref in found["references"]:
            if not ref["url"].startswith("https://"):
                raise ValueError("Reference download requires HTTPS")
            with urllib.request.urlopen(ref["url"], timeout=60) as response:
                data = response.read(20 * 1024 * 1024 + 1)
            if len(data) > 20 * 1024 * 1024:
                raise ValueError("Reference exceeds 20 MiB")
            name = hashlib.sha256(data).hexdigest()
            if data.startswith(b"%PDF"):
                import fitz

                (topic / "references" / (name + ".pdf")).write_bytes(data)
                with fitz.open(stream=data, filetype="pdf") as document:
                    text = "\n".join(page.get_text() for page in document)
            else:
                (topic / "references" / (name + ".html")).write_bytes(data)
                text = re.sub(r"<[^>]+>", " ", data.decode("utf-8"))
            if not text.strip():
                raise ValueError(
                    "Reference has no extracted text; supply a reviewed OCR extraction"
                )
            (topic / "references" / (name + ".txt")).write_text(text, encoding="utf-8")
    elif args.stage == "style":
        result = invoke(
            topic,
            "style",
            {"topic": metadata, "references": reference_text(topic)},
            schema.STYLE,
        )
        (topic / "style.md").write_text(result["style"], encoding="utf-8")
    elif args.stage == "write":
        if not args.count or not 1 <= args.count <= 50:
            parser.error("write requires --count 1..50")
        if list((topic / "questions").glob("*.json")):
            raise ValueError(
                "Questions already exist; use fix or a fresh topic run directory"
            )
        result = invoke(
            topic,
            "write",
            {
                "topic": metadata,
                "style": (topic / "style.md").read_text(encoding="utf-8"),
                "count": args.count,
                "contract": QUESTION_CONTRACT,
            },
            schema.WRITE,
        )
        for question in result["questions"]:
            assign_ids(question)
            save(topic / "questions" / (question["id"] + ".json"), question)
    elif args.stage == "passage":
        # One packet per passage (library excerpt or web page); provenance comes from passages.json, never the writer.
        if list((topic / "questions").glob("*.json")):
            raise ValueError(
                "Questions already exist; use fix or a fresh topic run directory"
            )
        vocabulary = metadata["subject"].get("question_types")
        if not vocabulary:
            raise ValueError(
                "topic.json subject needs question_types from the syllabus"
            )
        written = []
        pending = False
        for passage in read(topic / "passages.json"):
            if passage.get("section") not in (1, 2, 3):
                raise ValueError(
                    "Each passage names its IELTS section pattern: 1, 2 or 3"
                )
            try:
                result = invoke(
                    topic,
                    "passage",
                    {
                        "topic": metadata,
                        "style": (topic / "style.md").read_text(encoding="utf-8"),
                        "passage": passage,
                        "section": passage["section"],
                        "question_types": vocabulary,
                        "contract": QUESTION_CONTRACT,
                    },
                    schema.PASSAGE,
                )
            except PendingStage:
                pending = True
                continue
            written.append((passage, result))
        if pending:
            raise PendingStage()
        sources, types = {}, {}
        for passage, result in written:
            question = assign_ids(result["questions"][0])
            save(topic / "questions" / (question["id"] + ".json"), question)
            sources[question["id"]] = [passage_source(passage)]
            types[question["id"]] = result["question_types"]
        save(topic / "sources.json", sources)
        save(topic / "question-types.json", types)
    elif args.stage == "solve":
        pending = False
        for path, question in questions(topic):
            try:
                result = invoke(
                    topic,
                    "solve",
                    {"question": learner(question)},
                    schema.SOLVE,
                    learner_image(topic, path, question),
                )
            except PendingStage:
                pending = True
                continue
            save(topic / "solve" / path.name, {"question_sha256": sha(path), **result})
        if pending:
            raise PendingStage()
    elif args.stage == "compare":
        rows = []
        pending = False
        for path, question in questions(topic):
            solved = read(topic / "solve" / path.name)
            if solved["question_sha256"] != sha(path):
                raise ValueError("Solver result is stale; run solve again")
            answers = {a["part_id"]: a["answer"] for a in solved["answers"]}
            scores = []
            for part in question["parts"]:
                if part["answer"]["type"] == "open":
                    try:
                        result = invoke(
                            topic,
                            "judge",
                            {
                                "question": learner(question),
                                "part_id": part["id"],
                                "answer": answers[part["id"]],
                                "markscheme": part["markscheme"],
                                "model_answer": part["answer"]["accepted"],
                            },
                            schema.JUDGE,
                            learner_image(topic, path, question),
                        )
                    except PendingStage:
                        pending = True
                        continue
                    score = result["score"]
                else:
                    score = int(closed_correct(part["answer"], answers[part["id"]]))
                scores.append({"part_id": part["id"], "score": score})
            rows.append(
                {
                    "id": question["id"],
                    "sha256": sha(path),
                    "parts": scores,
                    "agreed": all(s["score"] == 1 for s in scores),
                }
            )
        if pending:
            raise PendingStage()
        save(topic / "compare.json", rows)
    elif args.stage == "fix":
        pending = False
        repairs = []
        for row in read(topic / "compare.json"):
            if row["agreed"]:
                continue
            path = topic / "questions" / (row["id"] + ".json")
            if sha(path) != row["sha256"]:
                raise ValueError("Comparison is stale")
            old = read(path)
            try:
                result = invoke(
                    topic,
                    "fix",
                    {
                        "question": old,
                        "blind_solution": read(topic / "solve" / path.name),
                        "comparison": row,
                        "contract": QUESTION_CONTRACT,
                    },
                    schema.WRITE,
                )
            except PendingStage:
                pending = True
                continue
            repairs.append((path, assign_ids(result["questions"][0], old)))
        if pending:
            raise PendingStage()
        for path, question in repairs:
            save(path, question)
    elif args.stage == "copycheck":
        refs = reference_text(topic)
        save(
            topic / "copycheck.json",
            [
                {"id": q["id"], "sha256": sha(p), "overlaps": overlaps(q, refs)}
                for p, q in questions(topic)
            ],
        )
    else:
        source_path = topic / "sources.json"
        source_refs = read(source_path) if source_path.exists() else {}
        types_path = topic / "question-types.json"
        question_types = read(types_path) if types_path.exists() else {}
        comparisons = {r["id"]: r for r in read(topic / "compare.json")}
        copies = {r["id"]: r for r in read(topic / "copycheck.json")}
        renders = read(topic / "render" / "manifest.json")
        accepted = []
        dropped = []
        for path, q in questions(topic):
            digest = sha(path)
            comparison = comparisons.get(q["id"])
            copied = copies.get(q["id"])
            if (
                not comparison
                or comparison["sha256"] != digest
                or not copied
                or copied["sha256"] != digest
                or renders.get(q["id"]) != digest
            ):
                raise ValueError("Missing/stale solve, copycheck or render evidence")
            if not comparison["agreed"] or copied["overlaps"]:
                dropped.append(
                    {
                        "id": q["id"],
                        "reason": "unresolved solver disagreement or reference overlap",
                    }
                )
                continue
            accepted.append(
                {
                    "content": q,
                    "sources": source_refs.get(q["id"], []),
                    "questionTypes": question_types.get(q["id"], []),
                    "sha256": digest,
                }
            )
        if not accepted:
            raise ValueError("No publishable questions")
        save(
            topic / "publish.json",
            {
                "syllabus": metadata,
                "run": topic.name,
                "questions": accepted,
                "dropped": dropped,
            },
        )
        print(
            f"Prepared {len(accepted)} questions; dropped {len(dropped)}. No upload or database write performed."
        )


if __name__ == "__main__":
    try:
        main()
    except PendingStage:
        sys.exit(2)
