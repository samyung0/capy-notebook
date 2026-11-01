"""Skills: instructions the chat agent reads with read_skill when its work needs
them, so a turn that only answers a question does not pay for them on every
call. ``retrieval/skills.py`` offers them; Epo tunes this text in the playground.
"""

from __future__ import annotations

from ..retrieval.contract import OFFICE_SHAPE_TEXT
from ..retrieval.limits import WRITE_ERROR_GRACE, WRITE_ERROR_GRACE_MAX

EDITING_WHEN = (
    "read before any write: creating materials, adding to them, or editing a file"
)
NOTE_BUILDING_WHEN = (
    "read together with editing, in the same response, before writing a note or "
    "adding note sections"
)
DECK_BUILDING_WHEN = (
    "read together with editing, in the same response, before making a PowerPoint "
    "(create_deck, write_slide)"
)
OFFICE_BUILDING_WHEN = (
    "read before reading a Word, Excel or PowerPoint file (it offers "
    "inspect_office_document and edit_office_document); to edit or create one, read "
    "it together with editing, in the same response"
)

# The general guideline for every write (Epo 2026-10-14): the build plan, the
# quiz and flashcards formats, and how to edit; no Mermaid (Epo 2026-10-25). A note's and
# a deck's own instructions are note_building and deck_building.
_EDITING = f"""How to write to the workspace: build study materials, add to them and edit files.

Plan:
- You must identify the requirement first before building: the learning scope and learner's level, as "I want to learn physics" lacks both: check what is missing and offer a default they can accept rather than an open question.
- In the same message, briefly outline what you will create: each new file and the chapter it goes in, reusing the workspace's chapters (list_sources) and marking the new ones with create_chapter. The outline should be brief.

What to build:
- Each chapter gets one main explainer, a note or a PowerPoint as the output-files preference says; note_building or deck_building says how to write it.
- Quizzes and flashcards are standalone materials filed in the chapter they practise, by its chapter_id from list_sources.
- Always add images. Images catch the learner's attention and make ideas easier to explain. A picture need not carry the explanation itself; it only needs to be relevant. Make an image that is likely decorative, such as a logo or an icon, smaller.
- Follow the study preferences in the turn context unless the request says otherwise.

Budget:
- Once a write lands, each successful write is progress and the turn context counts the responses left without one; each of the first {WRITE_ERROR_GRACE_MAX} errored writes grants {WRITE_ERROR_GRACE} more.

Precautions:
- Ground every write in passages or excerpts you have read, and leave out what they do not support. Label an example the sources do not give as illustrative.
- Write each item as soon as its evidence is in hand. Do not keep exploring once the evidence covers it, and do not mix a write with retrieval calls in one response.
- Inspect a document before editing it; never take edit positions from search results or from tool results retained from earlier turns. Each edit command names its target and the exact text it expects, as inspect_document shows it, and one stale expectation refuses the whole call. Edits save directly (the result says when the user can undo one).
- After you read a document you see its most recent changes. Edits not yet in search show up as hints with the user's message, and a search passage whose document has newer edits says so: read that document before relying on the passage.
- In a note, change plain wording with replace_text. Rewrite a block that has formatting or math ($…$ in inspect_document) with replace_block, writing the whole block as note markdown (a heading keeps its #).
- Keep changes other people made to a document unless the learner asks otherwise.
- Be careful about editing existing files. Edit the learner's own source files only when asked. Such an edit takes no excerpt_ids.

Quizzes: add_questions writes multiple-choice, short-answer and open (written-answer, with a markscheme) questions, creating the quiz with its first ones (title) or adding to a quiz by quiz_id, a note's quiz too; options are shown shuffled, so never refer to an option by its letter or position (A, B, "the first", "all of the above") in a question, option or explanation; add_question_media puts a chart, a plot or a library figure under a question's text; edit_document remove_question removes one. Results list the question ids these tools take.

Flashcards: cards, a list of {{front, back}}.

When done, answer briefly on what was made.
ALWAYS read the document again to see if you need to adjust the visuals to meet the user preferences."""

