import copy
import hashlib
import json

import enrich
import pytest
from packet import build_packet


def sha(value):
    return hashlib.sha256(value).hexdigest()


@pytest.fixture
def repair_run(tmp_path):
    def save(name, data):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")
        return path

    source = tmp_path / "source.pdf"
    source.write_bytes(b"synthetic source binding")
    page = tmp_path / "page-1.png"
    page.write_bytes(b"synthetic page binding")
    book = {
        "id": "book",
        "title": "Repair example",
        "sha256": sha(source.read_bytes()),
        "pages": 2,
    }
    old, new = (
        "The formula uses a 1 b for division.",
        "The formula uses a / b for division.",
    )
    chunks, excerpts, tags = [], [], {}
    for n, text in enumerate(
        [old, "This unchanged passage supplies additional context."], 1
    ):
        eid, cid = f"e{n}", f"c{n}"
        region = {"page": n, "bbox": [0, 0, 100, 100]}
        chunks.append(
            {
                "id": cid,
                "excerpt_id": eid,
                "chunk_idx": n - 1,
                "text": text,
                "indexed_text": text,
                "section_path": "",
                "page_start": n,
                "page_end": n,
                "regions": [region],
                "reference": False,
                "confidence": 1.0,
                "confidence_reasons": [],
            }
        )
        excerpts.append(
            {
                "id": eid,
                "text": text,
                "chunk_ids": [cid],
                "section_path": "",
                "pages": [n],
                "regions": [region],
                "figure_ids": [],
            }
        )
        tags[eid] = {
            "roles": ["formal"],
            "topic_ids": ["division"],
            "confidence": 0.99,
            "synopsis": "Full source notes to retain.",
            "evidence": text,
            "proposed_topic": None,
            "retrieval": {
                "summary": "Explains notation.",
                "scope": "A source example.",
                "context_excerpt_ids": [],
            },
        }
    corpus = {
        "book": book,
        "chunks": chunks,
        "excerpts": excerpts,
        "figures": [],
        "content_hash": "before",
    }
    cp = save("books/book/corpus.json", corpus)
    tp = save(
        "tags.json",
        {
            "tags": tags,
            "topics": [{"id": "division"}],
            "failed_tags": {},
            "review_items": [],
        },
    )
    save("manifest.json", {"books": [book]})
    catalog = save("catalog.json", [{"id": "division"}])
    baseline = save("original-notes.json", {"tags": copy.deepcopy(tags)})
    save("reviewed-notes.json", {"tags": copy.deepcopy(tags)})
    artifact = {
        "book_id": "book",
        "source_sha256": book["sha256"],
        "source_pdf_path": str(source),
        "base_tags_sha256": sha(tp.read_bytes()),
        "base_corpus_sha256": sha(cp.read_bytes()),
        "model_provenance": {"model": "gpt-5.6-sol"},
        "reviewed_excerpt_ids": ["e1"],
        "tags": {"e1": {**tags["e1"], "evidence": new}},
        "inspection_records": [
            {
                "pdf_page": 1,
                "rendered_page_path": str(page),
                "rendered_page_sha256": sha(page.read_bytes()),
                "observation": "The source shows a division slash.",
            }
        ],
        "source_repairs": [
            {
                "excerpt_id": "e1",
                "chunk_id": "c1",
                "original_text_sha256": sha(old.encode()),
                "text": new,
                "kind": "transcription",
                "reason": "Recover the printed slash.",
                "pdf_pages": [1],
            }
        ],
    }
    artifact["repair_assessment"] = [
        {
            "excerpt_ids": ["e1"],
            "status": "repaired",
            "pdf_pages": [1],
            "reason": "Recovered the printed division slash.",
        }
    ]
    return tmp_path, corpus, artifact, new, baseline, catalog


