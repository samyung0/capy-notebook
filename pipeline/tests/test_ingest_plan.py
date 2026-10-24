from __future__ import annotations

import pytest

from pipeline.ingest import plan
from pipeline.jobs import TerminalError


def _value(**overrides):
    value = {
        "version": 2,
        "format": "pdf",
        "route": "document_parse",
        "parserRoute": "fast",
        "captionMode": "none",
        "office": False,
        "stages": [
            "fetch_source",
            "parse_document",
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
        ],
    }
    value.update(overrides)
    return value


def test_validates_the_versioned_server_contract() -> None:
    processing_plan = plan.require(_value())

    assert processing_plan.route == plan.DOCUMENT_PARSE
    assert processing_plan.parser_route == "fast"
    assert processing_plan.caption_mode == "none"


@pytest.mark.parametrize(
    "value",
    [
        None,
        {},
        _value(version=3),
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
        _value(format="docx", office=False),
        _value(format="pdf", office=True),
        # Embedded figure captioning was retired with the MinerU parser.
        _value(captionMode="embedded"),
        _value(route="image_caption", parserRoute="", captionMode="none"),
        _value(route="raw_text", parserRoute="", office=True),
        _value(stages="fetch_source"),
        _value(stages=["fetch_source", "parse_document"]),
        _value(resources=["document_parser"]),
    ],
)
def test_rejects_unknown_or_internally_inconsistent_contracts(value) -> None:
    with pytest.raises(TerminalError):
        plan.require(value)


_AUDIO = {
    "route": "audio_transcription",
    "parserRoute": "",
    "stages": [
        "fetch_source",
        "transcribe_audio",
        "persist_derived_text",
        "chunk",
        "index",
        "generate_derivatives",
    ],
    "resources": [
        "object_storage_read",
        "embedding_model",
        "ingest_model",
        "audio_transcription",
        "object_storage_write",
    ],
}


@pytest.mark.parametrize("format_name", ["mp3", "m4a", "webm", "opus"])
def test_audio_is_transcribed(format_name) -> None:
    assert plan.require(_value(format=format_name, **_AUDIO)).route == (
        plan.AUDIO_TRANSCRIPTION
    )


@pytest.mark.parametrize(
    "value",
    [
        _value(format="pdf", **_AUDIO),
        _value(
            format="mp3", route="store_only", parserRoute="", stages=[], resources=[]
        ),
    ],
)
def test_audio_takes_only_the_audio_route(value) -> None:
    with pytest.raises(TerminalError):
        plan.require(value)
