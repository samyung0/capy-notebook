"""Captioning-slot prompts: figures inside a parsed document, and whole images.

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