def test_repair_updates_retrieved_and_indexed_source_preserving_originals(
    repair_run, monkeypatch
):
    run, original, artifact, new, baseline, catalog = repair_run
    cp = run / "books/book/corpus.json"
    before = cp.read_bytes()
    projected = enrich.repaired_corpus(original, artifact, sha(before))
    assert original["excerpts"][0]["text"] != new
    assert projected["chunks"][0]["text"] == projected["excerpts"][0]["text"] == new
    assert projected["chunks"][0]["indexed_text"] == new
    assert projected["content_hash"] != original["content_hash"]
    assert projected["excerpts"][1] == original["excerpts"][1]
    expected, receipt = enrich.validate(run, artifact)
    assert receipt["source_repairs"] == 1 and not expected["review_items"]
    assert cp.read_bytes() == before
    review = run / "review.json"
    review.write_text(json.dumps(artifact), encoding="utf-8")
    packet = build_packet(
        run=run,
        review=review,
        catalog=catalog,
        case_id="repair",
        baseline_notes=baseline,
        baseline_sha256=sha(baseline.read_bytes()),
    )
    assert packet["source"]["excerpts"][0]["text"] == new
    assert packet["full_reviewed_notes"]["e1"] == "Full source notes to retain."
    monkeypatch.setattr(
        "sys.argv", ["enrich", "--run", str(run), "--artifact", str(review), "--apply"]
    )
    enrich.main()
    backup = run / "retrieval-review-backups" / sha(review.read_bytes())
    assert (backup / "corpus.json").read_bytes() == before
    assert json.loads(cp.read_bytes()) == projected
    assert json.loads((run / "tags.json").read_bytes()) == expected
    assert (
        json.loads((run / "reviewed-notes.json").read_bytes())["tags"]["e1"]["evidence"]
        == new
    )


@pytest.mark.parametrize(
    "defect",
    [
        "stale_corpus",
        "stale_text",
        "wrong_chunk",
        "duplicate_chunk",
        "unrelated_page",
        "missing_capture",
        "changed_capture",
        "wrong_source",
        "no_op",
    ],
)
def test_repair_rejects_stale_or_unbound_changes(repair_run, defect):
    run, corpus, original, _, _, _ = repair_run
    artifact = copy.deepcopy(original)
    repair = artifact["source_repairs"][0]
    if defect == "stale_corpus":
        artifact["base_corpus_sha256"] = "stale"
    if defect == "stale_text":
        repair["original_text_sha256"] = "stale"
    if defect == "wrong_chunk":
        repair["chunk_id"] = "c2"
    if defect == "duplicate_chunk":
        artifact["source_repairs"].append(copy.deepcopy(repair))
    if defect == "unrelated_page":
        artifact["inspection_records"][0]["pdf_page"] = 2
    if defect == "missing_capture":
        artifact["inspection_records"][0]["rendered_page_path"] = "missing.png"
    if defect == "changed_capture":
        artifact["inspection_records"][0]["rendered_page_sha256"] = "stale"
    if defect == "wrong_source":
        artifact["source_sha256"] = "stale"
    if defect == "no_op":
        repair["text"] = corpus["chunks"][0]["text"]
    with pytest.raises(ValueError):
        enrich.validate(run, artifact)


def test_scoped_packet_uses_repaired_linked_context(repair_run):
    run, corpus, artifact, new, baseline, catalog = repair_run
    full = run / "full-review.json"
    full.write_text(json.dumps(artifact), encoding="utf-8")
    tags = json.loads((run / "tags.json").read_bytes())["tags"]
    tags["e2"]["retrieval"]["context_excerpt_ids"] = ["e1"]
    scoped = {"source_sha256": corpus["book"]["sha256"], "tags": {"e2": tags["e2"]}}
    review = run / "scope.json"
    review.write_text(json.dumps(scoped), encoding="utf-8")
    packet = build_packet(
        run=run,
        review=review,
        catalog=catalog,
        case_id="linked",
        baseline_notes=baseline,
        baseline_sha256=sha(baseline.read_bytes()),
        source_review=full,
    )
    assert packet["assignment"]["target_ids"] == ["e2"]
    assert packet["source"]["excerpts"][0]["text"] == new
    assert "source_review" in packet["provenance"]["bindings"]
    provenance = packet["provenance"]["source_repair"]
    assert provenance["corrections"][0]["excerpt_id"] == "e1"
    assert provenance["assessments"] == artifact["repair_assessment"]
    assert provenance["inspection_records"] == artifact["inspection_records"]


