from pipeline.retrieve.quiz_grade import (
    build_grade_prompt,
    parse_grade_response,
    snap_award,
)


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
