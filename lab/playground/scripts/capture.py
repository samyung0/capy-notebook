"""capture_page: render a source page, or a box on it, on demand inside the agent loop.

Return modes, chosen per config:
- pixels   the JPEG is attached to the conversation for a vision-capable chat model
- ocr      Qwen3.5-OCR transcribes the crop; the text becomes a citable passage
- caption  the captioning model describes the crop (optionally aware of the question)
"""

from __future__ import annotations

import base64
import io
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from common import LOCAL, REPO, PdfResolver

NAME = "capture_page"
SCHEMA = {
    "type": "function",
    "function": {
        "name": NAME,
        "description": (
            "Render one source PDF page, or a boxed region of it, and read it directly. "
            "Use the file_id and 1-based page shown with a passage. bbox is optional: "
            "[x0, y0, x1, y1] on a 0-1000 grid over the page, origin top-left, to zoom "
            "into a table, figure or formula. Costs one tool call and a few seconds."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "file_id": {"type": "string"},
                "page": {"type": "integer", "minimum": 1},
                "bbox": {
                    "type": "array",
                    "items": {"type": "number", "minimum": 0, "maximum": 1000},
                    "minItems": 4,
                    "maxItems": 4,
                },
            },
            "required": ["file_id", "page"],
            "additionalProperties": False,
        },
    },
}
ADDON = (
    "\n- capture_page shows you a source page, or a boxed part of it, as it is printed. "
    "Use it when a passage carries a low extraction confidence, when a table, figure, "
    "formula or list relationship is unclear in the text, or when the question is about "
    "what a figure shows. Pass bbox to zoom into the region you need. Treat what you read "
    "from a capture as evidence and cite it by its passage number."
)
_OSS_LINK = re.compile(r"!\[[^\]]*\]\(https?://[^)]*\)")
_QWEN_HOST = "https://ws-4xvo9o0v8ridgyd8.cn-beijing.maas.aliyuncs.com"


def patch_tokens(width: int, height: int) -> int:
    """Image tokens on a 28-pixel patch grid (GLM, Qwen). OpenAI and Anthropic
    price differently; this is the estimate shown next to a capture."""
    return -(-width // 28) * -(-height // 28)


def render(
    pdf: Path, page: int, bbox: list[float] | None, max_edge: int
) -> tuple[bytes, list[float]]:
    """JPEG of the page or box, and the box actually rendered on the 0-1000 grid."""
    import pymupdf

    with pymupdf.open(pdf) as doc:
        if not 1 <= page <= len(doc):
            raise ValueError(f"page must be between 1 and {len(doc)}")
        pg = doc[page - 1]
        rect = pg.rect
        if bbox:
            x0, y0, x1, y1 = bbox
            if not (x0 < x1 and y0 < y1):
                raise ValueError(
                    "bbox must be [x0, y0, x1, y1] with x0 < x1 and y0 < y1"
                )
            clip = pymupdf.Rect(
                rect.x0 + rect.width * x0 / 1000,
                rect.y0 + rect.height * y0 / 1000,
                rect.x0 + rect.width * x1 / 1000,
                rect.y0 + rect.height * y1 / 1000,
            )
        else:
            clip, bbox = rect, [0, 0, 1000, 1000]
        scale = max_edge / max(clip.width, clip.height)
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False)
    from PIL import Image

    image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=80)
    return buffer.getvalue(), [float(v) for v in bbox]


async def ocr_transcribe(data_url: str, route: str) -> str:
    key = os.environ.get("ALIBABA_API_KEY")
    if not key:
        raise RuntimeError(
            "ALIBABA_API_KEY is not set; ocr mode needs the Beijing workspace key"
        )
    sys.path.insert(0, str(REPO / "bench/parsers/scripts"))
    import httpx
    from bench_qwen_ocr_pdf import parse_response, request

    url, body = request(route, _QWEN_HOST, data_url)
    async with httpx.AsyncClient(timeout=180) as client:
        response = await client.post(
            url, json=body, headers={"Authorization": f"Bearer {key}"}
        )
    response.raise_for_status()
    text, _finish, _usage = parse_response(route, response.json())
    # document_parsing returns signed bucket links for figure regions; never
    # forward a credential-bearing URL into the model context.
    return _OSS_LINK.sub("[figure region omitted]", text).strip()


