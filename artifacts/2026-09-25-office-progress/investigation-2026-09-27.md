# Office failures and application gaps, 2026-09-27

Investigation baseline: Capy `75512bb3ea413ff5aa134502b7f491c471b52d65`,
BetterOffice `04560dd6d7b52ee3436a631135e389d5054bde04`. UAT serves
`4c96071705c1590957ed4d7804d1ac088f18841a`; its Office application code and
BetterOffice pin match the local baseline. The revised journey helper is already
committed in `75512bb3`, contrary to the previous handoff's uncommitted status.
No application code, deployment, database schema or submodule pin changed during
this investigation.

The compact, durable observations are in
[investigation-evidence-2026-09-27.json](investigation-evidence-2026-09-27.json).

## Results

The current DOCX, XLSX and PPTX rich-content journeys all passed against UAT's
real application, collaboration service, database and native export pipeline.
DOCX took 3.4 minutes, XLSX 3.8 minutes and PPTX 2.2 minutes. The run used one
worker, no retries, and `--max-failures=0` so one failure could not hide the later
formats. Run ID: `office-investigation-20260927-current`.

These are three passing scenarios, not a fresh 13/13 release gate. The process
initially exited 1 because global cleanup rejected a Clerk timestamp. That
separate failure is explained below. Passing these scenarios also does not
remove the application defects they avoid or explicitly exclude.

| Finding | Evidence | Smallest corrective change |
| --- | --- | --- |
| DOCX can type at an old/default caret after discarding a click during remote layout | Actual pointer hook drops a click with null geometry; the original helper reproduces a misplaced sentence in a durable UAT checkpoint | Keep the pointer intent observable while geometry is unavailable, and prevent mutation at the old caret until placement succeeds |
| DOCX export loses run language metadata | Source has six `w:lang` elements; native no-edit export has zero; seeded story has no `ja-JP` | Carry language through seed/projection and serialize `w:lang`; remove the test exemption |
| PPTX's slide text editor has no paste or composition input path | Its input handler only mutates text for individual `keydown` characters | Use a native text input bridge for insertion, paste and composition, with the existing selection and flush contract |
| A closing submenu can execute its action twice | Current CI initial attempt and retry both count two executions; closed/inert item accepts a late key and calls `.click()` | Guard closed content's event handlers before Radix can synthesize selection; retain inert for browser interaction and accessibility |
| The root-menu close test assumes the second Enter cannot reopen the trigger | CI ends with an open menu, one execution; a slower local control records the second Enter reaching the restored trigger | Separate late-item activation from valid trigger reopening; make the close-window check deterministic |
| UAT cleanup compares two clocks with only five seconds of allowance | New actor's provider timestamp is 9,049 ms before the local manifest start despite exact run metadata and identity matches | Accept the existing exact recorded ID + run tag + email ownership proof; use time screening only for recovery without that proof |

## Historical failures, corrected

