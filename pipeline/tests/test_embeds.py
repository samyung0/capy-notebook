"""The pipeline against the embed catalog (openwiki/embeds.md)."""

from pipeline.retrieval import contract, embeds


def test_media_schemas_are_the_catalog_question_media() -> None:
    media = {k for k, e in embeds.EMBEDS.items() if e.get("questionMedia")}
    assert set(contract.MEDIA_BLOCKS) == media


def test_the_note_format_describes_every_kind_the_agent_writes_in_notes() -> None:
    note = contract.FORMATS["note"]
    for kind, embed in embeds.EMBEDS.items():
        if {"create_material", "edit_document"} & set(embed["edit"]["agent"]):
            assert f"```{embed['fence']['lang']}" in note, kind
