"""Note passages rank in the same pool as file passages and cite the note."""

from pipeline.retrieval.chunking import NOTE_BLOCK_SPACE, Chunk, chunk_markdown
from pipeline.retrieval.indexing import note_block_regions
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


def _block_ids(chunks: list[Chunk], blocks: list[dict]) -> list[list[str]]:
    return [
        [region["blockId"] for region in regions]
        for regions in note_block_regions(chunks, blocks)
    ]


def test_each_chunk_keeps_the_blocks_it_came_from():
    blocks = [
        {"id": "h", "text": "# Cells"},
        {"id": "a", "text": "Mitochondria produce ATP."},
        {"id": "b", "text": "- Membrane\n- Nucleus"},
        {"id": "h2", "text": "# Energy"},
        {"id": "c", "text": "Glycolysis splits glucose."},
    ]
    chunks = chunk_markdown("\n\n".join(block["text"] for block in blocks))
    assert _block_ids(chunks, blocks) == [["a", "b"], ["c"]]


def test_chunks_of_one_long_block_all_cite_it():
    text = " ".join(f"Sentence {n} about the cell membrane." for n in range(400))
    blocks = [{"id": "long", "text": text}]
    chunks = chunk_markdown(text)
    assert len(chunks) > 1
    assert _block_ids(chunks, blocks) == [["long"]] * len(chunks)


def test_note_passage_cites_its_blocks():
    row = _row("material", "mat_1", 0)
    row["regions"] = [
        {"blockId": "b1", "space": NOTE_BLOCK_SPACE},
        {"blockId": "b2", "space": NOTE_BLOCK_SPACE},
    ]
    citation = Passage.from_row(row).as_citation()
    assert citation["blockIds"] == ["b1", "b2"]
    assert "regions" not in citation


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
