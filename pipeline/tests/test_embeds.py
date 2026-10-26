"""The pipeline against the embed catalog (openwiki/embeds.md)."""

from pipeline.retrieval import contract, embeds


def test_media_schemas_are_the_catalog_question_media() -> None:
    media = {k for k, e in embeds.EMBEDS.items() if e.get("questionMedia")}
    assert set(contract.MEDIA_BLOCKS) == media


def test_the_note_format_describes_every_kind_the_agent_writes_in_notes() -> None:
    note = contract.FORMATS["note"]
    edit = contract.definition("edit_document")["description"]
    for kind, embed in embeds.EMBEDS.items():
        fence = f"```{embed['fence']['lang']}"
        if "create_material" in embed["edit"]["agent"]:
            assert fence in note, kind
        elif "edit_document" in embed["edit"]["agent"]:
            # Rewritten only where a learner added it, as edit_document says
            # (Mermaid, Epo 2026-10-25).
            assert fence in edit and fence not in note, kind
