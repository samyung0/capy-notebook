"""Offline checks for the book review runner's evidence and send boundaries."""

import copy
import json

import knowledge_review_samples as samples
import pytest


@pytest.mark.parametrize("input_mode", ["case", "packet"])
@pytest.mark.parametrize("thinking", [False, True])
def test_dry_run_uses_supplied_input_without_answer_key_credentials_or_network(
    monkeypatch, tmp_path, input_mode, thinking
):
    def forbidden(*args, **kwargs):
        pytest.fail("Dry run crossed the credential or network boundary")

    monkeypatch.setattr(samples, "dotenv_values", forbidden)
    monkeypatch.setattr(samples.httpx, "Client", forbidden)
    packet = samples.load_case("01-book-defects")
    source = ["--case", packet["case_id"]]
    if input_mode == "packet":
        packet["case_id"] = "saved-sol-packet"
        path = tmp_path / "packet.json"
        path.write_text(json.dumps(packet), encoding="utf-8")
        source = ["--packet", str(path)]
        monkeypatch.setattr(samples, "load_case", forbidden)
    output = tmp_path / "dry"
    options = ["--thinking"] if thinking else []
    samples.main([*source, *options, "--output", str(output), "--dry-run"])
    receipt = json.loads((output / "receipt.json").read_text())
    assert receipt["sent"] is False
    assert receipt["case_id"] == packet["case_id"]
    request = json.loads((output / "request.json").read_text())
    assert request["enable_thinking"] is thinking
    assert (
        not {"max_tokens", "max_completion_tokens", "thinking_budget"} & request.keys()
    )
    assert request["response_format"] == {
        "type": "json_schema",
        "json_schema": {
            "name": "book_review",
            "strict": True,
            "schema": samples.read_json(samples.FIXTURES / "response-schema.json"),
        },
    }
    assert json.loads(request["messages"][1]["content"]) == packet
    assert "must_find" not in json.dumps(request)


def test_validation_rejects_missing_coverage_and_fabricated_evidence():
    packet = samples.load_case("04-context-defect")
    packet["assignment"]["fields"] = ["context_links"]
    review = {
        "case_id": packet["case_id"],
        "review_status": "needs_changes",
        "reviewed_ids": ["solution-a"],
        "findings": [
            {
                "category": "context_links",
                "target_ids": ["solution-a"],
                "field": "retrieval.context_excerpt_ids",
                "issue": "The link points to another exercise.",
                "evidence": [
                    {"excerpt_id": "solution-a", "quote": "Solution to Exercise A."}
                ],
                "action": "Link question-a instead.",
            }
        ],
        "missing_evidence": [],
    }
    samples.validate_review(review, packet)
    bad = copy.deepcopy(review)
    bad["reviewed_ids"] = ["question-b"]
    with pytest.raises(ValueError, match="every assigned target"):
        samples.validate_review(bad, packet)
    bad = copy.deepcopy(review)
    bad["findings"][0]["evidence"][0]["quote"] = "An invented source quotation."
    with pytest.raises(ValueError, match="quote a supplied"):
        samples.validate_review(bad, packet)
    bad = copy.deepcopy(review)
    bad["review_status"] = "pass"
    with pytest.raises(ValueError, match="Status must agree"):
        samples.validate_review(bad, packet)
    bad = copy.deepcopy(review)
    bad["findings"][0]["category"] = "roles"
    with pytest.raises(ValueError, match="outside assigned fields"):
        samples.validate_review(bad, packet)
