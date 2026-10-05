# Decks: adopting ppt-master

How the playground makes slide decks with [ppt-master](https://github.com/hugohe3/ppt-master),
what we took from it and what we left, and how to add a style. Decks are
playground-only until `todo-learning.md` step 2.6; this file moves to
`openwiki/` when they reach the app.

## ppt-master in one page

ppt-master is an agent skill (MIT, Copyright (c) 2025-2026 Hugo He) that
turns sources into an editable PPTX. Its quality comes from the skill, not
the templates: the model writes every slide as free SVG under detailed
authoring rules, a checker measures the result, and an exporter compiles the
SVG into native PowerPoint shapes.

| Part | Where (in the skill) | What it is |
|---|---|---|
| Entry and routing | `SKILL.md`, `workflows/routing.md` | Picks one route: Default Generate, Quick Generate, Create Template, Edit Native PPTX, Beautify, Image to PPTX |
| Default route | `workflows/generate-pptx.md` | Strategist writes `design_spec.md` and `spec_lock.md` (audience, per-slide audience move, relationships, composition, colours, type), the user confirms, then the Executor writes the SVGs |
| Quick route | `workflows/profiles/quick-generate.md` | No plan files and no confirmation: the agent writes the slides directly, runs one final check and exports with `--quick-generate` |
| Executor rules | `references/executor-base.md`, `shared-standards-core.md`, `semantic-svg.md`, `native-shape-authoring.md` and modules | How a page is composed: modules, carriers, devices, typography, topology for related points |
| Checker | `scripts/svg_quality_checker.py` | Refuses malformed pages, overlapping modules and text that leaves its module's `data-pptx-bounds` or the canvas; writes the report the exporter requires |
| Exporter | `scripts/svg_to_pptx.py` | SVG to native shapes; optional native charts, tables, formulas, notes, animations |
| Text measure | `scripts/text_measure.py calibrate` | Characters per 100 px for a face and size, the same estimator the checker uses |
| Templates | `templates/layouts/` | Structured slide rosters: pages whose `data-pptx-placeholder` groups are slots, compiled to PowerPoint Masters and Layouts |
| | `templates/styles/` | Design specs per presentation type (method, page roles, evidence rules, visual defaults) |
| | `templates/charts/`, `templates/tables/` | Visualization references (agenda list, KPI cards, consulting table and others) |
| | `templates/brands/`, `templates/decks/` | Identity kits of real organisations; never used for Capy decks |
| Examples | <https://github.com/hugohe3/ppt-master-examples> | Finished projects with their SVGs, viewable at `hugohe3.github.io/ppt-master-examples` |

## What the playground uses

The Quick route, with the chat agent as the Executor.

| ppt-master | Playground |
|---|---|
| Official distribution | Pinned in `deck.py` (`PPT_MASTER_COMMIT`), cloned on first use into the ignored `local/ppt-master` without icons, sounds and image-model comparison sheets. Its attribution guard refuses a partial copy, so the skill is never vendored piecemeal |
| Scripts' dependencies | Run under `uv run --no-project --with ...` (`deck.PPT_MASTER_DEPS`), separate from the pipeline's environment |
| Strategist, `design_spec.md` | `create_deck`: one title and brief per slide (audience move, how the points relate, content and source) |
| `spec_lock.md` | The style's `style.md`: palette, type sizes with their calibration, page chrome, components |
| Executor rules | The `deck` skill (`deck.skill_text`, read with `read_skill`): the method, `deck.RULES` (a short distillation) and the style with its reference slides. The deck tools are refused until it is in the request |
| Per-page authoring | `write_slide`: one SVG per call |
| Checker | Run on each slide alone (`deck.write`); its errors go back to the model as the refusal. Our own checks first: XML parses, the 1280x720 canvas, `lang` on the root, figures only from this turn's bbox captures |
| Final check and export | Once every slide is written (`deck.save`): the Sources slide is added from the style's `sources.svg`, then `svg_quality_checker.py --quick-generate --canonical-authoring --stage final --json` and `svg_to_pptx.py --quick-generate --no-notes` |
| Project folder | `runs/<run>/materials/<deck id>/` (`svg_output/`, `images/`, `validation/`); the PPTX at `runs/<run>/materials/<deck id>.pptx` |
| Images | `<image href="../images/p<page>.jpg">`, copied from the run's captures |

Not used yet: native charts and tables (`data-pptx-replace-with` with
metadata, `--native-charts-and-tables`), the icon libraries, AI images,
speaker notes, animations, structured templates (Masters and Layouts).

## A style

A folder in `deck-styles/`:

| File | Contents |
|---|---|
| `style.md` | Source and licence; page (ground, root font, header and footer modules with coordinates, content area); colour tokens with their use; type roles with face, size and Latin characters per 100 px; components |
| `examples/*.svg` | Two to four reference slides the model imitates: a list, a comparison, numbers. No native chart or table metadata, and only faces the PPTX runtime can show |
| `sources.svg` | The Sources slide, a `str.format` template with `{lang}`, `{kicker}`, `{title}`, `{rows}` and `{page}` |

`editorial` is the default (`deck.DEFAULT_STYLE`), from the example deck
`ppt169_muelltrennung_de_quick`: warm off-white ground, Cambria titles,
teal kickers and callouts.

### Adding a style

1. Pick a finished deck from ppt-master-examples and download its
   `svg_final/` pages.
2. Read its tokens from the SVGs: `grep -o 'fill="#[0-9A-Fa-f]\{6\}"' *.svg | sort | uniq -c | sort -rn`,
   the same for `font-family` and `font-size`, and one page's header and
   footer groups for the chrome coordinates.
3. Calibrate the type roles against the checker's estimator:
   `local/ppt-master/skills/ppt-master/scripts/text_measure.py calibrate <empty project> --role title:Cambria:44 --role body:Arial:20 ...`
   (run it with the dependencies in `deck.PPT_MASTER_DEPS`).
4. Write `style.md`, copy two to four pages into `examples/` (swap faces the
   runtime cannot show; drop pages with native chart or table metadata), and
   write `sources.svg` from one of them.
5. Try it before a live run: send the same briefs to the model with the new
   style and render the export (`svg_to_pptx.py`, then LibreOffice to PDF).
6. Offer it: `create_deck` takes no style today; add a `style` enum from
   `deck.styles()` when there is more than one.

### Fonts

The app's PPTX viewer serves Liberation Sans as Arial and nothing else
(`src/office-runtime/pptxFonts.ts`). `vendor/betteroffice/packages/fonts`
also has Caladea (Cambria's metrics) and Carlito (Calibri's), not loaded yet.
A downloaded deck opened in PowerPoint uses the real faces. Choose body faces
the viewer serves; a heading face it lacks falls back.

## Templates later

ppt-master's `templates/layouts/` are structured: each page is a Layout with
placeholder slots, and the exporter builds Masters and Layouts from them
(`pptx_structure` mode `structured`; the Quick route supports a Layout or
Deck structure owner). That is the path for a school's own template:
`workflows/create-template.md` builds a Brand, Style, Layout or Deck template
from reference material, an existing `.pptx` included
(`pptx_template_import.py`). Styles stay flat; templates add structure. Both
are in `todo-learning.md`, Later.

## Updating ppt-master

Change `PPT_MASTER_COMMIT`, delete `local/ppt-master`, run
`playground.py --check` (it clones and exports a sample), and compare a live
deck with the previous commit's.

## Measured

### 2026-10-04

Probe, one slide per request: GLM-5.3-Flash at high reasoning wrote a slide
from about 8.5k input tokens (rules, style and three reference slides) and
3k to 9k output tokens, mostly reasoning, in 40 to 110 s. One of four slides
needed one repair after the checker refused overlapping modules. The checker
takes about 8 s per run, the export about 9 s.

Live turn on the lab target (tangents, Library on, 9 slides plus Sources):
12.8 minutes, 17 model calls, 944k input tokens (35k read from cache) and
43k output, about 160 credits at catalog rates. The context reached 110k
tokens: every written slide's SVG stays in the history as a tool argument,
and the style with its reference slides came back twice because the first
`create_deck` was refused. 11 of 20 `write_slide` calls were refused: 8 for
missing ledger fields (one field per refusal; now named together), 2 for a
todo a grouped write had already closed (the tools now ask for one todo per
slide), 1 by the checker. To bring the cost down: prompt caching on the GLM
route, replacing a written slide's SVG in the history with a stub, and fewer
refusals.

Since 2026-10-05 every request extends the previous one (the turn context is
appended and left in place), which is what GLM's cache needs; a build turn of
a note and a quiz read 63% of its input from cache. The style and rules come
once, as the `deck` skill.

### 2026-10-05: written slides left out of the history

The same tangents request on the lab target, default config (GLM-5.3-Flash at
high reasoning, Library on, main format deck, brief explainers, no practice).
First on the current code, then with each written slide's `write_slide`
arguments sent back with the SVG replaced by
`[slide 4 written: Theorem 1: tangent ⊥ radius, 4,059 chars]`, swapped in
before that response went back to the model; a refused slide kept its SVG.
The write receipt's outline already lists which slides are written.

| | Current | SVG left out |
|---|---|---|
| Run | `20261005-175727-469a7c` | `20261005-182127-442266` |
| Slides | 7 plus Sources | 10 plus Sources |
| Model calls | 13 | 15 |
| Input tokens | 607k | 668k |
| Read from cache | 533k (88%) | 587k (88%) |
| Largest request | 81.6k | 68.8k |
| Output (reasoning) | 40.3k (16.2k) | 38.2k (14.9k) |
| Wall time | 17.9 min | 15.9 min |
| `write_slide` refused | 6 of 13: 5 missing ledger fields, 1 todo already done | 4 of 14: 1 missing ledger field, 2 placeholder sent as the SVG, 1 checker |
| Credits | 47.2 | 48.8 |

Credits are uncached input × 150, cached × 30 and output × 500 micros, the
catalog row. Caching alone took this turn from 160 credits to 47.

- Relace saves the cache at the end of each call's output, so a request hits
  only when it sends the previous response back unchanged, reasoning and
  arguments included. In the current run every write call hit the previous
  call's prompt and output. With the SVG left out, every request after a
  response that wrote a slide missed back to the last unchanged response:
  four calls paid 3.4k to 12.5k uncached tokens instead of about 0.8k. On
  that run's own path the misses cost about 2.9 credits and the shorter
  history saved about 1.4 (45k fewer tokens, cached ones), a net loss.
- The model copied the placeholder: after eight written slides showed
  `[slide N written: …]` as their SVG, it sent that text for slides 9 and 10,
  was refused, and wrote them in the next response (one wasted call, about
  4 credits and 30 s).
- Quality held. Both PPTX files, rendered to PDF with LibreOffice, keep the
  style's chrome on every slide (kicker, title, rule and footer at the same
  coordinates, palette colours only, Arial and Cambria); the second deck's
  theorem slides even share one layout. The consistency comes from the skill's
  style and reference slides, which stay in the history.
- The context saving is real, about 1k tokens per written slide, but far
  from the 250k compaction limit, and a cached token costs a fifth of an
  uncached one. Reasoning weighs more: a response writing four slides sent
  back 13k reasoning tokens with its 4.2k of SVG.

Recommendation for 2.6: send every response back unchanged and let compaction
drop written slides when a turn gets long; cut cost through fewer refusals.
The placeholder was removed from the playground after this measurement.
