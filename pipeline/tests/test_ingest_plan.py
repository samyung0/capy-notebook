from __future__ import annotations

import pytest

from pipeline.ingest import plan
from pipeline.jobs import TerminalError


def _value(**overrides):
    value = {
        "version": 1,
        "format": "pdf",
        "route": "document_parse",
        "parserRoute": "fast",
        "captionMode": "embedded",
        "officePreview": False,
        "stages": [
            "fetch_source",
            "parse_document",
            "caption_images",
            "persist_captions",
            "chunk",
            "index",
            "generate_derivatives",
        ],
        "resources": [
            "object_storage_read",
            "embedding_model",
            "ingest_model",
            "document_parser",
            "shared_parse_spool",
            "vision_model",
            "object_storage_write",
        ],
    }
    value.update(overrides)
    return value


def test_validates_the_versioned_server_contract() -> None:
    processing_plan = plan.require(_value())

    assert processing_plan.route == plan.DOCUMENT_PARSE
    assert processing_plan.parser_route == "fast"
    assert processing_plan.caption_embedded_images is True


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        _value(version=2),
        _value(route="spreadsheet_magic"),
        _value(route="raw_text", parserRoute="fast"),
        _value(route="raw_text", parserRoute="", captionMode="none"),
        _value(format="csv", route="raw_text", parserRoute="", captionMode="none"),
        _value(format="zip", route="raw_text", parserRoute="", captionMode="none"),
        _value(
            format="pdf",
            route="image_caption",
            parserRoute="",
            captionMode="standalone",
        ),
        _value(format="docx", officePreview=False),
        _value(format="pdf", officePreview=True),
        _value(route="image_caption", parserRoute="", captionMode="embedded"),
        _value(route="image_caption", parserRoute="", captionMode="none"),
        _value(route="raw_text", parserRoute="", officePreview=True),
        _value(stages="fetch_source"),
        _value(stages=["fetch_source", "parse_document"]),
        _value(resources=["document_parser"]),
    ],
)
def test_rejects_unknown_or_internally_inconsistent_contracts(value) -> None:
    with pytest.raises(TerminalError):
        plan.require(value)