def make_handler(
    config: dict[str, Any], resolver: PdfResolver, state: dict[str, Any], question: str
):
    """Bind one turn's capture handler. `state` collects captures and pending images."""
    from pipeline.prompts.captioning import IMAGE_PROMPT
    from pipeline.retrieval import models, tools
    from pipeline.retrieval.search import Passage

    cap = config["capture"]
    run_dir: Path = state["run_dir"]

    async def handler(args: dict[str, Any], ctx) -> tools.ToolResult:
        if len(state["captures"]) >= config["limits"]["captures_per_turn"]:
            return tools._refused(
                "capture_page attempt limit for this turn is used up.",
                code="limit_reached",
            )
        file_id, page, bbox = args.get("file_id"), args.get("page"), args.get("bbox")
        if not isinstance(file_id, str) or type(page) is not int:
            return tools._refused("capture_page needs file_id and an integer page.")
        scope = await tools._resolve_scope(ctx, {"file_ids": [file_id]})
        if isinstance(scope, tools.ToolResult):
            return scope
        if cap["require_seen_page"] and not any(
            p.file_id == file_id
            and p.page_start
            and p.page_start <= page <= (p.page_end or p.page_start)
            for p in ctx.citations
        ):
            return tools._refused(
                "Retrieve a passage that shows this page first, then capture it."
            )
        started = time.perf_counter()
        try:
            pdf = await resolver.path(file_id)
            jpeg, box = render(pdf, page, bbox, cap["max_edge"])
        except (KeyError, ValueError) as exc:
            return tools._refused(f"capture_page: {exc}")
        n = len(state["captures"]) + 1
        image_path = run_dir / "captures" / f"{n}.jpg"
        image_path.parent.mkdir(parents=True, exist_ok=True)
        image_path.write_bytes(jpeg)
        data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        label = f"{scope.file_names[0]} page {page}" + (
            f" region {[int(v) for v in box]}" if bbox else ""
        )
        from PIL import Image

        with Image.open(io.BytesIO(jpeg)) as im:
            width, height = im.size
        record = {
            "n": n,
            "call_id": args.get("_tool_call_id"),
            "file_id": file_id,
            "page": page,
            "bbox": box,
            "mode": cap["mode"],
            "image": str(image_path.relative_to(LOCAL)),
            "image_bytes": len(jpeg),
            "image_px": [width, height],
            "est_image_tokens": patch_tokens(width, height),
        }
        state["captures"].append(record)
        if cap["mode"] == "pixels":
            state["images"][args["_tool_call_id"]] = (
                f"capture_page result {n}: {label}",
                data_url,
            )
            text = "(captured page image; read it in the attached image)"
            note = (
                f"Captured {label}. The rendered image is attached to the next message; "
                "read it directly and cite this passage number for what it shows."
            )
        elif cap["mode"] == "ocr":
            text = await ocr_transcribe(data_url, cap["ocr_route"])
            note = f"Transcription of {label} by an OCR model. It can drop figure text; cite by passage number."
        else:
            prompt = (
                cap["caption_prompt"].format(question=question)
                if cap["question_aware"]
                else IMAGE_PROMPT
            )
            text = (
                await models.caption_image(data_url, prompt, best_effort=False)
            ).strip()
            note = f"Model-generated description of {label}. It may omit or misread content."
        record.update(
            text=text if cap["mode"] != "pixels" else "",
            elapsed_seconds=time.perf_counter() - started,
        )
        if not text:
            return tools._failed(
                "capture_page returned no usable content for that region."
            )
        # A page already in the evidence keeps its numbers: the capture becomes
        # support for those citations rather than a new, coarser one.
        existing = [
            i + 1
            for i, p in enumerate(ctx.citations)
            if p.file_id == file_id
            and not p.chunk_id.startswith("capture:")
            and p.page_start
            and p.page_start <= page <= (p.page_end or p.page_start)
        ]
        if cap["citation"] == "page" and existing:
            record["cited_as"] = existing
            numbers = "".join(f"[{n}]" for n in existing)
            note += f" This page is already in the evidence as {numbers}; cite those numbers for what the capture shows."
            return tools.ToolResult(
                text_parts=[note] if cap["mode"] == "pixels" else [note, text]
            )
        passage = Passage(
            chunk_id=f"capture:{file_id}:{page}:{','.join(str(int(v)) for v in box)}:{n}",
            file_id=file_id,
            file_name=scope.file_names[0],
            chunk_idx=-1,
            section_path=f"captured page {page}",
            text=text,
            hit_text=text,
            page_start=page,
            page_end=page,
            regions=[{"page": page, "bbox": box, "space": "page-1000-topleft"}],
        )
        return tools.ToolResult(text_parts=[note], passages=[passage])

    return handler


