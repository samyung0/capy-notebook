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
Apply a scenario before opening its dialog or performing its action. The selected
scenario survives links and reloads in the same tab. **Clear** removes the
scenario override; it does not undo edits made to the in-memory mock database.
A full reload recreates the database.

The panel lists the concrete request and instructions for the new HTTP failures.
**Clear cached responses when applying** exposes initial-load errors. Uncheck it
to examine a failed background refresh with cached data still visible.

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
| Global | Offline and reconnecting banners, initial vs cached read failure, root render and chunk-load probes. |

The mock chat stream uses the current `block_start` / `block_delta` /
`block_end` protocol so partial answers and tool results render while streaming.

### OpenUI chat previews

In **Biology 101 → Chat → History**, each **OpenUI:** or **OpenUI failure:**
conversation opens a saved preview immediately. The original plain-text cell
answer remains available. In **User scenarios**, choose the matching OpenUI
scenario, apply it, then send any message in a workspace's Chat tab to stream
that fixture. The panel's **Biology 101** shortcut opens the seeded workspace.

The fixtures cover prose/code/math and CJK text; tabs, steps, accordions and
reveals; concept/metric cards, facts, tags and all callout styles; cited tables;
bar, horizontal bar, line, area, pie, stacked and scatter charts; and a docked
three-question block with choices and free text. **Slow stream / Stop** exposes
progressive rendering and cancellation. Clear the scenario for the default
overview response. These are fixed fixtures, so question submissions receive
the selected fixture again until the scenario is changed or cleared.

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
components with fixture data. File probes intentionally use missing bytes or
failed local resources; they do not simulate a successful Office session.

## Remaining product and mock gaps

These findings are observable with the new scenarios. They were not changed as
part of adding development tools.

- **Suppressed reads:** Dashboard workspace lists, search, notifications,
  billing/usage, model selection, member roster and chat history have consumers
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
- **Suppressed writes:** PDF annotation writes, flashcard study progress,
  notification read operations and task updates have paths that suppress their
  errors. A request failure alone cannot create a missing error component.
- **Source collaboration:** `src/mocks/collaboration.ts` is an in-page stand-in
  for the sidecar: one Y.Doc per room with document and awareness fan-out to
  every participant. It backs the Plate `mock` provider for notes and, through
  `registerMockSourceProvider` in `src/features/files/sourceProvider.ts`, the
  source editor for text files: `GET /api/files/{id}/source-session` seeds a
  `source:<id>:epoch:1` room from the file's mock link and returns its Yjs state,
  `POST /api/files/{id}/collaboration-token` answers `mock://collaboration`, and
  a checkpoint rewrites the mock link so View shows the edit without changing
  the file's revision. MSW skips durable browser draft reads and writes, since
  those drafts would otherwise survive a reset of the mock database. Inbound updates
  carry the receiving provider as Yjs origin, as Hocuspocus does. A room is
  checkpointed and dropped with its last participant, including edits still
  waiting for the editor's save debounce. Encoded checkpoints preserve Yjs
  identities and versions when a room reopens. Rooms, checkpoints and links are
  module state, so a reload reseeds them. Under MSW a missing mock registration throws rather than
  opening a real socket. Office and binary kinds still answer 503 (no fixture
  bytes), and handoff, epoch changes, recovery and local-draft conflicts are
  not reproduced.
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
  picker frames, B2 upload PUTs, events reconnection transport and Office workers
  are not reproduced by these HTTP scenarios. The browser events stream is
  deliberately disabled in MSW; its reconnecting preview sets the cached status.
- **PDF annotations:** successful annotation CRUD has no baseline MSW handlers;
  the new user scenarios make read/write failures deterministic.
- **Unreachable normal openers:** ownership transfer has no normal setter for
  its target, and `WorkspaceStatsDialog` and `TaskEditDialog` have no normal
  callers. The panel now opens them directly. Feature-flagged pages remain
  behind their existing flags.
- **Seeded collections:** mistakes include missed and unanswered fixture questions;
  Create includes 85 additional standalone study notes, and trash includes 87
  archived source files with restorable records and byte links. Both lists paginate
  at 40 items by default; the MSW trash endpoint honors `cursor`, `limit`, and
  `workspaceId`. Trash dates use a rolling 30-day retention window. Scenario reset
  changes handlers, not the database or local editor drafts; reload to reseed.

## Validation

The auth pages were exercised in the browser with dummy inputs, including
sign-in rejection, sign-up code verification and password reset. Unit checks
cover scenario identifiers, state-only scenarios, auth stage isolation/reset,
server-shaped errors, the real import/study endpoint paths, and chat warning/text/effect delivery through the production SSE parser. The repository
frontend tests, TypeScript and formatting/lint checks are run for this change.
