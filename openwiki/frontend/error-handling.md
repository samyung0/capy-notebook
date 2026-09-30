---
type: Guide
title: 'Frontend error handling'
description: 'Error surfaces, TanStack Query policy, boundaries, offline and streaming behavior, and test tooling.'
tags: [frontend, errors, react-query, msw, playwright]
---

# Frontend error handling

## Choose one of four surfaces

1. **Boundary** — an unexpected render failure or a primary query without usable
   data. Boundaries replace the region they protect and offer retry or reload.
2. **Toast** — a failed user-initiated mutation when the existing screen remains
   useful. Toasts are global because failures can originate in dialogs or public
   routes.
3. **Inline** — an expected, local failure that needs context-specific recovery,
   such as a workspace, file preview, or secondary panel.
4. **Status** — a persistent connectivity or account condition. Status banners
   do not present a transient request as a fatal page failure.

Do not report the same failure through multiple surfaces.

## TanStack Query defaults

Queries stay fresh for five minutes by default. Notifications and workspace
chapter, file, and material lists use five seconds and refetch on window focus
when stale. The workspace list options also apply to route prefetches.
Route loaders only prime the cache and never return the prefetch: a returned
promise makes TanStack Router hold the whole matched branch, app shell
included, until that one request settles, which serialized `/me` and the shell's
other reads a round trip behind each page's first query. `page()` in
`src/router.ts` discards any return value; hand-written routes use block
bodies. The auth-shell route itself prefetches `/me`, so every page starts it in
the first wave.
File and material detail queries also use five seconds, but retain the global
disabled focus refetching. Reopening stale details refreshes them; live material
editing continues to receive content through Yjs.

The query client throws a query error to the nearest boundary only when the
query has no cached data. A failed background refresh therefore keeps rendering
the last usable result. Secondary and optional queries must opt out with:

```ts
meta: { errorBoundary: false }
```

The owning component must then destructure and render the relevant query error
state. Destructuring is required so TanStack Query's tracked-property proxy
subscribes to those fields.

Query metadata is shared by observers of the same key. A secondary consumer
must preserve the primary consumer's error policy. The ingest hook takes the
workspace page's loaded files rather than adding an observer with a different
policy. The Files preview dialog handles its detail-query failure inline with
`FileError` and a manual Retry action.

Mutation failures produce an error toast by default. A mutation that renders its
own inline error, needs domain-specific messaging, or treats cancellation as
normal must use:

```ts
meta: { errorToast: false }
```

`too_many_ingest_leases` is kind `ingest`, distinct from `llm_credits_exhausted`
and `too_many_streams`. The add-source dialog toasts it and keeps the unsent
tail. Do not map it onto credits or the file-cap copy.

Browser analysis of a fast-parse row reports inline on that row, never as a
toast: one message each for a user-password PDF, a damaged file, more pages
than the policy's `maxPages`, and more text-less PDF pages than 105% of
`maxOcrPages` (all hold Add), a non-blocking warning from 95% of `maxOcrPages`,
and the generic "could not be analyzed" only for transport errors and browser
safety limits. `sourceAnalysisIssue` in `sourceDetails.ts` owns the rules; see
[office-files.md](office-files.md).

Abort errors and account-blocking errors are also excluded from the global
mutation toast. Toast IDs are derived from the normalized error kind, so repeated
failures of the same kind update/deduplicate instead of stacking. The global
Toaster stays at the bottom right and normally displays at most three toasts.
While an error is present, the shared list expands with no count cap so other
toasts cannot cover the error.
Warnings and errors last seven seconds; default and success toasts retain
Sonner's four-second duration.

## Boundary tiers

- The root `AppErrorBoundary` protects the router and development probes. It
  renders a full-page fallback and recognizes chunk-load errors as requiring a
  reload.
- Router error components protect route-level lazy loading and loader/render
  failures.
- Feature and pane boundaries protect independently recoverable regions such as
  workspace center content and editors.
- Expected primary-resource failures may use an explicit inline page/pane
  surface when the component has a tailored recovery path.

Resetting a boundary also resets TanStack Query's error state before retrying.

## Shared-resource security

Public workspace summaries at `/w/:id` render on the server. Upstream HTTP 401, 403, and 404
all produce the same “private or unavailable” HTML with HTTP 404, `no-store`,
and `noindex, nofollow`. They do not use the React error components. Do not
include resource names, server details, or different actions that disclose
which case occurred. Worker tests inject upstream failures; browser tests
compare actual private and missing workspace summaries because browser route
interception cannot intercept the server's summary fetch.

