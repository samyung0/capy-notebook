"""One offline check for explicit headers, bounded units and failed structure."""

import json

from bench_java_recovery import scan_recovery_reasons
from structured_recovery import (
    chunk_structured,
    drop_exact_recovered_text,
    estimate_tokens,
    repair_encoded_text,
    structured_response,
)


def main() -> None:
    rows = "".join(
        f"<tr><td>model-{i}</td><td>{i}.25</td><td>{i}.75</td></tr>" for i in range(80)
    )
    table = {
        "type": "table",
        "page_idx": 2,
        "bbox": [10, 20, 800, 900],
        "table_caption": ["Scores"],
        "table_body": '<table><thead><tr><th rowspan="2">Model</th><th colspan="2">Accuracy</th></tr><tr><th>English</th><th>Japanese</th></tr></thead><tbody>'
        + rows
        + "</tbody></table>",
    }
    chunks = chunk_structured([table])
    assert len(chunks) > 1
    for i in range(80):
        hits = [c for c in chunks if f"model-{i} | {i}.25 | {i}.75" in c.text]
        assert len(hits) == 1
        assert "Model | Accuracy / English | Accuracy / Japanese" in hits[0].text
        assert hits[0].page_start == hits[0].page_end == 3
        assert hits[0].regions[0].bbox == table["bbox"]
    assert all(estimate_tokens(c.text) <= 400 for c in chunks)
    long_table = {
        **table,
        "table_body": "<table><tr><th>Key</th><th>Description</th></tr><tr><td>A</td><td>"
        + "long word " * 220
        + "END-SENTINEL</td></tr></table>",
    }
    long_chunks = chunk_structured([long_table])
    assert len(long_chunks) > 1
    assert all(
        c.text.count("Key | Description") == 1 and estimate_tokens(c.text) <= 400
        for c in long_chunks
    )
    body = "".join(c.text.split("Key | Description", 1)[1] for c in long_chunks)
    assert "".join(body.split()) == "".join(
        ("A | " + "long word " * 220 + "END-SENTINEL").split()
    )
    context = "Previous unrelated material. " * 52
    relationship = "CCNET trained for 100k and 500k steps differs by 0.84 NLI points while tagging and parsing stagnate."
    figure = {
        "type": "image",
        "page_idx": 0,
        "bbox": [0, 0, 1000, 1000],
        "description": context + "\n\n" + relationship,
    }
    assert any(relationship in c.text for c in chunk_structured([figure]))
    job = {"id": "test", "page": 0, "bbox": [0, 0, 1000, 1000], "image": "test.png"}
    merged = {
        "type": "table",
        "title": "Test statistic",
        "headers": ["Measure", "Treatment A", "Treatment B"],
        "rows": [["calculated t", "5.96", ""]],
        "spans": [{"row": 0, "column": 1, "rowspan": 1, "colspan": 2}],
        "metadata": ["n=20 across both treatments"],
    }
    recovered = structured_response(json.dumps({"blocks": [merged]}), job)
    assert 'colspan="2">5.96</td>' in recovered[0]["table_body"]
    merged_chunks = chunk_structured(recovered)
    assert "one merged source cell" in merged_chunks[0].text
    assert "Treatment A; Treatment B" in merged_chunks[0].text
    assert "n=20" in "\n".join(c.text for c in merged_chunks)
    for bad in [
        {**merged, "rows": [["calculated t", " ", ""]]},
        {**merged, "rows": [["calculated t", "5.96", "7.1"]]},
        {**merged, "spans": [{"row": 0, "column": 1, "rowspan": 2, "colspan": 2}]},
        {**merged, "spans": merged["spans"] * 2},
        {**merged, "spans": None},
    ]:
        try:
            structured_response(json.dumps({"blocks": [bad]}), job)
        except ValueError:
            pass
        else:
            raise AssertionError("ambiguous merged cells were accepted")
    try:
        structured_response(
            '{"blocks":[{"type":"table","title":"","headers":["a","b"],"rows":[["one"]]}]}',
            job,
        )
    except ValueError:
        pass
    else:
        raise AssertionError("a shifted row was accepted")
    source = [{"type": "text", "page_idx": 0, "text": "⽅方法，人人，另頁⾏行"}]
    count = repair_encoded_text(
        source, {"pages": [{"page": 0, "zero_width_duplicate_glyphs": ["⽅方"]}]}
    )
    assert count == 1 and source[0]["text"] == "方法，人人，另頁⾏行"
    duplicate = {
        "type": "text",
        "text": source[0]["text"],
        "page_idx": 0,
        "_recovery": "structured-page",
    }
    kept = [*source, duplicate, {**duplicate, "page_idx": 1}]
    assert drop_exact_recovered_text(kept)["blocks"] == 1 and len(kept) == 2
    contextual = [
        {"type": "text", "text_level": 2, "text": "Unrelated end-of-page section"},
        {**duplicate, "bbox": [0, 0, 1000, 1000]},
    ]
    assert not chunk_structured(contextual)[0].section_path
    heading = {
        "type": "image",
        "description": "Earlier material. " * 80
        + "\n\n5 Experiment\n\n5.1 Purpose\n"
        + "Following discussion. " * 110,
    }
    assert any(
        "5 Experiment" in c.text and "5.1 Purpose" in c.text
        for c in chunk_structured([heading])
    )
    wide = {"box": [[0, 0], [900, 0], [900, 30], [0, 30]], "text": "( )", "score": 0.6}
    assert scan_recovery_reasons(
        {"state": "ok", "size": [1000, 1500], "lines": [wide]}
    ) == ["ocr_empty_line"]
    narrow = {**wide, "box": [[0, 0], [20, 0], [20, 30], [0, 30]]}
    assert (
        scan_recovery_reasons({"state": "ok", "size": [1000, 1500], "lines": [narrow]})
        == []
    )
    print("structured recovery check passed")


if __name__ == "__main__":
    main()