# Reading, editing and creating Office files (Epo 2026-10-20): required for
# every Office read and write, and what offers the two Office tools.
_OFFICE_BUILDING = """How to read, edit and create Word (DOCX), Excel (XLSX) and PowerPoint (PPTX) files with inspect_office_document and edit_office_document. Editing or creating one also needs the editing skill: read it with read_skill before the first edit_office_document call.

Read:
- XLSX: the sheet list first (no range), then the ranges you need, at most 2,000 cells a read. A cell shows its input, then → its shown value when that differs (a formula's result).
- DOCX: paragraphs with their target ids, each with its style (unless the default) and list, count at a time from start; a table's cells come before the paragraph after it, each marked with its table's id, row and column; tracked-deleted text is left out. After the body come the headers', footers' and notes' paragraphs under == part == lines; they take replace_text only. A paragraph marked locked (with why: a picture, a field, tracked changes, the table or content control before it) refuses replace_text and format_text, and delete_paragraph unless it only follows a table; one marked content control or table cannot be an anchor. The first page lists the paragraph styles by id and name. A command copies an id whole, as the read shows it.
- PPTX: without slide, the slides count at a time from start, each with its layout and its first shapes (id, kind, placeholder type, first line of text) and how many more it holds; the first page lists the PowerPoint's layouts. With slide (its number), that slide's shapes and paragraphs count at a time from start, each shape with its name and box in points from the slide's top left corner and then its paragraphs with their target ids, levels and table cells; the first page also gives the slide's speaker notes, cut past a length with a marker. A shape marked equation takes no edits.
- Pictures, charts, equations and drawn shapes: a DOCX read lists them under their paragraph, a PPTX slide read on their shapes (the PowerPoint read gives a picture's alt text and a chart's type and title), the XLSX sheet list under their sheet with their anchor cells. A picture shows its alt text and pixel size, or why it is not viewable (then only its alt text is known); a chart its type, title and each series' cell references and first points as [idx, category, value]; an equation or drawn shape its text.
- ids (any format, at most 4 a call, copied whole from a read): each picture comes back as an image on the next message, counting toward the message's images and usable as a slide figure by the capture number its line names; each chart with every point; an id not found is named. These files have no page view: capture_page does not take them.

Edit, one file a call; one stale expectation refuses the whole call:
- set_range writes a rectangle of cells: expected holds the range's inputs exactly as the read shows them ("" for an empty cell), values the new inputs ("=..." for a formula, "" to clear), both in the range's shape.
- format_cells sets fonts, colours, alignment, wrapping and number formats on a range; fields left out stay as they are.
- add_sheet, rename_sheet and delete_sheet change sheets; insert_rows, delete_rows, insert_columns and delete_columns change rows and columns. A delete names what it removes: the sheet's name, or the rows' or columns' inputs as rows of cells like set_range's expected (a row's cells from column A; for columns, rows from row 1 holding the deleted columns' cells), trailing empty cells and rows left out.
- Formulas use only functions the workbook supports, never HYPERLINK, and name only this workbook's sheets: no other workbooks, URLs or file paths.
- replace_text (DOCX, PPTX) replaces text inside one paragraph or shape; its expected_text occurs once there.
- insert_paragraph (DOCX, PPTX) adds one paragraph of plain text right after after_id or right before before_id (the first paragraph's id to start); several after one paragraph land in call order. In DOCX it goes in the body, at its end with neither id, and continues the paragraph before it as Enter does (a list goes on, a heading's next style follows); a style id from the read takes the place of that next style, keeping the list and indent, and list (bullet, numbered or none) starts or ends a list. In PPTX it takes the level and bullet of the paragraph it goes after or before.
- delete_paragraph (DOCX, PPTX) removes one paragraph naming its whole text, never a story's or shape's last. In DOCX the paragraph after it keeps its own id and style, and takes the table the deleted one followed; it refuses a locked paragraph (but one that only follows a table), the paragraph after a table that ends the body or a cell, and one that ends a section.
- set_list makes paragraphs bulleted or numbered, or ends their list (none, which also ends a list the paragraph's style gives); a document has one bulleted and one numbered list, so numbering continues across them.
- insert_table adds a table of text, at most 20 rows of 10 cells, after after_id (in call order) or at the body's end; an empty paragraph follows it only where Word needs one (the table ends the body or comes before another table). delete_table names the table's id and its cells' text as rows of cells.
- format_text (DOCX, PPTX) formats text, its one occurrence in a paragraph (bold, italic, underline, strikethrough, colour, size, font; highlight in DOCX only); set_alignment (DOCX, PPTX) aligns one paragraph.
- set_shape_text (PPTX) replaces a shape's whole text: expected_text is its paragraphs as the slide read shows them, joined by line breaks; paragraphs is the new text, one string a paragraph (at most {shape_paragraphs}, {shape_characters} characters together). Its paragraphs keep their level and bullet, added ones continue the last. A table's text is edited by paragraph with replace_text, insert_paragraph and delete_paragraph.
- add_slide (PPTX) adds a slide right after after_slide or right before before_slide, last with neither, holding its layout's title and text placeholders, empty; layout is a layout id from the PowerPoint read, by default the layout of the slide it follows. Read the slide afterwards for its placeholders' ids and fill them with set_shape_text. A slide on a blank layout (every slide of a PowerPoint made with create_deck) has none: add_text_box puts text on it.
- add_text_box (PPTX) adds a text box of paragraphs (one string each) at x, y with width w and height h, in points from the slide's top left corner and inside the slide; the slide read gives the slide's size and each shape's box.
- delete_slide (PPTX) names the slide's text as its slide read shows it, every paragraph one a line in shape order and then its speaker notes as shown, cut marker included (blank lines and the spaces around a line are not compared), and never deletes the PowerPoint's only slide; move_slide puts a slide right after after_slide or right before before_slide.
- A call's later commands cannot name the slides and shapes its earlier ones add: read again for their ids.

Create: a new Excel or Word file is a create command first, without file_id, followed by the commands that fill it; a new Word file's insert_paragraph and insert_table commands omit after_id and build it in order. A PowerPoint is made with create_deck (the deck_building skill).

Limits: edit_office_document's description lists a call's limits, per command kind (commands, cells, paragraphs, table cells, formatted spans, list and alignment paragraphs, rows, sheets, slides, text boxes, shape text); past one, the commands before it apply and the rest come back unapplied, by index, to send in another call. A call's commands are at most 256 KB; a larger call is refused, so split it.""".format(
    shape_paragraphs=f"{OFFICE_SHAPE_TEXT['paragraphs']:,}",
    shape_characters=f"{OFFICE_SHAPE_TEXT['characters']:,}",
)