def test_repair_assessment_must_cover_repairs_and_prior_issues(repair_run):
    run, corpus, original, _, _, _ = repair_run
    artifact = copy.deepcopy(original)
    del artifact["repair_assessment"]
    with pytest.raises(ValueError, match="repair_assessment"):
        enrich.validate(run, artifact)
    artifact["repair_assessment"] = []
    with pytest.raises(ValueError, match="incomplete"):
        enrich.validate(run, artifact)
    with pytest.raises(ValueError, match="incomplete"):
        enrich.assessment_ids(original, corpus, required={"e2"})


def test_interrupted_apply_resumes_only_its_saved_states(repair_run, monkeypatch):
    run, _, artifact, new, _, _ = repair_run
    review = run / "review.json"
    review.write_text(json.dumps(artifact), encoding="utf-8")
    monkeypatch.setattr(
        "sys.argv", ["enrich", "--run", str(run), "--artifact", str(review), "--apply"]
    )
    real_replace = type(run).replace

    def interrupted(path, target):
        if target == run / "tags.json":
            raise OSError("simulated interrupted tags write")
        return real_replace(path, target)

    monkeypatch.setattr(type(run), "replace", interrupted)
    with pytest.raises(OSError):
        enrich.main()
    assert enrich.load(run / "books/book/corpus.json")["chunks"][0]["text"] == new
    assert enrich.load(run / "tags.json")["tags"]["e1"]["evidence"] != new
    monkeypatch.setattr(type(run), "replace", real_replace)
    saved_tags = (run / "tags.json").read_bytes()
    (run / "tags.json").write_text("unexpected external change", encoding="utf-8")
    old_notes = (run / "reviewed-notes.json").read_bytes()
    with pytest.raises(ValueError, match="outside the saved plan"):
        enrich.resume_apply(run, review)
    assert (run / "reviewed-notes.json").read_bytes() == old_notes
    (run / "tags.json").write_bytes(saved_tags)
    enrich.resume_apply(run, review)
    expected_notes = (run / "reviewed-notes.json").read_bytes()
    assert enrich.load(run / "tags.json")["tags"]["e1"]["evidence"] == new
    enrich.resume_apply(run, review)
    assert (run / "reviewed-notes.json").read_bytes() == expected_notes


