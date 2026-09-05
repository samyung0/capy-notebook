"""Offline checks for required evidence hops and numeric fidelity."""

from run_agent import score, supports

question = {
    "evidence_groups": [
        [{"file": "field.md", "quote": "Amber sample is CT-123."}],
        [{"file": "register.md", "quote": "CT-123 uses AX-321."}],
    ],
    "answer_patterns": ["37"],
}
passages = [
    {"file_name": "field.md", "chunk_id": "a", "text": "Amber sample is CT-123."}
]
partial = score(question, "37 degrees [1]", passages, {"a"})
assert partial["answer_values_present"]
assert not partial["all_evidence_reached"]
assert not partial["all_evidence_cited"]
passages.append(
    {"file_name": "register.md", "chunk_id": "b", "text": "CT-123 uses AX-321."}
)
complete = score(question, "37 degrees [1][2]", passages, {"a", "b"})
assert complete["all_evidence_reached"] and complete["all_evidence_cited"]
assert not score(question, "137 degrees", passages, {"a", "b"})["answer_values_present"]
assert not score(question, "-37 degrees", passages, {"a", "b"})["answer_values_present"]
assert not score(question, "CT-37", passages, {"a", "b"})["answer_values_present"]
assert not supports(
    {"file_name": "log.pdf", "text": "Response: 606"},
    {"file": "log.pdf", "contains": ["6.06"]},
)
print("Evidence, decimal fidelity, and numeric-boundary grading checks passed.")