_EDITING_LIBRARY = """
- excerpt_ids are a write's attribution: name the library excerpts it uses, each read with read_library this turn or with its full text still in context (a search card or summary is not a read). Omitted, the write credits the excerpts read since your last write, or all read this turn when none are new."""

_NOTE_BUILDING = """How to write a note, a chapter's main explainer when the output-files preference says Capy Note.

- Images, charts, plots and interactive blocks go inside the note where they help an idea, as the study preferences say.
- A quiz or flashcards fence inside a note is a knowledge check, sized and placed as the study preferences say.
- Grow a long note section by section: create it with its first sections, then append each next section with one edit_document insert_markdown command after block "end" rather than rewriting the note.

Note format (create_material content, edit_document insert_markdown and replace_block): {note}"""

_BUILDING_LIBRARY = """

Practice from the library (Workspace only off):
- Use one primary excerpt per section, and keep one book's notation unless another fills a gap you can name.
- To show a figure read_library or search_images listed, put `![caption](figure:<figure id>)` on its own line in a note, or `![caption](figure:<figure id> "small")` for a half-width one: the note stores the picture with its printed credit and credits its book. Any other image URL becomes a plain link.
- Always add images. Images catch the learner's attention and make ideas easier to explain. A picture need not carry the explanation itself; it only needs to be relevant. Make an image that is likely decorative, such as a logo or an icon, small.
- Reuse library exercises and worked examples before writing new questions. Keep a worked example's question, givens, model and solution together, and never splice numbers from different examples. Label adapted or new practice as such; call it a source exercise only when the source asks it."""


def editing() -> str:
    """The same text in both modes of the Workspace only switch, so a skill
    replayed from history never changes with it."""
    return _EDITING + _EDITING_LIBRARY


def office_building() -> str:
    return _OFFICE_BUILDING


def note_building(formats: dict[str, str]) -> str:
    return _NOTE_BUILDING.format(note=formats["note"]) + _BUILDING_LIBRARY


def deck_rules(viewbox: str) -> str:
    """How one slide is written; ppt-master's checker and exporter enforce it."""
    return f"""Write one slide as a single SVG; ppt-master's exporter turns it into native PowerPoint shapes.
- Root: <svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" lang="<the PowerPoint's BCP-47 language>" data-pptx-page-role="cover|toc|section|content|ending" font-family=... font-size=...>, then a background <rect id="background" data-pptx-role="background" .../>.
- Every visible part sits in a module: a root-level <g id="..." data-pptx-bounds="x y width height"> whose bounds enclose its children. Modules do not overlap. A checker measures every text line against its module's bounds and the canvas and refuses the slide when text spills out, so write each sentence first, estimate its width from the style's characters-per-100px table, then size the module.
- Anchor a label inside a box at the box's centre (text-anchor="middle") or right edge (text-anchor="end"), so text near the canvas's right side grows inward. A refused slide moves or reflows its text, or widens its module, before cutting words.
- Allowed: rect, circle, ellipse, line, polyline, polygon, path, text and tspan, g, defs with linearGradient, and image. Each text has x and y; set font-size, font-weight and fill on it or inherit them from its module. Write raw Unicode; escape & < > as &amp; &lt; &gt;. No style element, class, foreignObject, textPath, filters, animation, script, symbol or use, and no HTML entities.
- A figure is <image href="figure:<figure id>" x y width height preserveAspectRatio="xMidYMid meet"/> for a figure read_library or search_images listed; the slide credits its book. Anything else is <image href="../images/c<n>.jpg" .../> for capture n of this turn: a page capture made with a bbox around a picture no figure lists, or an Office picture inspect_office_document attached (its result names n).
- Write the slide for one audience move (what the student knows before it and after it) and lay its points out by how they relate: order as a numbered sequence, contrast side by side, membership as parallel cards. Use only facts from what you read; the footer names the source."""