def test_disposition_only_source_review_still_needs_source_bindings(repair_run):
    run, corpus, artifact, _, baseline, catalog = repair_run
    artifact["source_repairs"] = []
    artifact["repair_assessment"][0]["status"] = "no_repair_needed"
    assert (
        enrich.repaired_corpus(corpus, artifact, artifact["base_corpus_sha256"])
        is corpus
    )
    for key, value in [
        ("book_id", "another"),
        ("source_sha256", "stale"),
        ("base_corpus_sha256", "stale"),
        ("model_provenance", None),
    ]:
        invalid = {**artifact, key: value}
        with pytest.raises(ValueError):
            enrich.repaired_corpus(corpus, invalid, artifact["base_corpus_sha256"])
    full = run / "full-review.json"
    del artifact["source_repairs"]
    full.write_text(json.dumps(artifact), encoding="utf-8")
    review = run / "review.json"
    review.write_text(
        json.dumps(
            {"source_sha256": corpus["book"]["sha256"], "tags": artifact["tags"]}
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="explicitly declare"):
        build_packet(
            run=run,
            review=review,
            catalog=catalog,
            case_id="empty",
            baseline_notes=baseline,
            baseline_sha256=sha(baseline.read_bytes()),
            source_review=full,
        )


def bind_page(run, artifact, page):
    image = run / f"page-{page}.png"
    image.write_bytes(f"synthetic page {page}".encode())
    artifact["inspection_records"].append(
        {
            "pdf_page": page,
            "rendered_page_path": str(image),
            "rendered_page_sha256": sha(image.read_bytes()),
            "observation": f"Page {page} prints the section heading.",
        }
    )


def path_only(artifact, corpus, path="1 Notation › 1.1 Division"):
    """Turn the fixture's text repair into a locator-only correction of c1."""
    repair = artifact["source_repairs"][0]
    del repair["text"]
    repair.update(kind="section_path", section_path=path)
    artifact["tags"]["e1"]["evidence"] = corpus["chunks"][0]["text"]
    return repair


def test_section_path_repair_moves_only_the_locator(repair_run):
    from transcribe import refresh

    run, corpus, artifact, _, _, _ = repair_run
    path = "1 Notation › 1.1 Division"
    bind_page(run, artifact, 2)  # a contents page outside the chunk
    path_only(artifact, corpus, path)["pdf_pages"] = [2]
    before = (run / "books/book/corpus.json").read_bytes()
    projected = enrich.repaired_corpus(corpus, artifact, sha(before))
    chunk, excerpt = projected["chunks"][0], projected["excerpts"][0]
    assert chunk["text"] == corpus["chunks"][0]["text"]
    assert chunk["section_path"] == excerpt["section_path"] == path
    assert (excerpt["id"], excerpt["chunk_ids"]) == ("e1", ["c1"])
    assert chunk["indexed_text"] == f"{path}\n\n{chunk['text']}"
    assert chunk["source_repairs"][0]["original_section_path"] == ""
    unchanged = copy.deepcopy(corpus)
    refresh(unchanged)
    assert projected["content_hash"] != unchanged["content_hash"]
    assert projected["excerpts"][1] == corpus["excerpts"][1]
    enrich.validate(run, artifact)


def test_one_repair_fixes_text_and_path_together(repair_run):
    run, corpus, artifact, new, _, _ = repair_run
    bind_page(run, artifact, 2)
    repair = artifact["source_repairs"][0]
    repair.update(section_path="1 Notation", pdf_pages=[1, 2])
    projected = enrich.repaired_corpus(corpus, artifact, artifact["base_corpus_sha256"])
    chunk, excerpt = projected["chunks"][0], projected["excerpts"][0]
    assert (chunk["text"], chunk["section_path"]) == (new, "1 Notation")
    assert (excerpt["text"], excerpt["section_path"]) == (new, "1 Notation")
    repair["pdf_pages"] = [2]  # the text change still needs its own chunk's page
    with pytest.raises(ValueError, match="outside its chunk"):
        enrich.repaired_corpus(corpus, artifact, artifact["base_corpus_sha256"])


@pytest.mark.parametrize("defect", ["no_op", "unbound_page", "changed_text"])
def test_section_path_repair_rejects_no_op_unbound_or_text_change(repair_run, defect):
    _, corpus, artifact, _, _, _ = repair_run
    repair = path_only(artifact, corpus)
    if defect == "no_op":
        repair["section_path"] = corpus["chunks"][0]["section_path"]
    if defect == "unbound_page":
        repair["pdf_pages"] = [2]
    if defect == "changed_text":
        repair["text"] = "A different passage."
    with pytest.raises(ValueError, match="no-op|inspection"):
        enrich.repaired_corpus(corpus, artifact, artifact["base_corpus_sha256"])


def test_follow_up_apply_binds_the_already_repaired_corpus(repair_run, monkeypatch):
    run, _, artifact, new, _, _ = repair_run
    corpus_path, backups = (
        run / "books/book/corpus.json",
        run / "retrieval-review-backups",
    )

    def apply(path, *stage):
        monkeypatch.setattr(
            "sys.argv",
            ["enrich", "--run", str(run), "--artifact", str(path), "--apply", *stage],
        )
        enrich.main()

    first = run / "review.json"
    first.write_text(json.dumps(artifact), encoding="utf-8")
    apply(first)
    repaired = corpus_path.read_bytes()
    follow = copy.deepcopy(artifact)
    follow.update(
        base_corpus_sha256=sha(repaired),
        base_tags_sha256=sha((run / "tags.json").read_bytes()),
    )
    repair = follow["source_repairs"][0]
    del repair["text"]
    repair.update(
        kind="section_path",
        section_path="1 Notation",
        original_text_sha256=sha(new.encode()),
    )
    second = run / "follow-up.json"
    second.write_text(json.dumps(follow), encoding="utf-8")
    with pytest.raises(ValueError, match="corpus changed"):
        enrich.validate(run, copy.deepcopy(artifact))
    apply(second, "--stage", "source-cleanup")  # the review's receipt stays
    states = {
        d: enrich.load(run / "models" / d / "state.json")
        for d in ("retrieval-review", "source-cleanup")
    }
    assert states["retrieval-review"]["artifact_sha256"] == sha(first.read_bytes())
    assert states["source-cleanup"]["artifact_sha256"] == sha(second.read_bytes())
    chunk = enrich.load(corpus_path)["chunks"][0]
    assert (chunk["text"], chunk["section_path"]) == (new, "1 Notation")
    assert [r["kind"] for r in chunk["source_repairs"]] == [
        "transcription",
        "section_path",
    ]
    assert {p.name for p in backups.iterdir()} == {
        sha(first.read_bytes()),
        sha(second.read_bytes()),
    }
    assert (backups / sha(second.read_bytes()) / "corpus.json").read_bytes() == repaired
    applied = corpus_path.read_bytes()
    enrich.resume_apply(run, second)
    assert corpus_path.read_bytes() == applied


def test_topic_context_accepts_only_a_validated_path_correction(
    repair_run, monkeypatch
):
    import topics

    run, corpus, artifact, _, _, _ = repair_run
    book = {**corpus["book"], "subject_id": "statistics", "edition": "1"}
    (run / "manifest.json").write_text(json.dumps({"books": [book]}), encoding="utf-8")
    bind_page(run, artifact, 2)
    artifact["source_repairs"][0]["section_path"] = "1 Notation"
    artifact["source_repairs"][0]["pdf_pages"] = [1, 2]
    projected = enrich.repaired_corpus(corpus, artifact, artifact["base_corpus_sha256"])
    full_tags = {**enrich.load(run / "tags.json")["tags"], **artifact["tags"]}
    full = {**artifact, "tags": full_tags, "corrected_excerpts": projected["excerpts"]}
    review, context = run / "full-review.json", run / "context.json"
    review.write_text(json.dumps(full), encoding="utf-8")
    monkeypatch.setattr(topics, "library_topics", lambda subject: [])
    monkeypatch.setattr(
        "sys.argv",
        [
            "topics.py",
            *("--run", str(run), "--book", "book"),
            *("--review-context", str(review), "--export-context", str(context)),
        ],
    )
    topics.main()
    exported = enrich.load(context)
    assert exported["reviewed_excerpts"][0]["section_path"] == "1 Notation"
    del full["source_repairs"][0]["section_path"]  # the same path, unrepaired
    review.write_text(json.dumps(full), encoding="utf-8")
    with pytest.raises(ValueError, match="boundary"):
        topics.main()


def test_path_form_is_the_chunkers_breadcrumb():
    assert enrich.path_form("") and enrich.path_form("1 Notation › 1.1 Division")
    for path in (
        "1 Notation › › 1.1",
        "1 Notation ›  1.1",
        "1 Notation\n1.1",
        "›",
        None,
    ):
        assert not enrich.path_form(path), path


def test_refresh_figures_refuses_a_repaired_book(repair_run):
    import knowledge_base_pilot as pilot

    run, corpus, artifact, _, _, _ = repair_run
    book = {**corpus["book"], "edition": "1", "source_url": "https://b.test"}
    book["license"] = "CC BY 4.0"
    (run / "manifest.json").write_text(json.dumps({"books": [book]}), encoding="utf-8")
    repaired = enrich.repaired_corpus(corpus, artifact, artifact["base_corpus_sha256"])
    repaired["source_id"] = pilot.book_identity(book)
    path = run / "books/book/corpus.json"
    path.write_text(json.dumps(repaired), encoding="utf-8")
    before = path.read_bytes()
    with pytest.raises(pilot.PilotError, match="source repairs"):
        pilot.refresh_figures({"books": [book]}, run)
    assert path.read_bytes() == before


def test_older_codex_provenance_names_its_model(repair_run, monkeypatch):
    run, _, artifact, _, _, _ = repair_run
    artifact["model_provenance"] = {"transport": "codex-subagent"}
    with pytest.raises(ValueError, match="naming the model"):
        enrich.validate(run, copy.deepcopy(artifact))
    artifact["model_provenance"] = {"requested_model": "gpt-6-sol"}
    enrich.validate(run, copy.deepcopy(artifact))
    runtime = {"requested_model": "gpt-6-sol", "actual_runtime_model": "unknown"}
    assert enrich.model_name(runtime) == "unknown"
    review = run / "review.json"
    review.write_text(json.dumps(artifact), encoding="utf-8")
    monkeypatch.setattr(
        "sys.argv",
        ["enrich", "--run", str(run), "--artifact", str(review), "--apply"],
    )
    enrich.main()
    state = enrich.load(run / "models/retrieval-review/state.json")
    assert state["model"] == "gpt-6-sol"
