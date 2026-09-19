"""Note passages rank in the same pool as file passages and cite the note."""

from pipeline.retrieval.search import Passage, _cap_per_file


def _row(kind: str, resource: str, idx: int) -> dict:
    return {
        "id": f"chk_{resource}_{idx}",
        "file_id": resource,
        "file_name": "Lecture notes" if kind == "material" else "textbook.pdf",
        "kind": kind,
        "chunk_idx": idx,
        "section_path": "Cells",
        "text": "Mitochondria produce ATP.",
        "score": 1.0,
    }


def test_note_passage_cites_the_material_not_a_file():
    passage = Passage.from_row(_row("material", "mat_1", 0))
    citation = passage.as_citation()
    assert citation["kind"] == "material"
    assert citation["materialId"] == "mat_1"
    assert citation["fileId"] == ""
    assert citation["fileName"] == "Lecture notes"
    assert "pageStart" not in citation
    assert passage.location() == "Lecture notes › Cells"


def test_file_passage_keeps_its_shape():
    citation = Passage.from_row(_row("file", "f_1", 0)).as_citation()
    assert citation["fileId"] == "f_1"
    assert "kind" not in citation and "materialId" not in citation


def test_per_resource_cap_counts_a_note_like_a_file():
    passages = [Passage.from_row(_row("material", "mat_1", i)) for i in range(4)]
    passages.append(Passage.from_row(_row("file", "f_1", 0)))
    capped = _cap_per_file(passages, 2)
    assert [p.chunk_id for p in capped[:3]] == [
        "chk_mat_1_0",
        "chk_mat_1_1",
        "chk_f_1_0",
    ]
