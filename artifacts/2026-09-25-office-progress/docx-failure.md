# Rich DOCX failure investigation, 2026-09-27

The local reproduction points to a journey input-readiness race. The owner's
`人數：24人` survives. The collaborator's complete sentence is present in the
export, but appended to the first heading, `2022 至 2023 年度`, instead of
`主題：智能科技，精湛技術`. Waiting another 180 seconds cannot correct that edit.

## Evidence and limits

- Failed UAT run [36282937259](https://github.com/samyung0/capy-notebook/actions/runs/36282937259)
  contains only the initial rich-DOCX charge evidence. The configuration turns
  traces off; the uploaded artifact excludes Playwright's error-context file.
  The polling error prints the first 1,500 characters of serialized ZIP bytes,
  before the saved text or checkpoint. Cleanup removed the test resources.
  The exact misplaced text in that historical run therefore cannot be recovered
  from its artifact.
- A local Chromium process opens two browser contexts using the deployed Office
  iframe. Its release metadata still identifies
  `4c96071705c1590957ed4d7804d1ac088f18841a`, with BetterOffice pin `04560dd6`.
  A local Y.Doc relays only newly emitted Yjs updates between the iframes. The
  pinned headless Office engine exports their combined state after flushing.
  There is one test process, with attempts run sequentially.
- The final control uses the original, committed `editRich` helper, the same
  initialized/flush handshake and the same delta relay as the revised helper.
  It fails its exact-edit assertion. Its export contains the owner's change and
  the collaborator's complete sentence on the year heading.
- Three consecutive attempts with the revised helper contain both edits in the
  intended paragraphs. All three exported files also pass `assertRichPreserved`,
  including chart and workbook bytes, pictures, tables, footer and page breaks.
- Applying the edited state through `applyContentUpdate` returns true. This
  contradicts an unchanged-save false negative for these reproduced states.
  The reproduction does not exercise UAT's database, Hocuspocus transport,
  accounting, or publication. It does not prove those paths have no other bugs.

An early harness forwarded redundant full snapshots. Those trials are not the
control evidence above; the final harness relays only the updates emitted by
Y.Doc. Raw logs, exported fixtures and the reproduction scripts are kept under
the locally ignored `local/` directory beside this report.

## Why input went to another paragraph

The accessibility mirror is intentionally retained during layout updates.
`useDisplayList.ts:1087` exposes no hit-test queries until its geometry is ready,
and `usePagesPointer.ts:234` returns no hit without those queries. Finding a
mirror span and successfully dispatching a mouse event does not establish that
the editor accepted that span as its caret position.

The original helper also reads a bounding box separately from `mouse.click`.
One diagnostic recorded the subsequent mouse-down over the title instead of the
topic. Switching to a single locator click removes that coordinate gap but is
insufficient: the target can be present while hit testing is unavailable.

Checking input focus was insufficient too. `YrsInput.tsx:1246` has an effect
that schedules focus, and Playwright's `input.press()` can focus the input
without placing a new editor caret. Waiting only for the peer's rendered count
still failed in one of three intermediate trials.

The existing text cursor is the useful readiness signal. `hoverCursor.ts:31`
maps a valid text hit to `text`, and otherwise uses `default`; the pointer
handler uses that same hit-test query. No new product readiness API is needed.

## Change

`e2e/uat/journeys/richContent.ts` now waits for the collaborator to display the
owner's completed count edit. For each DOCX target it hovers the mirror glyph,
waits for the canvas text cursor and then clicks the glyph through Playwright's
locator. Only target selection is retried, before any typing. The exact exported
paragraph assertions and 180-second persistence deadline remain in place.

`richContent.spec.ts` attaches the last saved text, checkpoint and epoch when
convergence fails. Future failures can distinguish missing text from misplaced
text without reconstructing truncated binary output. The evidence uses the
existing sanitization and artifact upload path.

No collaboration-service or BetterOffice product code changed. The test catalog
describes the new readiness check and failure evidence.

## Checks

- Revised browser reproduction: 3/3 sequential runs contained the exact edits;
  all three saved exports passed `assertRichPreserved`.
- Original-helper control: failed with the sentence on the year heading.
- `pnpm test:collaboration --maxWorkers=1 collaboration/src/contributors.test.ts collaboration/src/sourceDocuments.test.ts`:
  24 tests passed across two files.
- `pnpm exec tsc -p e2e/uat/tsconfig.json --noEmit`: passed.
- Targeted Biome check for the two changed journey files: passed, no fixes.

## Remaining release work

The changed journeys have not run against UAT's persistence/publication pipeline.
The complete 13-journey gate still needs a run, including rich XLSX and PPTX,
which the previous gate never reached. This investigation does not clear that
release gate. The Office test changes are uncommitted; unrelated work has advanced
local main since the previous handoff.
