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

Abort errors and account-blocking errors are also excluded from the global
mutation toast. Toast IDs are derived from the normalized error kind, so repeated
failures of the same kind update/deduplicate instead of stacking. The global
Toaster displays at most three toasts.

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

Public workspace summaries at `/w/:id`, including redirects from
`/share/workspaces/:id`, render on the server. Upstream HTTP 401, 403, and 404
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

`ConnectionBanner` exposes offline state as
`[data-connection-status="offline"]`. TanStack Query's `onlineManager` pauses
network work until connectivity returns; loading UI should describe that it is
waiting rather than escalating the pause to an error. Stream disconnections use
the related `reconnecting` status.

## Streaming failures

Chat SSE failures stay on the assistant turn. An explicit `error` frame
(including `ai_unavailable` when the retrieval handshake fails), and a
stream that closes before a terminal `done` frame, both mark that turn as errored;
they do not crash a page boundary or emit the default mutation toast. A
`model_unavailable` (422) response before the stream opens is the same surface,
with copy that sends the user to Settings → LLM. A rejected or unclear user
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
shows a pinned status banner (`[data-testid="file-not-indexed"]`) under the
header instead of replacing the body with a full-page error.

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

Run the Vite development app with MSW enabled (the default, or
`VITE_USE_MSW=true`). Open **Error scenarios** in the lower-right corner, choose
a scenario, and apply it. Applying first resets previous runtime overrides, so
only one scenario is active. **Clear** restores the normal mock handlers.

The offline scenario drives TanStack Query's `onlineManager`; clearing, changing
scenario, or unmounting the panel restores online state. The two boundary probes
throw a regular render error and a chunk-load-shaped `TypeError`. The probes
intentionally replace the root UI, so use Retry/Reload or refresh afterward.

The panel is not mounted in production or when `VITE_USE_MSW=false`.

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

Source editors expose connecting, saving, saved, offline, error and recovery
states. Saved requires an explicit durable checkpoint receipt. Recoverable
failures retain the mounted editor and actor-specific local draft. An epoch
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
