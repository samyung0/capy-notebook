---
type: Report
title: 'MSW scenario coverage audit'
description: 'Frontend reachability audit and developer previews, September 2026.'
tags: [frontend, errors, msw]
---

# MSW scenario coverage audit

Audited on 2026-09-15 by three agents covering auth/account, import/files/editor,
and the remaining signed-in routes. The audit traced component callers, query
error policies, mutations, mock handlers, feature flags, and streaming events.

## Added coverage

Use **User scenarios** in the lower-right corner of the MSW development app.
The September 23 restructuring replaces fault toggles with one-click journeys.
A button prepares the `ws_scenarios` fixtures, navigates, performs real form or
editor actions, then waits for the owning application UI. **Run again** repeats
setup; **Reset** clears dedicated fixtures and faults. Reload does not replay
a submission. Temporary failures retire after rendering so explicit retries
can succeed. Permanent permission/account scenarios survive reload until Reset.
Pending import scenarios keep their polling response until Reset.

| Area | Coverage |
| --- | --- |
| Authentication | Sign-in, sign-up, email verification/resend, breached-password step, password reset, session finalization, OAuth start/callback, pending auth requests. All use the real forms. |
| Onboarding | Direct first-run dialog, profile save, photo upload and completion errors. |
| Account | Suspended, deleted, deletion pending, quota grace/frozen/locked, deletion preflight failure/transfer requirement/submission failure. |
| Workspace | Primary reads, creation/edit/delete/clone, chapters, stats, members, invitations, sharing and ownership transfer failures. |
| Source import | Upload policy, upload/storage/file/ingest limits, cloud inspection and rejected selections, analysis failure, import submission/status/failure/pending. |
| Files | List/detail/link/rename/trash errors; dummy previews for missing bytes, failed ingest, unsupported legacy files, PDF/CSV/audio/image failures, text editing and DOCX/XLSX/PPTX session failures. |
| Chat and AI | Chat history, HTTP failures, SSE failure/early close, coded SSE errors, tool failure, edit effect with refused Undo, pending sources, generation failures. |
| Study | Quiz reads/edit/grading/submission/results; flashcard reads/progress save. |
| Settings | Profile, model/key reads and writes, subscription/usage, checkout/portal, notification reads/preferences, integrations. A free-account checkout scenario exposes the payment action on the otherwise Pro seed. |
| Feature-flagged pages | Read failures for Explore, Schedule, Tasks and Thinking. Existing VITE_FEATURE_* flags still control access. |
| Global | Offline and reconnecting status previews; real route-not-found navigation. |

The mock chat stream uses the current `block_start` / `block_delta` /
`block_end` protocol so partial answers and tool results render while streaming.

### OpenUI chat previews

In **Biology 101 → Chat → History**, each **OpenUI:** or **OpenUI failure:**
conversation opens a saved preview immediately. The original plain-text cell
answer remains available. In **User scenarios**, click the matching OpenUI button. It opens the dedicated workspace Chat tab and
sends a fixture prompt through the real composer.

The fixtures cover prose/code/math and CJK text; tabs, steps, accordions and
reveals; concept/metric cards, facts, tags and all callout styles; cited tables;
bar, horizontal bar, line, area, pie, stacked and scatter charts; and a docked
three-question block with choices and free text. **Slow stream / Stop** exposes
progressive rendering and cancellation. Reset the scenario for the default overview response. The launcher retires temporary overrides after the resulting response is visible.

Failure previews include plain Markdown fallback, a partially recovered program,
an invalid chart alongside a valid one, an unusable program, an empty answer,
an interrupted connection and `response_flagged`. The flagged preview first
streams readable content and a citation, then sends the gateway's safety error.
The UI clears the answer/citations and retains completed tool activity. No raw
tool-protocol markup is sent to the browser. Reopening the saved conversation
keeps the error. All new streamed previews persist in the in-memory mock database;
a full page reload restores the seeded examples.

Edit `src/mocks/chatFixtures.ts` to change an example. The default handler and
scenario overrides share `src/mocks/chatStream.ts`; both use the production
SSE consumer, renderer and history hydration.

The auth shim exists only behind Vite's MSW development alias. It sends local
operation names to `/__mock/auth/*`; it sends no entered email, password,
verification code or photo. Normal sign-in accepts locally valid input and
verification accepts any nonempty code unless the selected scenario rejects
that step. It does not create a Clerk session. The signed-in application keeps
its existing MSW auth bypass.

Direct launchers reuse `OnboardingDialog`, `AddSourceDialog`,
`SourceDetailsDialog`, `WorkspaceStatsDialog`, `TaskEditDialog`, the existing
ownership-transfer confirmation, and `FileViewer`. These are the existing
components with fixture data. Broken-file launchers use missing bytes or failed
local resources. The separate Office save journeys open valid files before editing.

## Remaining product and mock gaps

These findings are observable with the new scenarios. They were not changed as
part of adding development tools.

- **Suppressed reads:** Dashboard workspace lists, search, notifications,
  billing/usage, model selection, tag suggestions, member roster and chat history have consumers
  that opt out of boundaries and omit a local error state. Depending on cache
  state they can show empty, disabled or apparently healthy content. See
  `src/routes/Dashboard.tsx`, `src/components/app/TopInsetBar.tsx`,
  `src/features/notification/NotificationBell.tsx`, `src/routes/Billing.tsx`,
  `src/features/settings/ModelPicker.tsx`,
  `src/features/workspace/WorkspaceMemberManager.tsx` and
  `src/features/workspace/ChatPanel.tsx`.
