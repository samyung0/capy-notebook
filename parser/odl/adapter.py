"""Map OpenDataLoader's JSON tree onto Capy's content-list block shape."""

from __future__ import annotations

import html


def node_text(node: dict) -> str:
    content = node.get("content")
    parts = [content] if isinstance(content, str) else []
    parts.extend(
        node_text(child)
        for child in node.get("kids", [])
        + node.get("list items", [])
        + node.get("toc items", [])
    )
    return " ".join(parts)


def odl_content_list(document: dict, pages: list[dict]) -> list[dict]:
    """Map ODL point/bottom-left geometry to Capy's 0..1000 top-left boxes.

    Out-of-bounds boxes are preserved rather than clipped so a parser error
    stays visible. Table cells remain HTML so the chunker's flattener applies.
    """
    blocks: list[dict] = []

    def embedded_images(node: dict) -> None:
        if node.get("type") in {"image", "picture"}:
            visit(node)
            return
        for key in ["kids", "list items", "toc items", "rows", "cells"]:
            for child in node.get(key, []):
                embedded_images(child)

    def visit(node: dict) -> None:
        kind = node.get("type")
        page = node.get("page number")
        box = node.get("bounding box")
        common: dict = {"_native_type": kind, "_native_id": node.get("id")}
        if isinstance(page, int) and 1 <= page <= len(pages):
            common["page_idx"] = page - 1
            width, height = pages[page - 1]["width"], pages[page - 1]["height"]
            if isinstance(box, list) and len(box) == 4:
                x0, y0, x1, y1 = box
                common["bbox"] = [
                    round(x0 / width * 1000, 3),
                    round((height - y1) / height * 1000, 3),
                    round(x1 / width * 1000, 3),
                    round((height - y0) / height * 1000, 3),
                ]
        if kind == "list":
            blocks.append(
                {
                    **common,
                    "type": "list",
                    "list_items": [
                        node_text(item) for item in node.get("list items", [])
                    ],
                }
            )
            embedded_images(node)
            return
        if kind == "table":
            rows = []
            for row in node.get("rows", []):
                cells = []
                for cell in row.get("cells", []):
                    tag = "th" if cell.get("is_header") else "td"
                    rowspan = int(cell.get("row span", 1))
                    colspan = int(cell.get("column span", 1))
                    cells.append(
                        f'<{tag} rowspan="{rowspan}" colspan="{colspan}">'
                        f"{html.escape(node_text(cell))}</{tag}>"
                    )
                rows.append("<tr>" + "".join(cells) + "</tr>")
            blocks.append(
                {
                    **common,
                    "type": "table",
                    "table_body": "<table>" + "".join(rows) + "</table>",
                }
            )
            embedded_images(node)
            return
        if kind in {"image", "picture"}:
            block = {**common, "type": "image", "img_path": node.get("source", "")}
            if node.get("description"):
                block["image_caption"] = [node["description"]]
            blocks.append(block)
            return
        if kind in {"formula", "equation"}:
            blocks.append({**common, "type": "equation", "text": node_text(node)})
            return
        if isinstance(node.get("content"), str) and node["content"].strip():
            block = {**common, "type": "text", "text": node["content"]}
            if kind == "heading":
                block["text_level"] = node.get("heading level", 1)
            blocks.append(block)
            return
        for child in node.get("kids", []) + node.get("toc items", []):
            visit(child)

    visit(document)
    return blocks


def nodes(node: dict):
    """Every node of the Java tree, depth first, including table rows and cells."""
    yield node
    for key in ("kids", "rows", "cells", "list items", "toc items"):
        for child in node.get(key, []):
            yield from nodes(child)
