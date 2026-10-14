"""Captioning-slot prompts: figures inside a parsed document, whole images, and
text-less document pages read by the VLM at ingest.

Both are cached by image bytes alone, so nothing outside the image may enter
them. A file name would make one uploader's naming surface in another
workspace's captions, and would make the same bytes caption differently
depending on who uploaded them first.
"""

from __future__ import annotations

DECORATIVE = "DECORATIVE"

FIGURE_PROMPT = """Describe this figure from a study document so a student's search can find the information it carries.
Use brief, clear sentences. Include visible facts, data, labels, formulas, relationships, and conclusions. Do not add facts that are not visible in the image.
If the image is likely only decorative, such as an ornament, generic icon, divider, background, or branding with no useful study information, return exactly DECORATIVE in all caps and nothing else. If uncertain, describe the potentially useful information instead.
Do not use headings or other formattings since this response will be chunked and indexed."""


IMAGE_PROMPT = """Describe this image as a faithful, searchable record of everything visibly communicated.

Include all readable text. Transcribe every title, label, legend, annotation, table cell, number, unit, date, axis, data point, and formula that is legible. State equations and mathematical notation precisely in plain text or LaTeX. Explain diagrams, charts, spatial relationships, trends, and comparisons. Preserve uncertainty: call out text or values that are unclear instead of guessing. Do not add facts that are not visible. Return coherent plain text, not JSON and not markdown."""


# The developer's wording (2026-10-15), measured in
# bench/parsers/reports/2026-10-15-glm-ocr.md. It rides as the system message.
VLM_PAGE_PROMPT = (
    "Caption this page and extract all the visible text, formulas, tables and "
    "images. Keep text identical. Do not add any information not visible on the "
    "page. The result is directly consumed through a RAG pipeline."
)