- [36281542884](https://github.com/samyung0/capy-notebook/actions/runs/36281542884)
  and [36282937259](https://github.com/samyung0/capy-notebook/actions/runs/36282937259)
  failed the exact DOCX paragraph convergence assertion at
  `e2e/uat/journeys/richContent.spec.ts:65`. Each had 10 passing tests, one failure
  and two tests not run. The failure occurred before publication.
- [36277362542](https://github.com/samyung0/capy-notebook/actions/runs/36277362542)
  passed DOCX and reached XLSX. XLSX passed the saved-export edit and preservation
  checks, then failed its browser mirror assertion for `H5, 4` at
  `richContent.ts:181`. The cell was outside the virtualized horizontal viewport.
  Commit `ee36c450` added the horizontal scroll before that assertion, and is
  included in deployed `4c960717`. This was a test visibility failure, not evidence
  that the saved workbook lost the cell. The current full XLSX journey passes.
- The older DOCX initial-charge failure in
  [36271966864](https://github.com/samyung0/capy-notebook/actions/runs/36271966864)
  predates the no-op save correction in `df08f63e`. The current run again verifies
  that merely opening and saving leaves `state` null and charges only source bytes.
- Rich PPTX had been blocked by the suite's stop-on-first-failure behavior. Its
  current two-editor, saved export, preservation, charge and view checks
  pass. The rich PPTX case does not exercise paste-driven automatic publication.

The exact text of the two historical failed DOCX exports cannot be recovered.
Those runs disabled traces, attached only the initial charge snapshot, printed
the first 1,500 characters of a serialized ZIP before its readable text, and
deleted the test resources during cleanup. It would be false to name their exact
final paragraph with certainty. What is established is the failed assertion, the
reproduced input-targeting failure class, and the application mechanism below.
Current failure attachments preserve readable text, checkpoint and epoch.

## DOCX click and caret failure

The old helper obtained a mirror glyph's bounding box and later clicked raw page
coordinates. The earlier browser reproduction recorded a click over the heading
after asking for the topic. It saved the owner's `人數：24人` correctly and saved
the entire collaborator sentence on `2022 至 2023 年度`. That is a wrong target,
not a disappearing CRDT update. The same reproduction showed `applyContentUpdate`
recognizing the edit.

This investigation also ran the original `4c960717` helper against real UAT
persistence, without the revised readiness checks. Run
`office-investigation-20260927-controls` saved checkpoint 2, epoch 1. Its exported
paragraphs are exactly:

```text
  2022 至 2023 年度 Collaborator confirmed the July tour.
主題：智能科技，精湛技術
人數：24人
```

The collaborator's mouse-down recorded no text cursor; the owner had a text
cursor. Both actors reached Saved before reading the database-backed export.
This reproduces the exact failing paragraph predicate through durable UAT storage,
not just the earlier local relay. The complete sentence is already saved in the
wrong paragraph; waiting cannot relocate it. The control records the failed
predicate rather than throwing, so its Playwright case is listed as passed.

There is a second, independently confirmed problem with application input:

1. `useDisplayList.ts:1022–1045` waits for replacement hit-test geometry.
   `:1087` returns null queries while keeping the display mounted.
2. `usePagesPointer.ts:850–885` does not install its document listeners when
   queries are null, and removes the previous listeners when the dependency
   changes. A click in that interval has no caret-placement handler.
3. A focused input is still available. `YrsInput.tsx:276–298` retains a valid old
   selection or initializes the first paragraph. `:1246–1250` schedules focus;
   `:1339` gates read-only only on permission/session, not pending pointer intent.
   `PagedEditor.tsx:1372` also forwards container focus to the body input.
4. Playwright's `input.press()` can focus that textarea without placing a caret.
   Later layout readiness does not replay the discarded click.

A focused test renders the real `usePagesPointer` hook with the existing test
geometry double. Ready geometry produces selection at the requested body hit.
Ready → null → click → ready produces no selection callback. Both checks passed.
This identifies the listener removal path, rather than guessing that the
end-of-story fallback in a different handler caused the null-geometry click.

The committed journey helper now waits for the peer's count edit, hovers the
target's last glyph, waits for `cursor: text`, and clicks via a locator. The full
UAT pass proves it works against durable saves in this run. It is still a
readiness check followed by a separate click, not an acknowledgement that the
requested caret was accepted. Focus alone is not that acknowledgement either.

The application fix belongs at pointer-to-selection handoff. Keep observing
pointer attempts during unavailable geometry. An unresolved placement must block
typing into the old/default caret. Resolve an accepted pending request against
the matching ready frame before allowing mutation, or explicitly require a new
click if that frame is no longer valid. Do not replay stale screen coordinates
against an unrelated layout. Make placement success observable so the journey can
wait for the intended selection. No longer persistence timeout, endpoint retry,
database repair or CRDT replacement addresses this failure.

## DOCX language fidelity

The pinned native engine seeded and exported the unmodified rich DOCX fixture.
Its SHA-256 is
`e9121aa3d1ca691be844d5ee6b4112c1e2fe756ef1e40a9d37cdd0dcc0940785`.
The source contains six `w:lang w:eastAsia="ja-JP"` elements. The seeded story
contains no `ja-JP`, and the unedited native export contains zero `w:lang` elements.
This is deterministic content loss before any collaborative editing.

The parser reads `RunLanguage` in `crates/docx-parse/src/formatting.rs:292`.
`crates/docx-edit/src/seed.rs:737` drops it when producing marks. The TypeScript
parity paths also omit it in `packages/docx/src/yrs/documentToYrs.ts:168` and
`yrsToDocument.ts:302`. The Rust writer in
`crates/docx-parse/src/serializer/run.rs:36` does not emit language either.
Fixing only the parser or only the writer cannot preserve it end to end.

Preserve all three language slots through the existing formatting model and Yjs
conversion, then write their OOXML attributes. Add a no-edit seed/export check
and include language in `assertRichPreserved`, which currently exempts it.
The same probe confirms `w:pgNumType` and `w:cols` each survive 1 → 1; old notes
that list those as current losses are stale.

The native command control also replaced the count and topic directly, exported
both exact paragraphs, and found both text replacements in `compareBaselines`.
This separates the input failure from native storage/export capability.

## PPTX input

`packages/pptx-react/src/PptxEditor.tsx:1509–1633` receives keyboard events on a
focusable application div. Printable input reaches `handle.insertText` only when
`Array.from(event.key).length === 1`. The slide stage at `:2221–2230` has no native
editable text control, `onPaste`, `beforeinput`, or composition handlers. Existing
gesture/input flushing does not supply those missing event paths.

An additional UAT control first saved `KEYBOARD_CONTROL_27` through ordinary key
presses. It then sent native direct text insertion and pasted
`CLIPBOARD_INPUT_27` from the real clipboard. A capture listener inside the Office
frame received the exact paste payload, ruling out clipboard permission or focus
as the reason it was absent. The saved export retained the keyboard control but
contained neither input marker. Checkpoint stayed 1 → 1. These observations are
saved in the evidence JSON. This control did not simulate a complete IME session;
the missing composition handler is a source-code finding.

Ordinary per-key typing is covered by the passing rich PPTX journey. The
rich-content journey deliberately omits the paste-driven publication stage for
PPTX and has no editor slide-text
accessibility mirror to assert against; it checks saved slide text and the
available viewer/notes content instead.

Use a native input bridge for slide text, translate committed input/paste into
the existing insert/delete operations and selection updates, and include pending
composition in `flushPendingInput`. Keep shortcuts in `keydown`. First verify a
real paste event reaches the frame and persists through saved export, then an
IME composition commit. Typing a long string one key at a time in the test does
not cover the missing user behavior.

## Current CI menu failures

[CI 36305430178](https://github.com/samyung0/capy-notebook/actions/runs/36305430178)
at `75512bb3` passed the Office pin, frontend, backend and pipeline checks. The
editor browser matrix failed `dropdown submenu restores keyboard focus after a
rapid reopen` on the initial attempt and retry. Its first Enter produced one
execution and closed both menus; the trace snapshot already has `data-state="closed"`
and `inert` on the submenu. The second real `keyboard.press('Enter')` produced
two executions while the content was still retained for exit animation.

`DropdownMenu.tsx` supplies inert/aria-hidden from `MenuOpenContext` but does not
guard item events. Radix `@radix-ui/react-menu` 2.1.24 handles Enter by calling
`event.currentTarget.click()`. Its selection handler checks `disabled`, not
whether the menu is open. The browser's inert/focus processing is therefore the
only current barrier to executing a retained item's handler.

A local real-browser probe confirms the handler defect independently of timing.
With the existing exit animation extended for inspection, the closed inert item
accepts a late synthetic Enter, changing executions 1 → 2. A capture guard on the
same closed content stops the next event, leaving the count at 2. This synthetic
probe proves the handler path; the CI trace supplies the separate evidence that
real keyboard input reaches it. Six normal-speed local sequences counted one
execution, so ordinary local passes do not disprove the race.

Guard keyboard/click dispatch in shared menu content and submenu content when
closed, before Radix can synthesize a selection. Compose caller handlers and
apply the same rule to context menus and checkbox items. Keep inert/aria-hidden.
Do not add a debounce, arbitrary delay, or deduplication to individual commands.

The other CI failure, `closing command content becomes inert before another Enter
can execute it`, failed once and passed on retry. It expected menu count zero
after a second Enter, but the final snapshot shows the menu open and execution
count still one. Closing had finished and focus had returned to the trigger, so
Enter legitimately reopened it. A CPU-throttled diagnostic also records that
second Enter targeting the closed trigger and reopening the menu. Under enough
delay even the preceding transient `inert` assertion can miss the removed node.
The test should isolate a late event on retained closed content from a new
activation of the restored trigger. Preserve the rapid submenu focus check, but
do not require an independently timed Enter to always occur inside a 150 ms exit.

## Cleanup clock failure

The first UAT run's global teardown and explicit cleanup both refused to recover
the first owner and consequently deferred all Clerk deletions. A read-only Clerk
query confirmed one exact email match, the recorded user ID, and the exact private
`capyUatRunId`. Its provider `createdAt` is `2026-09-27T08:27:18.723Z`; the local
manifest starts at `08:27:27.772Z`. The `startedAt - 5000` comparison in
`e2e/uat/journeys/cleanup.ts:123` fails by 4,049 ms.

This is a cross-clock ownership false negative, not evidence of an old production
account or failed Office save. For an already recorded actor, use its exact ID,
email and matching private run tag as the ownership proof. Keep conservative
recovery rules for an unrecorded signup. Do not broadly relax identity checks or
retry this deterministic timestamp comparison.

For this investigation, the existing `cleanupClerkActor` helper removed only the
exact manifest actors after checking their private run tag and email. The normal
cleanup verifier then completed with `failed: []`. No manifest timestamps were
rewritten, and no shared cache objects or database ledgers were deleted manually.
The later control run also exited 1 in Clerk registration recovery after its two
diagnostic cases completed. Its exact manifest actors were removed through the
same ownership-checked helper, and its final normal cleanup completed with
`failed: []` at `2026-09-27T08:50:53.239Z`. Both runs are cleaned up; expected
provider history and hidden B2 versions remain under their retention policies.

## Verification and implementation boundary

- Three real UAT rich-content scenarios passed; global cleanup is accounted for
  separately above.
- The original DOCX helper reproduced the wrong paragraph through a durable UAT
  export. The PPTX control received the real clipboard payload but saved no paste.
- 24 contributor/source-document tests passed.
- 33 native runtime, handoff and Office root tests passed.
- The UAT TypeScript check passed.
- Two actual pointer-hook checks passed, including deliberate null geometry.
- Native DOCX import/export and command probes produced the counts and exact
  replacements above.
- The closed submenu handler reproduction and capture-guard control passed.

Only investigation records are changed in the repository. Scratch probes, raw
exports and local logs are under ignored `tmp/office-investigation/`; downloaded
CI artifacts are under `/private/tmp/capy-office-investigation/`. Rebuilds used
the pinned runtime via `pnpm office:prepare`.

There is no existing production data. The fixes need no production backfill,
legacy seed fallback, dual engine or compatibility migration. A BetterOffice fix
still changes the reviewed submodule pin and possibly deterministic seed hashes;
follow the existing engine-upgrade procedure for any UAT documents deliberately
retained across that change. This investigation's disposable documents are cleaned
through the normal run ownership workflow.
