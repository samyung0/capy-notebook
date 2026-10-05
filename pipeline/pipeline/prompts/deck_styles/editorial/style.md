# Editorial

The default deck style. Taken from ppt-master's example deck
`ppt169_muelltrennung_de_quick` (<https://hugohe3.github.io/ppt-master-examples/viewer.html?project=ppt169_muelltrennung_de_quick>,
MIT, Copyright (c) 2025-2026 Hugo He). The three slides in `examples/` are
that deck's pages 2, 5 and 8 with the body font changed from Segoe UI to
Arial, the face the app's PPTX runtime serves. They are German; write in the
deck's own language.

## Page

- Ground `#FAF8F4` on every page: `<rect id="background" data-pptx-role="background" x="0" y="0" width="1280" height="720" fill="#FAF8F4"/>`.
- Root: `font-family="Arial" font-size="20"`, ink `#1C1C1A`.
- Header module `<g id="header" data-pptx-bounds="64 56 1152 100">`: a teal
  bar `rect x=64 y=58 width=4 height=26 fill=#12525C`; an uppercase kicker
  naming the slide's part at x=80 y=78, Arial 18 bold, `letter-spacing="1.6"`,
  teal; the title at x=64 y=128, Cambria 44 bold, ink; a rule
  `line x1=64 y1=152 x2=1216 y2=152 stroke=#D8D3C8`.
- Content sits in x 64 to 1216, y 168 to 660.
- Footer module `<g id="footer" data-pptx-role="footer" data-pptx-bounds="64 675 1152 24" fill="#8A8A82" font-size="15">`:
  the source at x=64 y=690 and the page number at x=1216 y=690,
  `text-anchor="end"`.
- The cover and the closing page drop the footer; the cover's title is
  Cambria 64 bold over two lines.

## Colour

| Token | Hex | Use |
|---|---|---|
| ground | `#FAF8F4` | page |
| ink | `#1C1C1A` | text, table headers |
| teal | `#12525C` | kicker, numerals, emphasis, the one takeaway band |
| teal-light | `#6E9EA8` | secondary bars and markers |
| tint | `#E1EDEF` | callout boxes |
| card | `#FFFFFF` | cards, table bodies |
| rule | `#D8D3C8` | dividers, card borders |
| text-2 | `#57574F` | secondary text |
| muted | `#8A8A82` | footers, labels, inactive items |
| good | `#2E7D32` | "do" and positive |
| bad | `#B3261E` | "don't" and negative |

Use other colours only when the subject has its own colour code (bins, map
regions, chemical indicators), and then only as small chips or bars.

## Type

| Role | Face | Size | Latin chars per 100 px |
|---|---|---|---|
| title | Cambria bold | 44 | 4.6 |
| heading | Cambria bold | 28 | 7.2 |
| big number | Cambria bold | 64 | |
| lead | Arial | 22 | 9.2 |
| body | Arial | 20 | 10.1 |
| label, kicker | Arial bold | 18 | 11.2 (caps 8.7) |
| note, footer | Arial | 15 | 13.5 |

Bold widens Latin text about 7%. Keep text about 5% inside its module's
bounds; break long lines with one `<text>` per line, 26 px apart at body size.

## Components

- Numbered rows: Cambria 34 bold teal numeral, Arial 20 bold label, a rule
  under each row (`examples/toc.svg`).
- Two or three columns: a 6 px coloured bar on top, an icon or numeral, a
  Cambria 28 heading, then short labelled lists; green and red labels for
  what belongs and what does not (`examples/two_columns.svg`).
- KPI cards: white cards with a `#D8D3C8` border, a muted label, a Cambria
  number, a bold caption and two or three lines of explanation
  (`examples/kpi_cards.svg`).
- Callout: a `#E1EDEF` box or a teal rule on the left, emphasis in teal
  bold.
- Takeaway band: a `#12525C` box with white bold text, at most one per
  slide.
- Tables: an ink header row with white uppercase 15 px labels, white rows
  divided by rules.
- Bar charts: horizontal teal bars with the value at the end, a muted axis.
