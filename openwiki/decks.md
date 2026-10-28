# Decks

A deck is one of the chat agent's two main explainers, next to the note
(`human/agentic-retrieval.md`, 2026-10-05); the study preferences say how
either explains (2026-10-14). It is made the
[ppt-master](https://github.com/hugohe3/ppt-master) way, its Quick route: the
model writes each slide as SVG, ppt-master's checker refuses a slide whose text
leaves its module or the canvas, and its exporter compiles the slides into a
PPTX of native, editable shapes. The PPTX is stored as a workspace file and is
the document from then on. How the playground tunes decks, its measurements and
how to add a style: `lab/playground/DECKS.md`.

## ppt-master in the image

ppt-master (MIT, Copyright (c) 2025-2026 Hugo He) runs from its official
distribution: the whole checkout at `deck.PPT_MASTER_COMMIT`, less icons,
sounds and image-model comparison sheets, at `/opt/ppt-master`, with
`deck.PPT_MASTER_DEPS` in its own virtualenv `/opt/ppt-master/.venv`
(`pipeline/Dockerfile`, stage `ppt-master`), installed with `--require-hashes`
from `pipeline/ppt-master-requirements.txt`: exact versions with hashes,
regenerated with the command in its header after `PPT_MASTER_DEPS` changes
(`test_deck.py` checks every name is pinned). Its attribution guard refuses a
partial copy, so nothing is vendored piecemeal. The retrieval service calls two
scripts as subprocesses (`retrieval/deck.py`, 180 s each), from its render pool
rather than the default executor ([agentic-retrieval.md](agentic-retrieval.md#process-capacity)):
`svg_quality_checker.py <project> --quick-generate --canonical-authoring --stage final --json`
and `svg_to_pptx.py <project> --quick-generate --no-notes -o <pptx>`. The
checker's width estimator is table-based, so the image needs no fonts. The
stage adds about 90 MB (17 MB checkout, about 73 MB of Linux wheels; measured
2026-10-05 without a full build).

To move the pin, change `PPT_MASTER_COMMIT` in `deck.py` and the Dockerfile's
`ARG PPT_MASTER_COMMIT` together (`test_deck.py` fails otherwise), run
`python lab/playground/scripts/playground.py --check` (it clones the pin into
`lab/playground/local/ppt-master` and exports a sample through the real
scripts), and compare a live deck with the previous commit's.

## The flow

Offered to a turn holding `material.create` (owner and editors, the role set
that may upload) with the gateway configured, always (Epo 2026-10-14): the
retrieval image holds ppt-master, and where it is missing a deck fails loudly
(`deck._script`). Both tools mutate, so a response that calls one runs
serially.

1. **Skill.** `read_skill("deck_building")` returns the method (outline first,
   one slide per call, finish the deck in the turn that creates it: its slides
   last only until the turn ends, and the final notice says an unfinished deck
   was not saved), the slide rules
   (`prompts/skills.py` `deck_rules`; since 2026-10-25 they also say to anchor
   a box's label at its centre or right edge so text near the right side grows
   inward, and to move, reflow or widen before cutting words after a refusal)
   and the style with its reference slides
   (`prompts/deck_styles/editorial/`: `style.md`, `examples/*.svg`). Both deck
   tools are refused until `editing` and `deck_building` are in the request
   (`skills.REQUIRES`). The catalog words it as the chapters' skill when the
   output files are PowerPoint, else as one for a request that asks for a deck.
2. **`create_deck {title, slides[{title, brief}], chapter_id?, sources?, excerpt_ids?}`.**
   1 to 30 slides. The outline lives on the turn (`ToolContext.decks`, id
   `deck_` + sha256(message, call)[:12]); nothing is stored. `chapter_id` must
   be one of the turn's chapters. Its `excerpt_ids` follow a material
   write's rule (`tools.write_sources`): named excerpts are credited, and
   omitted ones are the excerpts read since the last write, so each slide
   credits what was read for it. A deck write credits the reads but does not
   retain them for later turns. `sources` is the deck's made-from line, plain
   strings kept on the outline and sent as written when the deck is stored
   (agentic-retrieval.md, `generate_material`).
3. **`write_slide {deck_id, slide, svg, excerpt_ids?}`.** At most 40,000
   characters of SVG. Our checks first: the XML parses, the root is `<svg>`
   with `viewBox="0 0 1280 720"` and `lang`, and every `<image>` is
   `../images/c<n>.jpg` for capture n of this turn, made with a bbox or an
   Office picture `inspect_office_document` attached by id (Q278; a
   capture's result names n; a whole page, a number no capture holds, or a
   capture the turn's image budget has dropped, "no longer available", is
   refused; agentic-retrieval.md, Q349). Captures are numbered rather than
   named by page so page 4 of two sources cannot collide (Epo 2026-10-14).
   Then ppt-master's checker runs on
   the slide alone in a temporary project, and up to six of its errors come
   back as the refusal. A passing slide is kept (writing it again replaces it)
   and counts as a landed write for the stall guard.
4. **Export.** Once every slide is written, a Sources slide is added from the
   style's `sources.svg` when the deck credits library books (one line per
   book: title, authors, edition, licence), the final check and the exporter
   run, and the PPTX is stored (below). An export failure keeps the slides and
   names the slide to rewrite; a store refusal (quota, credits, ingest leases)
   is the tool's refusal, and writing any slide again retries both.
5. **After storing** `write_slide` on that deck is refused: the PPTX is the
   document. People edit it in the PPTX editor; the agent edits its text with
   `edit_document` `replace_text`; anything larger is a new deck. No SVG copy is
   kept.

The deck's slides stay in the message history as `write_slide` arguments; a
stub saved context but cost more (Relace caches at the end of each response) and
the model copied it into slides (`lab/playground/DECKS.md`, 2026-10-05).

**Working directory.** A turn's decks share one directory
(`ToolContext.deck_dir`, `tempfile.mkdtemp`), holding each deck's `images/`,
`svg_output/` and export; `agent.run_agent` removes it when the turn ends. The
slide SVGs themselves live on the deck record.

**Figures.** Nothing is rasterised: drawn diagrams export as native shapes and
book figures are the turn's bbox crops and Office pictures read by id
(whole, `deck.turn_figures`), embedded as images. A slide names a
capture by its page; the JPEG comes from the capture's attached image
(`ToolContext.pending_images`), and a later capture of the same page wins. The
turn's image budget can drop an older capture mid-turn (Q349); a slide naming
it is then refused as no longer available. A
crop from `capture_knowledge_page` carries its `excerptId`, so the slide credits
that excerpt's book whether or not `excerpt_ids` named it. The library admits
only CC BY, BY-SA, CC0 and public domain, so every crop may be redistributed
with its credit; a BY-SA figure makes the deck BY-SA (Go computes the licence).

## Storing: `POST /api/internal/files`

`{workspaceId, userId, assistantMessageId, toolCallId, name, chapterId,
content (base64), provenance, sources}` from the last `write_slide`
(`server/internal/httpapi/internal_files.go`). The deck lands the way an upload
does:

- Pipeline secret, the actor's account access and `AssertWorkspaceEditor`, the
  normal upload's check (`internalDocumentsActor`); the actor and workspace
  must be the assistant message's own (`AssistantMessageContext`).
- Only a non-empty `.pptx`, its size under the owner's plan cap
  (`sourceupload.Validate`); the body is bounded by the absolute source
  ceiling as base64. Provenance names library books only and is bounded as a
  stored record (it was merged over many calls).
- Sources take the materials' bounds and resolution (`validSources`,
  `resolveSources`; a blank one is dropped): the names land in
  `files.scope_file_names` (migration `0100`), which no API response carries
  yet and a copy of the file keeps.
- The receipt id is `ChatOperationID(message, call)`; the request hash covers
  the name, chapter, provenance, sources and the content's SHA-256. A replay
  returns the receipt before any blob is written.
- The blob goes under `sources/`, then `store.CreateAgentFileOperation` runs
  `createSourceWithJobTx`: the editor lock, the chapter, the
  owner's quota gate on the bytes plus the provenance JSON, the workspace file
  cap, the actor's ingest reservation (refused when their credits are
  exhausted), the `files` row with `provenance`, and the parse job that makes
  the deck searchable; plus the receipt (`agent_operations.kind` is
  `create_material`, as its check constraint has no file kind). A refusal or a
  replay that lost the race deletes the blob.

