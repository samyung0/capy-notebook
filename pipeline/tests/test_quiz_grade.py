import json
from pathlib import Path

from pipeline.prompts.quiz import GRADE_SYSTEM, build_grade_prompt
from pipeline.retrieve.quiz_grade import parse_grade_response, snap_award


def test_build_grade_prompt_includes_rubrics_and_both_answers():
    prompt = build_grade_prompt(
        prompt="Why is the inner membrane folded?",
        hints=["Think about surface area"],
        rubrics=["Mentions folds or cristae", "Links folds to ATP"],
        model_answer="Cristae increase surface area for ATP synthesis.",
        user_answer="The folds give more space to make ATP.",
    )
    assert "Why is the inner membrane folded?" in prompt
    assert "Mentions folds or cristae" in prompt
    assert "The folds give more space to make ATP." in prompt
    assert "Cristae increase surface area" in prompt


def test_parse_grade_response_snaps_scores():
    assert parse_grade_response('{"score":1,"reason":"all rubrics"}') == {
        "award": 1,
        "reason": "all rubrics",
    }
    assert parse_grade_response('Here\n{"score":0.5,"reason":"partial"}\n') == {
        "award": 0.5,
        "reason": "partial",
    }
    assert parse_grade_response("no json") == {
        "award": 0,
        "reason": "The judge did not return a score.",
    }
    assert snap_award(0.8) == 1
    assert snap_award(0.4) == 0.5
    assert snap_award(0.1) == 0


def test_grade_prompt_matches_the_golden_shared_with_the_browser_judge():
    """The browser BYOK path builds this prompt in TypeScript.

    ``src/features/quizzes/judge.test.ts`` asserts the same file, so a change to
    either implementation that is not made to both fails here.
    """
    golden = json.loads(
        (
            Path(__file__).parents[1] / "pipeline/prompts/quiz_grade.golden.json"
        ).read_text()
    )
    assert GRADE_SYSTEM == golden["system"]
    for case in golden["cases"]:
        given = case["input"]
        assert (
            build_grade_prompt(
                prompt=given["prompt"],
                hints=given["hints"],
                rubrics=given["rubrics"],
                model_answer=given["modelAnswer"],
                user_answer=given["userAnswer"],
            )
            == case["expected"]
        ), case["name"]
