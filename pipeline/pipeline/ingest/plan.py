"""Validation for the server-owned ingest processing contract."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..jobs import TerminalError

VERSION = 1

STORE_ONLY = "store_only"
RAW_TEXT = "raw_text"
DELIMITED_TEXT = "delimited_text"
IMAGE_CAPTION = "image_caption"
AUDIO_TRANSCRIPTION = "audio_transcription"
DOCUMENT_PARSE = "document_parse"

ROUTES = frozenset(
    {
        STORE_ONLY,
        RAW_TEXT,
        DELIMITED_TEXT,
        IMAGE_CAPTION,
        AUDIO_TRANSCRIPTION,
        DOCUMENT_PARSE,
    }
)
CAPTION_MODES = frozenset({"none", "standalone", "embedded"})

_DOCUMENT_FORMATS = frozenset({"pdf", "docx", "pptx", "xlsx"})
_OFFICE_PREVIEW_FORMATS = frozenset({"docx", "pptx", "xlsx"})
_DELIMITED_FORMATS = frozenset({"csv", "tsv"})
_IMAGE_FORMATS = frozenset(
    {
        "png",
        "jpg",
        "jpeg",
        "jp2",
        "webp",
        "gif",
        "bmp",
        "svg",
        "avif",
        "tif",
        "tiff",
        "heic",
        "heif",
        "ico",
    }
)
_AUDIO_FORMATS = frozenset(
    {"mp3", "wav", "m4a", "ogg", "flac", "aac", "webm", "mp4", "mpeg", "mpga", "opus"}
)
_STORE_ONLY_FORMATS = frozenset({"", "doc", "ppt", "xls"})
_RESERVED_FORMATS = (
    _DOCUMENT_FORMATS
    | _DELIMITED_FORMATS
    | _IMAGE_FORMATS
    | _AUDIO_FORMATS
    | _STORE_ONLY_FORMATS
)


def _server_text_formats() -> frozenset[str]:
    policy_path = (
        Path(__file__).resolve().parents[3]
        / "server"
        / "internal"
        / "sourceupload"
        / "text_extensions.json"
    )
    try:
        value = json.loads(policy_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("server text-format policy could not be loaded") from exc
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item for item in value
    ):
        raise RuntimeError("server text-format policy is invalid")
    return frozenset(value)


_RAW_TEXT_FORMATS = (
    _server_text_formats() | {"md", "markdown", "mdx", "mdc", "json", "map"}
) - _RESERVED_FORMATS

_DIRECT_RESOURCES = ("object_storage_read", "embedding_model", "ingest_model")


def _expected_contract(
    route: str, caption_mode: str, office_preview: bool
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    if route == STORE_ONLY:
        return (), ()
    if route == RAW_TEXT:
        return (
            ("fetch_source", "chunk", "index", "generate_derivatives"),
            _DIRECT_RESOURCES,
        )
    if route == DELIMITED_TEXT:
        return (
            (
                "fetch_source",
                "normalize_delimited",
                "chunk",
                "index",
                "generate_derivatives",
            ),
            _DIRECT_RESOURCES,
        )
    if route == IMAGE_CAPTION:
        return (
            (
                "fetch_source",
                "caption_image",
                "persist_derived_text",
                "chunk",
                "index",
                "generate_derivatives",
            ),
            (*_DIRECT_RESOURCES, "vision_model", "object_storage_write"),
        )
    if route == AUDIO_TRANSCRIPTION:
        return (
            (
                "fetch_source",
                "transcribe_audio",
                "persist_derived_text",
                "chunk",
                "index",
                "generate_derivatives",
            ),
            (*_DIRECT_RESOURCES, "audio_transcription", "object_storage_write"),
        )

    stages = ["fetch_source", "parse_document"]
    resources = [*_DIRECT_RESOURCES, "document_parser", "shared_parse_spool"]
    if office_preview:
        stages.append("persist_office_preview")
        resources.append("object_storage_write")
    if caption_mode == "embedded":
        stages.extend(("caption_images", "persist_captions"))
        resources.append("vision_model")
        if "object_storage_write" not in resources:
            resources.append("object_storage_write")
    stages.extend(("chunk", "index", "generate_derivatives"))
    return tuple(stages), tuple(resources)


@dataclass(frozen=True)
class ProcessingPlan:
    version: int
    format: str
    route: str
    parser_route: str
    caption_mode: str
    office_preview: bool
    stages: tuple[str, ...]
    resources: tuple[str, ...]

    @property
    def caption_embedded_images(self) -> bool:
        return self.caption_mode == "embedded"


def require(value: Any) -> ProcessingPlan:
    """Return a validated contract, rejecting jobs from unknown plan versions."""
    if not isinstance(value, dict):
        raise TerminalError("ingest payload has no processing plan")
    try:
        version = int(value["version"])
        format_name = str(value["format"])
        route = str(value["route"])
        parser_route = str(value.get("parserRoute") or "")
        caption_mode = str(value["captionMode"])
        office_preview = value["officePreview"]
        stages_value = value["stages"]
        resources_value = value["resources"]
    except (KeyError, TypeError, ValueError) as exc:
        raise TerminalError("ingest payload has an invalid processing plan") from exc

    if version != VERSION:
        raise TerminalError(f"unsupported processing plan version {version}")
    if route not in ROUTES or caption_mode not in CAPTION_MODES:
        raise TerminalError("ingest payload has an invalid processing plan")
    if not isinstance(office_preview, bool):
        raise TerminalError("ingest payload has an invalid processing plan")
    if not isinstance(stages_value, list) or not all(
        isinstance(stage, str) and stage for stage in stages_value
    ):
        raise TerminalError("ingest payload has an invalid processing plan")
    if not isinstance(resources_value, list) or not all(
        isinstance(resource, str) and resource for resource in resources_value
    ):
        raise TerminalError("ingest payload has an invalid processing plan")
    if route == DOCUMENT_PARSE and parser_route != "fast":
        raise TerminalError("document processing plan has no supported parser route")
    if route != DOCUMENT_PARSE and parser_route:
        raise TerminalError("direct processing plan unexpectedly selects a parser")
    if office_preview and route != DOCUMENT_PARSE:
        raise TerminalError("Office preview requires document parsing")
    if caption_mode == "embedded" and route != DOCUMENT_PARSE:
        raise TerminalError("embedded captioning requires document parsing")
    if route == IMAGE_CAPTION and caption_mode != "standalone":
        raise TerminalError("image processing requires standalone captioning")
    if caption_mode == "standalone" and route != IMAGE_CAPTION:
        raise TerminalError("standalone captioning requires an image route")

    if route == DOCUMENT_PARSE and format_name not in _DOCUMENT_FORMATS:
        raise TerminalError("document processing plan has an unsupported format")
    if route == DELIMITED_TEXT and format_name not in _DELIMITED_FORMATS:
        raise TerminalError("delimited processing plan has an unsupported format")
    if route == IMAGE_CAPTION and format_name not in _IMAGE_FORMATS:
        raise TerminalError("image processing plan has an unsupported format")
    if route == AUDIO_TRANSCRIPTION and format_name not in _AUDIO_FORMATS:
        raise TerminalError("audio processing plan has an unsupported format")
    if route == STORE_ONLY and format_name not in _STORE_ONLY_FORMATS:
        raise TerminalError("store-only processing plan has an unsupported format")
    if route == RAW_TEXT and format_name not in _RAW_TEXT_FORMATS:
        raise TerminalError("raw-text processing plan has an unsupported format")
    if office_preview != (format_name in _OFFICE_PREVIEW_FORMATS):
        raise TerminalError("processing plan has an invalid Office preview policy")
    expected_stages, expected_resources = _expected_contract(
        route, caption_mode, office_preview
    )
    if tuple(stages_value) != expected_stages:
        raise TerminalError("processing plan stages do not match its route")
    if tuple(resources_value) != expected_resources:
        raise TerminalError("processing plan resources do not match its route")

    return ProcessingPlan(
        version=version,
        format=format_name,
        route=route,
        parser_route=parser_route,
        caption_mode=caption_mode,
        office_preview=office_preview,
        stages=tuple(stages_value),
        resources=tuple(resources_value),
    )