def deck_building(rules: str, style: str, style_text: str) -> str:
    """The deck skill: the method, the slide rules and the style with its
    reference slides (ppt-master's Quick route, openwiki/decks.md)."""
    return (
        "How to make a PowerPoint, a chapter's main explainer when the "
        "output-files preference says PowerPoint.\n\n"
        "Plan:\n"
        "- Outline with create_deck: one title and brief per slide, in order, one slide per idea, "
        "8 to 20 per chapter, opening with a cover. A brief says the slide's audience move (what "
        "the student knows before and after), how its points relate, and the content with its source.\n"
        "- Then write the slides one per write_slide call, each from what you just read for it.\n"
        "- A slide the checker refuses comes back with its errors: fix those and send the whole "
        "slide again. Once every slide is written the PowerPoint is exported and stored in the workspace "
        "as a PPTX file.\n"
        "- Finish a PowerPoint in the turn if you can; an unfinished one can be continued with "
        "write_slide in a later message for 24 hours, and is not saved until every slide is written.\n\n"
        f"Slides:\n{rules}\n\n"
        f"Write every slide in the {style} style:\n\n{style_text}"
    )


# Account chat's variants (todo-account-chat.md): the workspace wording of
# editing, note_building and deck_building said for the user's files across
# workspaces; the workspace text above is unchanged.
def swapped(text: str, *pairs: tuple[str, str]) -> str:
    """``text`` with each old phrase replaced, failing loudly when one is
    gone, so an edit of the workspace text cannot leave a stale variant."""
    for old, new in pairs:
        if old not in text:
            raise RuntimeError(f"account variant lost its anchor: {old!r}")
        text = text.replace(old, new)
    return text


def account_editing() -> str:
    return swapped(
        editing(),
        ("How to write to the workspace:", "How to write to the learner's files:"),
        (
            (
                "each new file and the chapter it goes in, reusing the workspace's "
                "chapters (list_sources) and marking the new ones with create_chapter."
            ),
            (
                "each new file, the chapter it goes in. Identify which workspace you "
                "should work in, and reuse the workspace's chapters (list_sources) and "
                "mark the new ones with create_chapter. If there is no suitable "
                "workspace, also suggest creating a workspace for the new files "
                "(create_workspace goes first before any files are created)."
            ),
        ),
        (
            "briefly outline what you will create",
            "very briefly outline what you will create",
        ),
        (
            "The outline should be brief.",
            "No need to explain in depth what each file contains.",
        ),
        (
            "unless the request says otherwise.",
            (
                "unless the request says otherwise. No need to restate the preferences "
                "back to user."
            ),
        ),
        (
            (
                "\nALWAYS read the document again to see if you need to adjust the "
                "visuals to meet the user preferences."
            ),
            "",
        ),
        (
            (
                " Omitted, the write credits the excerpts read since your last write, "
                "or all read this turn when none are new."
            ),
            "",
        ),
        (
            (
                "- Quizzes and flashcards are standalone materials filed in the "
                "chapter they practise, by its chapter_id from list_sources."
            ),
            (
                "- Quizzes and flashcards are standalone materials, filed in the "
                "chapter they practise when they land in a workspace."
            ),
        ),
        (
            "- Inspect a document before editing it;",
            (
                "- Inspect a document before editing it, and edit it only when its "
                "Access line says canEdit is true;"
            ),
        ),
    )


def account_note_building(formats: dict[str, str]) -> str:
    return swapped(
        note_building(formats),
        (
            "Practice from the library (Workspace only off):",
            "Practice from the library (Your files only off):",
        ),
        (
            (
                "- Use one primary excerpt per section, and keep one book's notation "
                "unless another fills a gap you can name.\n"
            ),
            "",
        ),
    )


def account_deck_building(rules: str, style: str, style_text: str) -> str:
    return swapped(
        deck_building(rules, style, style_text),
        (
            "stored in the workspace as a PPTX file.",
            (
                "stored as a PPTX file in the workspace create_deck named, or outside "
                "workspaces."
            ),
        ),
        (
            "the footer names the source.",
            "the footer names the source with 200 character limit.",
        ),
    )
