"""Captioning-slot prompts: whole images, and text-less document pages read by
the VLM at ingest.

Both are cached by image bytes alone, so nothing outside the image may enter
them. A file name would make one uploader's naming surface in another
workspace's captions, and would make the same bytes caption differently
depending on who uploaded them first.
"""

from __future__ import annotations

IMAGE_PROMPT = """Describe this image as a faithful, searchable record of everything visibly communicated.

Include all readable text. Transcribe every title, label, legend, annotation, table cell, number, unit, date, axis, data point, and formula that is legible. State equations and mathematical notation precisely in plain text or LaTeX. Explain diagrams, charts, spatial relationships, trends, and comparisons. Preserve uncertainty: call out text or values that are unclear instead of guessing. Do not add facts that are not visible. Return coherent plain text, not JSON and not markdown."""


# The developer's wording (2026-10-15), measured in
# bench/parsers/reports/2026-10-15-glm-ocr.md, plus a last sentence against the
# preface DeepSeek sometimes adds ("Here is the text extracted..."), which would
# be indexed with the page. It rides as the system message.
# A change to it bumps parser_client.PARSER_IMPLEMENTATIONS (the donor key).
VLM_PAGE_PROMPT = (
    "Caption this page and extract all the visible text, formulas, tables and "
    "images. Keep text identical. Do not add any information not visible on the "
    "page. The result is directly consumed through a RAG pipeline. Answer with "
    'the page\'s content only: no introduction such as "Here is the text" and '
    "no closing remark."
)