Workspace invitation acceptance uses the same non-disclosing surface for an
invalid link or unavailable workspace. Network and server failures keep the
invitation panel visible with inline error copy and a retry action. The mutation
does not also emit a global toast.

## Offline and paused work

Nothing app-wide sits above the page, so connection and account state never
shift the layout. The dashboard banner slot (`DashboardBanner`) shows only the
viewer's own account, one card at a time in place of the default banner:
frozen, over-quota grace, storage full (red), storage near the limit (amber),
offline, reconnecting (stream disconnected). The full and near cards read
`account.storageUsage` from `/me` and show "You've used X of Y" (whole
megabytes, "96 MB of 100 MB") with a usage
meter (`[data-testid="storage-usage-meter"]`) above the Subscription and
Settings links. The connection card carries `[data-connection-status="offline"]`
or `"reconnecting"`. Suspended, deleted and deletion-pending accounts keep the
full-screen `AccountBlockedScreen`.

Inside a workspace, `WorkspaceHealth` raises one `userToast` per visit for the
workspace storage status, and one while offline (also whenever the browser
goes offline there). The status is ordered: the viewer's own frozen account,
the owner's frozen account, the owner's storage full (grace counts as full),
then the owner near the limit (`storageOwnerUsage`). The owner is never named:
a member reads "Workspace owner is almost out of storage", "Workspace owner's
storage is full" or "Workspace owner's account is frozen"; the owner reads
"Your storage is almost full", "Your storage is full" or "Account frozen". Near
uses the warning toast, full and frozen the error toast. The file header status
slot shows the save state, or `wifiOff` while offline
(`[data-connection-status="offline"]`) for every file type. The workspace
status triangle (`[data-storage-status]`) sits to its right, amber near the
limit and red when full or frozen; its tooltip is the status title and it
opens the same details dialog as the toast's Details action. With no file
open, the header shows both icons after the workspace picker and no strip.
Frozen read-only and view-only at the storage limit need no client logic
inside workspaces: the server's capabilities drop `canEdit` for a frozen
account, so edit mode, comments, curate and create controls disappear, and
drop only `canEditContent` while the owner is at or over its limit (full or
grace), so edit mode, comments, PDF marks and quiz or card edits disappear
while rename, move and delete stay. `?mode=edit` falls back to view in both.
A write that still meets `account_over_quota` or `storage_quota_exceeded`
inside a workspace (a stale capability, or creation at the limit) shows only
the workspace status toast: `deferStorageRefusal` (in `src/lib/errors.ts`,
called first by the mutation cache and by surfaces with their own error toast
or strip: the upload dialog, sharing, clone, note media uploads, the PDF
annotation strip and the generate panel) hands each refusal once to
`WorkspaceHealth`. A quota refusal carries its numbers only for the charged
account, so one with numbers seen by a member (a clone charged to the member)
is about the member's own storage and keeps the surface's copy. The
`quota_blocked` analytics event is recorded before the deferral (by the
mutation cache, or by the upload and clone surfaces for their own). At the
limit the chat's curate switch hides with `canEditContent`, since the server
refuses curate there. Its `refusalHandler` refetches the workspace and
`/me` and shows the status as a new toast (fresh id including the status
kind, full timer), in own-account wording for the owner and owner wording for
members. Refusals arriving while that refetch runs share its toast. If the
refetch fails, react-query keeps the stale data and the plain toast for the
error code shows (the offline toast when offline); a refetch that shows no
status refusing writes (none, or near the limit) also shows the plain toast.
Outside a workspace the toast keeps the
own-account copy ("Account frozen"). Outside workspaces the pages read `/me`
(`useAccountFrozen`): Workspaces, Create, Thinking, Schedule and Explore
disable their create controls, Schedule hides event and label Edit, the Canvas
page is read-only, the dashboard calendar stops creating slots, and their page
headers show the same red triangle (`AccountStatusButton`) that opens the
storage details dialog. Flashcard study and quiz attempts only disable
cloning. A room that turns read-only while open for a storage or frozen
refusal (`room-read-only`, or a `collaboration-read-only` refusal on
reconnect) drops the note or source editor to view mode under a grey strip
reading "This file is read-only now" and discards its unsaved edits (a source
also clears its local drafts without ever reporting Saved, and shows its
latest saved state through the viewer's session); what was saved before
stays. Network and other failures keep the source recovery path.
The frozen copy says the account is read-only, that viewing, downloading and
deleting still work, and to free up space or resubscribe to edit again. The
full copy, and the dashboard grace card's, says files are view-only and
nothing new can be added until space is freed or the plan upgraded (grace:
resubscribed), while renaming, moving and deleting still work.

TanStack Query's `onlineManager` pauses network work until connectivity
returns; loading UI should describe that it is waiting rather than escalating
the pause to an error.

## Streaming failures

Chat SSE failures stay on the assistant turn. A `response_flagged` error clears the current answer and citations and shows the localized "Response flagged due to safety concern" notice. Its code is saved in message metadata so history reloads keep that notice; completed tool activity remains visible. An explicit `error` frame
(including `ai_unavailable` when the retrieval handshake fails), and a
stream that closes before a terminal `done` frame, both mark that turn as errored;
they do not crash a page boundary or emit the default mutation toast. A
`model_unavailable` (422) response before the stream opens is the same surface,
with copy that sends the user to Settings → LLM. So are the two curate
refusals, both 400 before the stream opens: `curate_mismatch` when the request
disagrees with the mode the chat was created in (either direction), and
`curate_requires_editor` when the actor cannot write to the workspace. A
rejected or unclear user
provider key (`invalid_llm_key` / `llm_key_failed`, or the matching stream
`invalid_key` / `key_failed` frames) stays on that same chat/editor/quiz
surface and asks the user to check the key. The one events stream
(`useEventStream`, mounted by `AppShell`) updates cached connection status,
reconnects with backoff, and raises the status banner while a connection
attempt fails; the server's bounded stream lifetime ends cleanly and
reconnects without the banner. An ingest `pending` or
`processing` event updates the file row in place; a `failed` event updates
the affected file state and triggers a refetch. A file that finished without
retrieval chunks (`indexed: false`, including ingest failure and
`parseMode=none` store-only uploads) still renders its viewer. The center pane
shows a status strip (`[data-testid="file-not-indexed"]`) under the header
instead of replacing the body with a full-page error.

File and material banners share `FileBanner`: a flat full-width strip with no
leading icon and `text-fg` on a grey (info, ingest progress, newer version,
maintenance pause) or red-tint (error) background, `role="status"` or
`role="alert"` respectively. Its close button hides it until the message
changes or the page remounts it. Actions are small ghost underlined buttons on a
new line, aligned right. An Office or text source opened in edit mode while the
maintenance pause refuses the session falls back to view mode in the same frame
and shows the pause as a grey strip. Office recovery and pause strips render
directly under the file header, above the page-count row. The PDF annotation
write error renders under the PDF toolbar, outside the scrolling pages, through
a portal target like the annotation toolbar's, the same toolbar-then-scroller
layout the note editor uses.

A signed-in tab holds `GET /api/stream` open for its whole life, with
`?workspace=` set on the workspace page. It carries three named SSE events:
`notification` (patched into the notification caches), `ingest` (patched into
the file caches) and `tree` (`{kind: files | materials}`, which invalidates
that workspace list plus the chapters list after a 300 ms trailing debounce
per kind, so one ingest's several writes cost one refetch; a hidden tab only
marks them stale and reads them on focus). Neither Redis Pub/Sub nor Postgres
NOTIFY replays missed events, so every successful connection refetches the
notification list, the unread count, and the file, material and chapter
lists. There is no polling while disconnected; the workspace lists keep only
`refetchOnWindowFocus`. A list read carries the client-only `ingestPct` over
for rows still ingesting, and one that finds a ready or failed file
invalidates its cached detail if that detail still says pending or
processing, which repairs an open viewer after a missed terminal event.

## Chat tool results

A tool block ends with an `outcome` (`succeeded`, `refused`, `failed`) and,
for mutations, `effects` with the touched resource. Failures carry a stable
error code that `toolErrorMessage` localizes; an unknown code falls back to the
generic tool failure copy. `invalidateForEffects` refreshes the affected
queries (files, materials, trash) when a receipt lands. A refused Undo
(`stale_target`, `unavailable_target`, `undo_unavailable`) shows its localized
message under the result card without the mutation toast.

## Development scenario panel

Run Vite with MSW enabled. Each **User scenarios** button prepares dedicated
fixtures, opens the real application page or product dialog, performs the edit
or submission, and injects its failure through MSW or the collaboration mock.
There is no Apply step. The panel reports a setup failure if a required control
or response cannot be reached. It does not render a replacement error component.

**Run again** starts the journey afresh. **Reset** closes its editor, clears its
fixture drafts and temporary faults, and returns to Workspaces. Temporary faults
are retired after the application renders their result, so the next explicit
Save or Retry can succeed. Permanent permission/account states survive reload
until Reset. Pending imports keep polling until Reset closes their dialog.
Reload remembers the selected button but does not replay actions.
Explicit source fixtures retain their checkpoint identities and epochs in
session storage; their drafts use the real IndexedDB code in the separate
`capy-source-drafts-msw-scenarios` database. Ordinary MSW source files continue
to skip durable drafts.

Actual onboarding, source import, workspace settings, task, and transfer dialogs
remain available. Artificial error-container and toast galleries have been
removed. File/material buttons open the normal workspace header and viewer;
Page not found navigates to an unmatched application URL. Auth uses the local
MSW shim and does not send entered credentials or photos to Clerk.

Storage status journeys set the account and workspace responses the server
would send (`/me` and workspace `storageOwnerState` / `storageOwnerUsage`,
workspace, material, quiz and flashcard `canEdit` / `canEditContent`,
workspace `canClone`) and open the
dashboard, the own workspace, a shared workspace as a member, `/workspaces`
for the frozen create controls, or the invitation page. Frozen scenarios answer
every write the server refuses with `account_over_quota` (`frozenWrites` in
`src/mocks/scenarios.ts`: everything but reads, whole-item deletes, narrowing,
transfer, chat, quiz attempts, notifications, billing, account settings and the
question bank; a member of a frozen owner only on that owner's content).
Full and grace scenarios answer content writes (comments, PDF marks, quiz and
card content) and creation (materials, uploads, imports, editor assets,
generation, embedded and standalone items, and the viewer's own clones) with
`storage_quota_exceeded` only where the full account pays (the viewer's own
workspaces and standalone items in the own-account scenarios), with the
numbers only for the viewer's own account, and leave organizing and study
progress open (`viewOnlyContent` in the same file). The two
"frozen while editing" journeys and the "storage full while editing" journey
type into an open note or text source (the source journey saves one edit
first), switch the account to frozen or full and then send the collaboration
service's `room-read-only` message, whose refused edit never reaches the mock
room; the editor drops to view and discards the typed edit. Mock text saves do
not publish: view mode reads them from `source-session?view=true`
(`savedSourceState` in `src/mocks/collaboration.ts`).

Offline and reconnecting buttons only preview application status. Real network
loss requires Playwright browser offline emulation; public summary failures
require the site worker tests. Feature-flagged pages keep their existing gates.
When the application suppresses an error or a parent guard handles it first,
the journey explains that behavior instead of inventing an inner error state.
See the [coverage audit](msw-scenarios-audit.md) for those limits.

## Stable test selectors

- Error surface: `[data-error-surface="page"]` or
  `[data-error-surface="panel"]`, also carrying `role="alert"`.
- Offline/reconnecting status: `[data-connection-status="offline"]` or
  `[data-connection-status="reconnecting"]`.
- Non-disclosing shared-resource state:
  `[data-testid="private-or-unavailable"]`.
- Development panel: `[data-testid="mock-scenario-panel"]`.
- Unindexed/failed source file banner: `[data-testid="file-not-indexed"]`.

Playwright tests should use `expectErrorSurface(page, variant, text?)` from
`e2e/helpers/errors.ts` instead of duplicating selector details.

## Collaborative source failures

Source editors expose connecting, reconnecting, saving, saved, offline,
unsaved, error and recovery states, shown in the header like the note editor's
(see [plate-editor.md](plate-editor.md#connection-lifetime-and-refusals)).
Saved requires an explicit durable checkpoint receipt. A failed save the
server retries keeps the mounted editor and its pending receipts, shows Not
saved and raises the failed-save toast; the retry's receipt brings Saved back.
A save refused for good (an engine failure, a 401/403/404/409/413/422 from the
gateway, the byte limit) discards the room and resets the editor to the last
saved version with the "couldn't be saved and were undone" toast, clearing its
drafts; a storage or frozen refusal at save drops every writer to view under
the read-only strip. A trashed or deleted file, or lost access, replaces the
editor with the file-missing or no-access panel. Draft storage failures
(private mode, a full disk, a missing draft base) never block editing. Error
strips carry localized copy only. An epoch
change reloads a fully acknowledged editor; unacknowledged edits instead enter
recovery with draft download and explicit discard of the displayed draft group.
Discard checks versions, preserves newer writes from another tab and advances
through remaining groups before reconnecting to the current file.
Failed processing does not invalidate saved edits,
and credits are required for processing rather than persistence.

Chat `pending_sources` events show when edited source evidence is awaiting
processing. If exact pending evidence exceeds the request budget, the message
warns that source information may be outdated and offers Process file changes.
Generation returns `context_too_large` with the same action instead of silently
using incomplete pending evidence.
If a published source changes while an answer or generation request gathers
evidence, `source_changed` asks the user to retry. The Go relay preserves both
codes for HTTP responses and chat events; neither starts an automatic retry.

## Cloud source pickers

Google Picker temporarily replaces the source chooser so the Radix focus trap and pointer lock cannot intercept it. The chooser returns on cancel/error or while selected files are inspected. Google multi-select and folder selection are enabled; folders are expanded by the gateway before the source details step. Import clicks check file grants separately from login connections: Google needs `drive.readonly` or `drive`, Microsoft needs `Files.Read`. Missing grants request consent through Clerk's `additionalScopes`; login/signup uses only baseline scopes. Consent returns to the current page, where the user can reopen the importer. Both provider buttons stay disabled while a picker is opening or active.

Picker startup failures and Google `error` callbacks produce a toast and a frontend Sentry event tagged `component=source-picker`, `provider`, and `stage`. Telemetry uses a fixed message rather than the provider payload, which can contain OAuth tokens and file names. Internal HTTP failures in Google's cross-origin iframe are only observable when Google forwards an error callback; they never reach gateway Sentry.

### Sentry ownership

React 19 root error callbacks report caught and uncaught render crashes. Custom
error boundaries continue to render their existing recovery UI without another
capture call. Sentry filters `ApiError` events, since backend responses and
stream failures are reported by their owning service. Mutation toasts do not
report them again.

Biology 101 also exposes file states through ordinary source rows: empty bytes,
unsupported legacy files, link and PDF/CSV/audio/image errors, Office/text-session
errors, annotation-load failure, and pending/processing/failed/store-only ingest.
PDF document/page failures use `FileError`; retry reopens the PDF and requests
fresh links. Annotation tools mount only after a PDF loads. Their separate error
means saved private highlights/shapes could not load, not that the PDF failed.
The mock annotation API persists reads/writes locally.

Workspace invitations render in the auth main/Panel layout outside `AppShell`.
`AuthGate` handles client authentication and preserves the invitation return URL.
The ownership-transfer developer preview renders the shared confirmation alone.
Workspace statistics are a settings tab, reachable from owner/editor card menus.

File previews use `FileError` for Office, CSV/TSV, text/Markdown/JSON, image,
audio and PDF failures. Manual retry refreshes signed links and restarts only
the preview, even when the URL is unchanged. CSV/text retries retain their
`SourceTextView` session. Office retry is view-only and reloads the source
session, bytes and iframe. The Office iframe reports errors to the host,
which owns error presentation; recoverable errors keep editors mounted.
PDF annotation-load failures use `userToast` with Retry to refetch private marks
without reloading the PDF. The file viewer reports the request failure even
while PDF bytes are loading or the PDF cannot render. Repeated failures reuse one toast per file; recovery
or closing the viewer dismisses it. Office/text recovery and PDF annotation
write errors use `FileBanner`, with recovery actions passed as `actions`. Statistics and
indexing tabs share an `ErrorState` panel with normalized copy and manual retry.

Non-toast error actions use `ErrorAction` from `Button.tsx`: ghost-hover with the
left Hugeicons refresh icon by default. Back, download and discard actions select
their own semantic icon. File errors no longer override button
radius or weight. User scenarios reaches these controls through application failures; the panel
does not mount standalone error-container previews.

`userToast` uses a compact inline layout with a dark filled action button
centred vertically, a small round close button on the top-left corner and 8px
gaps (6px on narrow screens).
Descriptions render only when present. Default, success, warning and error
backgrounds use 70% opacity; text and status icons remain opaque. Error entrance
motion, toast IDs, action callbacks and dismiss behavior are unchanged.

User scenarios → Workspace files and materials opens real Biology 101 file or
material URLs. Fixtures appear in the normal file tree and survive reloads;
seeded material failures include load, decode and diagram-render errors.

General error displays and warning banners default to `error` (`Alert02Icon`).
The icon map no longer includes `warning` or imports `AlertCircleIcon`; warning
toast/callout variants retain their colors and use the `error` glyph.
`FileError` and `FileEmpty` use `fileError` (`FileExclamationPointIcon`); file
banners carry no icon. `FileError` accepts an icon override: note edit-permission
failures use `securityWarning`, while user-info and collaboration-service
failures use `error`. Normalized network/offline and permission icons remain
specific to their causes.