def image_part(
    data_url: str, provider_slug: str, detail: str | None = None
) -> dict[str, Any]:
    if provider_slug == "anthropic":
        header, data = data_url.split(",", 1)
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": header[5:].split(";")[0],
                "data": data,
            },
        }
    part: dict[str, Any] = {"type": "image_url", "image_url": {"url": data_url}}
    if detail and provider_slug == "openai":
        # The only provider here with a density switch; GLM, DeepSeek and Qwen
        # price by pixels sent, so max_edge and bbox are the knobs for them.
        part["image_url"]["detail"] = detail
    return part


def inject_images(
    messages: list[dict[str, Any]],
    images: dict[str, tuple[str, str]],
    provider_slug: str = "",
    detail: str | None = None,
) -> list[dict[str, Any]]:
    """Attach captured images after the tool-result block that produced them.

    Chat-completions tool messages carry text only, and every tool result of one
    assistant step must stay contiguous, so the images ride in one user message
    placed after the last tool message of that step.
    """
    if not images:
        return messages
    out: list[dict[str, Any]] = []
    pending: list[tuple[str, str]] = []
    for i, message in enumerate(messages):
        out.append(message)
        if message.get("role") == "tool" and message.get("tool_call_id") in images:
            pending.append(images[message["tool_call_id"]])
        following = messages[i + 1] if i + 1 < len(messages) else None
        if pending and (following is None or following.get("role") != "tool"):
            content: list[dict[str, Any]] = [
                {"type": "text", "text": "Images from the capture_page calls above:"}
            ]
            for label, url in pending:
                content.append({"type": "text", "text": label})
                content.append(image_part(url, provider_slug, detail))
            out.append({"role": "user", "content": content})
            pending = []
    return out


def check() -> None:
    # Two tool results in one step: the image message must follow both.
    msgs = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "a"}, {"id": "b"}]},
        {"role": "tool", "tool_call_id": "a", "content": "ra"},
        {"role": "tool", "tool_call_id": "b", "content": "rb"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c"}]},
        {"role": "tool", "tool_call_id": "c", "content": "rc"},
    ]
    out = inject_images(msgs, {"a": ("A", "data:a"), "c": ("C", "data:c")})
    roles = [(m["role"], m.get("tool_call_id")) for m in out]
    assert roles == [
        ("system", None),
        ("user", None),
        ("assistant", None),
        ("tool", "a"),
        ("tool", "b"),
        ("user", None),
        ("assistant", None),
        ("tool", "c"),
        ("user", None),
    ], roles
    assert out[5]["content"][2]["image_url"]["url"] == "data:a"
    assert out[-1]["content"][2]["image_url"]["url"] == "data:c"
    assert inject_images(msgs, {}) is msgs
    claude = inject_images(
        msgs, {"a": ("A", "data:image/jpeg;base64,QUJD")}, "anthropic"
    )
    assert claude[5]["content"][2] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": "QUJD"},
    }
    assert _OSS_LINK.sub("[x]", "a ![h.jpeg](http://oss/x?token=1) b") == "a [x] b"
    assert patch_tokens(1568, 1211) == 56 * 44 and patch_tokens(28, 28) == 1
    assert (
        image_part("data:image/jpeg;base64,QQ==", "openai", "low")["image_url"][
            "detail"
        ]
        == "low"
    )
    assert (
        "detail"
        not in image_part("data:image/jpeg;base64,QQ==", "zai", "low")["image_url"]
    )
    import pymupdf

    with pymupdf.open() as doc:
        doc.new_page(width=200, height=100).insert_text((20, 50), "hello")
        path = LOCAL / "check.pdf"
        path.parent.mkdir(parents=True, exist_ok=True)
        doc.save(path)
    try:
        full, box = render(path, 1, None, 400)
        crop, cbox = render(path, 1, [0, 0, 500, 1000], 400)
        from PIL import Image

        assert Image.open(io.BytesIO(full)).size == (400, 200) and box == [
            0,
            0,
            1000,
            1000,
        ]
        assert Image.open(io.BytesIO(crop)).size == (400, 400) and cbox == [
            0,
            0,
            500,
            1000,
        ]
        for bad in ([0, 0, 0, 10], 3):
            try:
                render(path, 1, None if bad == 3 else bad, 100) if bad != 3 else render(
                    path, 3, None, 100
                )
            except ValueError:
                continue
            raise AssertionError(f"{bad} should have been rejected")
    finally:
        path.unlink()
    print("capture checks passed")


if __name__ == "__main__":
    check()