- **Coded HTTP errors:** `src/api/client.ts`'s Huma error-code allow-list omits
  `source_changed`, `context_too_large`, `too_many_ingest_leases` and
  `too_many_streams`. Server-shaped envelopes for these codes can reach generic
  error handling. The new scenarios preserve that envelope so this gap remains
  visible; the coded SSE fixtures separately reach the stream-specific UI.
- **Suppressed writes:** Flashcard study progress,
  notification read operations and task updates have paths that suppress their
  errors. A request failure alone cannot create a missing error component.
- **Office export warning:** after a runtime export failure, a successful
  subsequent export can leave the host warning visible because its local error
  state is separate from the source checkpoint error. The draft remains
  downloadable. See `src/features/files/useOfficeRuntime.ts`.
- **Checkout rejection:** the checkout failure shows its toast but also rejects
  an unhandled promise in the click handler. See `src/routes/Billing.tsx`.
- **Source collaboration:** the in-page provider can fail the next checkpoint
  and announce a new source epoch. Journeys wait for a successful open, make a
  real edit, then trigger the failure. Failed saves keep the mounted editor;
  replacement with pending edits enters the existing recovery UI. Dedicated
  text and valid DOCX/XLSX/PPTX fixtures preserve encoded checkpoint identities
  in session storage. Ordinary mock rooms remain in memory.
- **Draft recovery:** explicit `mock-scenario-*` files use the existing draft
  transaction code in `capy-source-drafts-msw-scenarios`. The seeded older
  lineage opens through the real recovery logic, including Download draft and
  Discard draft. Reset clears only dedicated scenario drafts. Browser tests
  reload and read this database without replacing the storage functions.
- **Note permissions:** removing edit capability after opening follows the
  parent material guard and shows a static preview. The inner note-editor
  permission message is not reachable through that path.
- **Chaos peers:** the `collab-chaos` scenario ports
  `collaboration/scripts/chaos-peers.ts` into the page (`src/mocks/chaosPeers.ts`):
  three synthetic editors per open room join through the mock room, show
  cursors, type snippets every 0.7–2.8 s, leave after 6–20 s and rejoin after
  2–8 s, and appear as workspace editors in the members list while the
  scenario runs. They follow whichever material or text-source rooms have a
  real participant and stop when the scenario is reset. Peer edits use the same
  checkpoint path as the app's editors. Idle peer groups are retired when their
  room disappears or is replaced, so reopening creates peers for the new room.
- **Cloud format mismatch:** default cloud inspection returns a DOCX while the
  default import completion creates a PDF. This prevents realistic successful
  Office import coverage. The direct fixtures expose the error components.
- **External systems:** real Clerk challenge/session behavior, Google/Microsoft
  picker frames, B2 upload PUTs, events reconnection transport and remote Office
  workers are not reproduced by these scenarios. Office editing does run the
  local native engine. The browser events stream is
  deliberately disabled in MSW; its reconnecting preview sets the cached status.
- **PDF annotations:** baseline MSW handlers now persist annotation CRUD in memory. `annotations-load` shows a read-error toast with Retry; `annotations-save` shows the write warning while the PDF remains visible.
- **Unreachable normal openers:** ownership transfer has no normal setter for
  its target, and `WorkspaceStatsDialog` and `TaskEditDialog` have no normal
  callers. The panel now opens them directly. Feature-flagged pages remain
  behind their existing flags.
- **Seeded collections:** mistakes include missed and unanswered fixture questions;
  Create includes 85 additional standalone study notes, and trash includes 87
  archived source files with restorable records and byte links. Both lists paginate
  at 40 items by default; the MSW trash endpoint honors `cursor`, `limit`, and
  `workspaceId`. Trash dates use a rolling 30-day retention window. Scenario reset rebuilds its dedicated fixture rows; normal seed data remains.

## Validation

The auth pages were exercised in the browser with dummy inputs, including
sign-in rejection, sign-up code verification and password reset. Unit checks
cover scenario identifiers, state-only scenarios, auth stage isolation/reset,
server-shaped errors, the real import/study endpoint paths, and chat warning/text/effect delivery through the production SSE parser. The repository
frontend tests, TypeScript and formatting/lint checks are run for this change.

## Application error journeys, 2026-09-23

The artificial **Error containers** dialog and toast gallery have been removed.
Page and panel failures come from actual route/query failures; text/Office
warnings come from the source provider or runtime; Page not found uses the
router's unmatched-URL fallback. Existing intentionally broken file/material
rows still open ordinary Biology 101 URLs and survive reload.

Office save journeys load valid files and native checkpoint state, edit through
runtime controls, then fail a source checkpoint. The export journey arms a
one-shot development fault at the real runtime export operation and invokes
that operation by switching to View. The iframe stays mounted. These previews
do not verify a remote Office worker or a live collaboration socket.

Offline previews drive Query's online status, not `navigator.onLine`. Use
`e2e/errors/error-surfaces.spec.ts` for browser network emulation and
`workers/site/src/index.test.ts` for server-rendered public summary errors.
Neither is equivalent to an MSW response override.

`e2e/editor/scenario-journeys.spec.ts` checks one-click editor failures, retained
edits, explicit page/form retry, draft download/discard/reload, Office export
recovery, pending auth cancellation and note guard behavior.
`e2e/editor/file-errors.spec.ts` covers preview retries and actual workspace
launchers. Office fixture checkpoints are generated from the matching
`e2e/fixtures/files/basic` files using BetterOffice's `seedOffice` helper.
Regenerate with `pnpm exec tsx scripts/dev/seed-scenario-office.ts` after changing
these fixtures or the BetterOffice pin.