The chat shows the receipt as a created file with Open.

## Viewing and editing

The PPTX viewer and editor load Liberation Sans as Arial and Caladea as Cambria
(`src/office-runtime/pptxFonts.ts`), so the `editorial` style's titles render
with Cambria's metrics. `replace_text` works on agent-made decks (checked
2026-10-05 on three playground decks with the BetterOffice runtime: 38 to 213
editable paragraphs; edit, export, reopen and Undo). Each SVG `<text>` line is
its own shape, so a sentence wrapped over lines is several targets and a longer
replacement does not reflow into the next line's box. An edit of the deck is a
source-file edit: no `excerpt_ids`, and its provenance is unchanged. Once a
deck exists the agent reads and edits it with `inspect_office_document` and
`edit_office_document` ([agentic-retrieval.md](agentic-retrieval.md), Office
tools); every slide sits on ppt-master's one blank layout, so `add_slide`
gives an empty slide and `add_text_box` puts text on it.

## Output files preference

`studyPreferences.mainFormat`: `note` (Capy Note, the default) or `deck`
(PowerPoint), shown as Output files in Settings → Study
(`StudyPreferencesSection.tsx`). There is no automatic choice: a deck can be
dense too, so how much either explains is the writing style's job (Epo
2026-10-14). It reaches the model as the first study-preference line of the
turn context (`prompts/preferences.py` `MAIN_FORMAT`), which also has the
agent make other materials as the preferences and the chapter's teaching need
say. With `deck` the knowledge-check line is left out (checks are notes only),
and `read_skill`'s catalog offers `deck_building` for the chapters and
`note_building` for a request that asks for a note.

## Not used yet

Native charts and tables, the icon libraries, AI images, speaker notes,
animations, and structured templates (Masters and Layouts). One style,
`editorial`; more styles and school templates are in the central todo list.
