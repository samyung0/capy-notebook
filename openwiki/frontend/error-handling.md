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

### Gateway upload codes

The gateway's upload line answers two typed 4xx codes the browser gives their
own copy, as both title and description, so the transfer row (its title) and
the note placeholder (`errorCopy`) show it inline:

- `upload_timeout` (408): the upload's body took past its deadline (30 s plus
  its size at 100 KB/s, at most 5 minutes), shown as "The upload took too
  long. Try again." Its kind is
  overridden to `network` (a coded 4xx otherwise reads as `unknown`, which
  `errorCopy` replaces with its fallback). A connection dropped before the
  answer is an ordinary network error.
- `upload_ticket_gone` (410): the upload's turn passed, or a restart or a
  deploy forgot its ticket ("Your turn to upload passed. Try again."). Its
  kind is overridden to `validation`.

### Error ids where the error stays

An unexpected failure (`unexpectedErrorId` in `src/lib/errors.ts`: an API 5xx
without one of the typed codes `provider_busy`, `ai_unavailable`,
`generate_empty`, `bank_unavailable`, `upload_queue_full` (the gateway's
upload line is full: busy, try again), `rate_limit_unavailable`,
`captcha_unavailable` (siteverify could not check a signed-out answer check;
the quiz shows it under the question's Check with `captcha_failed`), or an unknown status
without a code)
shows its request's trace id as a small (`text-xs`) "Error ID: …" line under
the Retry action, spaced well apart from it (`ErrorId`). It has no copy button:
one click selects the whole line (`select-all`) so a user can copy and quote it,
and an operator can find the logs and Sentry event. Only the surfaces where the error stays on screen show
it, through `ErrorState`'s `errorId`:

- boundary screens (`AppErrorBoundary`, `RouteErrorComponent`);
- a page or pane whose read failed, with Retry: the dashboard's recent
  workspaces, the billing usage and invoice tabs, the workspace statistics tab,
  the question bank, a review session, a quiz result, a file's download links
  or an Office file's view session (`FileError`'s `errorId`) and a note's
  collaboration token;
- form errors (`FormAlert`'s `errorId`);
- a failed row in the workspace settings Indexing tab (file or note
  changes and Failed files, Epo 2026-10-21), under the row and aligned with
  its name: the failure's id from the payload's `errorId` (below), never its
  text.

Typed refusals, exceptions without a request, toasts and status banners show
none. The id comes from `ApiError.traceId` (see the trace id in
`observability-metering.md`).

### Form dialogs keep their errors

A dialog that submits a form (the clone dialogs, `CloneItemDialog` and
`CloneWorkspaceDialog` through `WorkspaceFormDialog`) reports a refused submit
inline, not as a toast, so the draft and its context stay on screen:

- The confirm button shows a spinner and the dialog stays open while the
  request runs; Escape, an outside click and the close button do nothing then.
- A typed refusal about one field shows under that field (a taken title,
  `title_taken`).
- Anything else shows in `FormAlert` (src/components/ui/FormAlert.tsx) at the
  bottom of the form; `cloneErrorMessage` maps storage, plan-cap, credit and
  access refusals to their copy. An unexpected failure adds its error id.
- Such a mutation opts out of the global toast (`errorToast: false`), so the
  failure is reported once.

A file's trash confirmation (`TrashConfirmDialog` from `ContentActions`)
follows the same rule: it stays open with a spinner while the delete runs
and shows a refusal in its `FormAlert` (`trashErrorMessage`), such as an
audio file still being transcribed (`audio_transcribing`).

## Input length limits

Limits come from the backend (`server/internal/fieldlimits`, generated into
`src/api/gen/validators.ts` as `*Max` and `src/api/limits.generated.ts`).
Counts are Unicode code points (`textLength`), matching the backend's runes.

- A titled field passes `count={{ max, value }}` to `InputTitle` (or
  `InputField`, or the question editor's `Field`). `CharCount` shows `72/80` at
  the right end of the title row from 90% of the limit (`from` overrides it, the
  workspace tags show from 4 of 5) and turns the error colour at or over it. The
  limit is soft: no `maxLength`, so pasting is not cut; the form's zod
  validation marks the field and disables Save.
- An untitled field with a limit gets a silent `maxLength` (searches, the new
  chapter name, the AI prompt at 4,000, link URL/text, short and gap answers at
  1,000).
- Long free text without a title shows `CharCount` under the box: chat (5,000,
  send disabled when over), note comments (3,000, enforced by the API on the
  paragraphs' text plus breaks) and quiz open answers (5,000, also capped with
  `maxLength` so a 422 from grading never happens).

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
the first wave. `/me` alone refetches on every window focus, stale or not, so
plan and account banners follow a plan change made in Checkout, the billing
portal or another tab when the user returns.
File and material detail queries also use five seconds, but retain the global
disabled focus refetching. Reopening stale details refreshes them; live material
editing continues to receive content through Yjs.

The query client throws a query error to the nearest boundary only when the
query has no cached data. A failed background refresh therefore keeps rendering
the last usable result. Secondary and optional queries must opt out with:

```ts
meta: { errorBoundary: false }
```

A page whose resource can be private or missing (workspace, flashcard study and
edit, quiz attempt) uses `meta: { errorBoundary: 'unlessMissing' }` instead: 401 and 404
stay in the page as the non-disclosing private-or-unavailable state, and every
other failure without data goes to the boundary with its normal copy and Retry.

The owning component must then destructure and render the relevant query error
state. Destructuring is required so TanStack Query's tracked-property proxy
subscribes to those fields. A list that fails without data must never fall
through to its empty state ("No workspaces yet" reads as data loss after a
redeploy): a region that fills a page or a page tab renders `ErrorState`
`variant="panel"` with Retry (Trash); anything smaller, and anything inside
a dialog, renders `InlineErrorState`, one bold line and Retry (the dashboard
recent workspaces and recents card, search results, Billing's invoices under
the plan and its Details table, a question bank page that failed between loaded
questions, workspace settings' Statistics tab and member list). Billing's Details table drops its loaded rows when any page fails,
next pages included, and shows only the inline error. The /notifications page
leaves its list to the route boundary.
Filter and picker options may stay silently empty.

Query metadata is shared by observers of the same key. A secondary consumer
must preserve the primary consumer's error policy. The ingest hook takes the
workspace page's loaded files rather than adding an observer with a different
policy. The Files preview dialog handles its detail-query failure inline with
`FileError` and a manual Retry action.

Paged page lists (Files, Blocks, Trash, Learning's Past reviews and All
results) end with `ListEnd` (`src/components/app/ListEnd.tsx`): the next page
loads once the end is within 800px of the page panel's bottom. A page that
still fails after the default query retries stops loading there, with Load more
as the manual retry; the rows already loaded stay.

Mutation failures produce an error toast by default. A mutation that renders its
own inline error, needs domain-specific messaging, or treats cancellation as
normal must use:

```ts
meta: { errorToast: false }
```

Copy comes from paraglide only, chosen by error code: the browser keeps any
snake_case code Huma sends in `errors[].message` (`parseErrorBody`), and
`describeError` maps known codes before falling back to the status class.
Huma's own request errors (schema validation, an unparsable body) name a
`location`, carry no `value` and number at most 10; a typed code keeps its
`value`, which `parseErrorBody` spreads into the error.
`errorCopy(error, fallback)` never returns an error's own text; `CopyError`
carries already-localized copy. A 409 always names its conflict:
`revision_conflict` (a stale revision: someone else changed it first, with
Reload) is distinct from `account_deletion_busy`, `subscription_exists`,
`subscription_active`, `account_state_changed`, `clone_source_changed`,
`title_taken`, `transfer_self` and `nothing_to_process`. The Go store's
specific conflicts wrap `ErrConflict`, so internal callers still see a
conflict. Zod's own messages follow the UI locale (`z.config` in
`src/i18n/index.ts`), and question validation throws or reports paraglide
copy.

`too_many_ingest_leases` is kind `ingest`, distinct from `llm_credits_exhausted`
and `too_many_streams`. An upload is never retried by the browser: one past
the upload rate class waits in the gateway's upload line and its row shows
its place (Epo 2026-10-24, Q282; backend-storage-quota § upload line), and
any refusal fails its row. An import request gets 3 attempts in all after a
network error, 408, 429 or 5xx, waiting out `retryAfterSeconds` (at most
30 s) (`src/features/workspace/sourceImport.ts`). The add-source dialog
toasts it and keeps the unsent tail. Do not map it onto credits or the file-cap copy.

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
Warnings and errors last twelve seconds; other toasts with a button last seven,
and the rest keep Sonner's four-second duration (`userToast`).

## Persisted query cache

A page paints from the signed-in account's last visit while it refetches
(`src/api/queryPersistence.ts`, 2026-10-11). It is for speed on a page visit,
not offline use: without a service worker the app itself does not load offline.

- Opt-in per query: a definition spreads `persisted`, whose 7-day `gcTime` keeps
  a restored query until it is used and marks it for storage. Query `meta` cannot
  carry the mark, because hooks replace it with `queryMeta(options)`.
- Stored: `/me`, workspace lists (not searches), a workspace and its chapters,
  files, materials, conversations and study states, file metadata, the
  dashboard recents, Thinking, notifications and the unread count, learning
  progress, the review overview, quiz attempts (the quiz page resumes its open
  one from it), calendar events, labels, tasks, tags,
  notification preferences, integrations, models, LLM key last-4s, Explore,
  and the question bank's syllabus and progress. Infinite lists keep their first
  page.
- Never stored: file, note, quiz, card and canvas bodies and chat messages
  (always fetched live), collaboration tokens, presigned links, review sessions,
  answer keys (quiz and bank edit views), ingest slots, workspace stats, upload
  policy, billing, usage, account deletion preflight, searches, members and
  discussions.
- One IndexedDB entry (`keyval-store`, key `capy-query-cache`), written at most
  once a second and at `pagehide`. Its buster is `VITE_RELEASE_SHA` plus the
  user ID: a new release, another account, or an entry older than 7 days is
  discarded. Signing out deletes it. Edit drafts live in their own database and
  are not touched.
- Restored queries are marked stale, so each refetches on first use regardless
  of `staleTime`. A stored query whose refetch answers 401 or 404 drops its data,
  so a workspace the account lost shows the private state, not last visit's copy.
- Deleting a workspace drops its cached queries once its page is left (the
  settings dialog leaves for `/workspaces` first, or the open page would refetch
  them), so Back to it fetches and shows the private state.
- MSW development stores nothing: the mock database resets on reload.

## Boundary tiers

- The root `AppErrorBoundary` protects the router and development probes. It
  renders a full-page fallback and recognizes chunk-load errors as requiring a
  reload, except while offline, when any failure reads as offline.
- Router error components protect route-level lazy loading and loader/render
  failures.
- Feature and pane boundaries protect independently recoverable regions such as
  workspace center content and editors.
- Expected primary-resource failures may use an explicit inline page/pane
  surface when the component has a tailored recovery path.

Resetting a boundary also resets TanStack Query's error state before retrying.

A page has one main landmark. `AppShell` owns it and marks its children with
`InShellMain`, so a boundary or router fallback rendered inside the shell
(a pane boundary, a route error or not-found) frames itself in a plain `div`;
outside the shell (the root boundary, a public route) the fallback is the
`main`.

A route chunk the deploy removed (a missing `/assets/*` name is a 404
`no-store` from the assets Worker, deployment-runbook §1) fails as a
chunk-load error: the router reloads once, then shows "An update is ready"
with Reload.

A page whose entry script, a chunk it needs or a stylesheet fails to load
while the boot spinner shows (a fresh load in the deploy window, whose old
`index.html` names files the new release removed, or any later failed entry
load) shows the same message from `index.html` itself (Epo 2026-10-17). A
classic inline script there, which runs before the entry and stays out of
the bundle, waits for a load error from a same-origin module script,
`modulepreload` link or stylesheet link and replaces the spinner with the
title, body and Reload in the app's locale (the stored Paraglide choice,
then the browser's languages). A file in `<head>` that fails before the
body is parsed shows it once the document turns interactive. The entry
waits for the head's stylesheets, so after a failed one it still runs; it
then finds the message in `#root` and does not mount the app
(`src/main.tsx`), which would otherwise boot unstyled over it. The
script's English and Chinese strings are copies of `error_chunk_title`,
`error_chunk_body` and `error_action_reload`
(`e2e/editor/boot-failure.spec.ts` fails if they drift). Cross-origin
files, other scripts, and any failure after React's first render leave the
page alone. The SPA's report-only script policy allows the script by its
hash (`vite-image-policy.ts`), so it sends no reports. The theme script
before it is classic and inline too, so the spinner and the message use
the chosen style and theme from the first paint (Epo 2026-10-17); Vite
would bundle a module script into the entry.

An open tab stays usable when the connection drops (Epo 2026-10-17). A page
change whose code is not loaded yet fails offline as an `OfflineError`
(`lazyPage` in `src/router.ts`) instead of TanStack's reload, which would
land on the browser's offline page: the route's error component shows the
offline state inside the shell. Retry and reconnect reset the boundary and
reload the route (`router.invalidate()`). The browser keeps a failed import
for the document, so back online that retry fails again as a chunk-load
error and TanStack's one reload loads the page, now online. The release
nudge's page load waits for the connection the same way (plate-editor
"Client protocol and the release nudge"). The check is `navigator.onLine`:
a connection that is down while the browser reports online still takes
TanStack's reload.

## Shared-resource security

Public workspace summaries at `/w/:id.:signature` render on the server. Unsigned or
forged paths, and upstream HTTP 401, 403, and 404, all produce the same “Page not found” HTML with HTTP 404, `no-store`,
and `noindex, nofollow`. The server renders the shared page `ErrorState` and the client hydrates it. Do not
include resource names, server details, or different actions that disclose
which case occurred. Worker tests inject upstream failures; browser tests
compare actual private and missing workspace summaries because browser route
interception cannot intercept the server's summary fetch.

Workspace invitation acceptance uses the same non-disclosing surface for an
invalid link or unavailable workspace. Network and server failures keep the
invitation panel visible with inline error copy and a retry action. The mutation
does not also emit a global toast. On the owner's side, sending an invite and
cancelling a pending one render their failures inline under the form and the
pending list (`FormAlert`) instead of the global toast, and a pending list
that fails to load shows an inline error with Retry in its section rather than
reading as "nothing pending".

A few routes answer 404 rather than a false success (Epo 2026-10-21): deleting
a label, event or task that is missing or someone else's, and marking a
notification read that is not the caller's (re-reading one's own read
notification stays a 204). `useDeleteLabel` treats the 404 as already deleted:
no toast, and the label list refreshes. Creating a quiz whose questions fail
validation answers 400 with the reason; generated content failing validation
stays a 500.

## Offline and paused work

Nothing app-wide sits above the page, so connection and account state never
shift the layout. The dashboard banner slot (`DashboardBanner`) shows only the
viewer's own account, one tinted card with a faint icon at a time, and is
empty otherwise:
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
goes offline there). Coming back online after that replaces it with a success
toast ("You're back online"); arriving online shows nothing. The status is the viewer's own account from `/me`, since
what the viewer adds is charged to the viewer (uploader pays, Sam 2026-10-18):
frozen ("Account frozen"), full, grace counting as full ("Your storage is
full"), then near the limit ("Your storage is almost full"). Near uses the
warning toast, full and frozen the error toast. Another account's full storage
shows on the items it pays for instead: they open view-only under a strip
below the item's header ("Owner of the file has insufficient storage.", or
"Your storage is full." when the viewer pays), from the material's, the source
session's or the file links' `storageFull` (`StorageFullBanner`). The file header status
slot shows the save state, or `wifiOff` while offline
(`[data-connection-status="offline"]`) for every file type. The workspace
status triangle (`[data-storage-status]`) sits to its right, amber near the
limit and red when full or frozen; its tooltip is the status title and it
opens the same details dialog as the toast's Details action. With no file
open, the header shows both icons after the workspace picker and no strip.
Frozen read-only and view-only at the storage limit need no client logic
inside workspaces: the server's capabilities drop `canEdit` for a frozen
account, so edit mode, comments and create controls disappear, and
drop only a material's `canEditContent` while its payer is at or over its
limit (full or grace), so edit mode, comments, PDF marks and quiz or card
edits disappear while rename, move and delete stay. `?mode=edit` falls back to view in both.
A write that still meets `account_over_quota` or `storage_quota_exceeded`
inside a workspace (a stale capability, or creation at the limit) shows only
the workspace status toast: `deferStorageRefusal` (in `src/lib/errors.ts`,
called first by the mutation cache and by surfaces with their own error toast
or strip: the source transfer runner, sharing, clone, note media uploads, the PDF
annotation strip and the generate panel) hands each refusal once to
`WorkspaceHealth`. A quota refusal carries its numbers only for the charged
account, so one without numbers is another payer's item and keeps its own
toast, worded like the strip. The
`quota_blocked` analytics event is recorded before the deferral (by the
mutation cache, or by the source transfer and clone surfaces for their own).
`WorkspaceHealth`'s `refusalHandler` refetches the workspace and
`/me` and shows the status as a new toast (fresh id including the status
kind, full timer). Refusals arriving while that refetch runs share its toast. If the
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
stays. Network and other failures keep the source recovery path. A note,
mindmap or diagram whose stored document the store would refuse (a block
the embed catalog does not list, ...), or a quiz holding a block kind its
rooms do not admit, joins its writers read-only with `code:
unsupported_block`, and the strip reads "This document has a block this
version of Capy can't edit, so it opens read-only" (a quiz editor shows its
questions to read under it; openwiki/embeds.md).
The frozen copy says the account is read-only, that viewing, downloading and
deleting still work, and to free up space or resubscribe to edit again. The
full copy, and the dashboard grace card's, says files are view-only and
nothing new can be added until space is freed or the plan upgraded (grace:
resubscribed), while renaming, moving and deleting still work.

TanStack Query's `onlineManager` pauses network work until connectivity
returns; loading UI should describe that it is waiting rather than escalating
the pause to an error. A paused query is not loading (`isLoading` is false), so
a page gated on it checks `waitsForConnection(fetchStatus, data)`
(`src/lib/online.ts`) before its missing state and shows `QueryPausedState`;
the workspace page does this, so opening a workspace offline reads "Waiting
for connection", not private or unavailable. The waiting state is only for a
query without data (Epo 2026-10-17): a page or list holding data, such as a
stale or restored list whose refetch is paused, keeps showing it. Quiz
attempts and flashcard study read fresh on purpose (`fresh: true`, drawn only
after a read in this visit) and keep their waiting state while paused.

A query that throws to `AppErrorBoundary` or `RouteErrorComponent` loses its
observer, so neither `refetchOnReconnect` nor the event stream's reconnect
refetch reaches it. Both boundaries therefore retry by themselves when
`onlineManager` comes back online. Retry, manual or on reconnect, resets every
query that failed without data, not only the thrown one: a route loader's failed
prefetch has no observer yet, and its component would otherwise rethrow the
cached error without fetching once it mounts. A query whose refresh failed keeps
its data and is left alone, so the stale view stays on screen.

## Streaming failures

Chat SSE failures stay on the assistant turn. A `response_flagged` error clears the current answer and citations and shows the localized "Response flagged due to safety concern" notice. Its code is saved in message metadata so history reloads keep that notice; completed tool activity remains visible. An explicit `error` frame
(including `ai_unavailable` when the retrieval handshake fails), and a
stream that closes before a terminal `done` frame, both mark that turn as errored;
they do not crash a page boundary or emit the default mutation toast. A
`model_unavailable` (422) response before the stream opens is the same surface,
with copy that sends the user to Settings → LLM. A
rejected or unclear user
provider key (`invalid_llm_key` / `llm_key_failed`, or the matching stream
`invalid_key` / `key_failed` frames) stays on that same chat/editor/quiz
surface and asks the user to check the key.

Stop is a request, not a dropped connection (Epo 2026-10-21): the button calls
`POST /api/conversations/{id}/messages/{messageId}/stop` (`useStopChatTurn`)
and only then stops reading the stream (`turnStopper` in `useChatStream.ts`),
so the turn shows "Stopped" and history already lists it aborted. Pressed
before the `start` frame names the turn, the request goes once it does. A
stop request the server refuses shows the default mutation toast and the
stream keeps running, for another press; one that cannot reach the server
(a network error, no HTTP status) toasts too but stops reading anyway, since
the server finishes the turn regardless. Closing the tab or losing the network does not
stop a turn: the server finishes and saves it, and reopening the conversation
shows it once it ends. The one events stream
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
leading icon and `text-fg` on a grey (info, ingest progress, a text source's
newer version, maintenance pause) or red-tint (error) background, `role="status"` or
`role="alert"` respectively. Its close button hides it until the message
changes or the page remounts it. Actions are small ghost underlined buttons on a
new line, aligned right. The save banner uses its one-row form (`inline`): the
message scrolls sideways without a visible scrollbar (`scroll-fade-x`, the
note toolbar's scroller and `useHorizontalWheelScroll`), and its action takes
the close button's place, so every save banner state has the same 40px
height. The maintenance pause strip (and a text source's newer-version strip;
Office swaps instead) uses the same one-row form, with Reload in the close
button's place. The center pane shows one strip
at a time: `CenterContent` wraps each open item in a `BannerStack`, and only
the newest strip mounted inside it shows (a strip whose message changes counts
as new); closing or unmounting it reveals the one before. An Office or text source opened in edit mode while the
maintenance pause refuses the session falls back to view mode in the same frame
and shows the pause as a grey strip. Office recovery and pause strips render
directly under the file header, above the page-count row. The PDF annotation
write error renders under the PDF toolbar, outside the scrolling pages, through
a portal target like the annotation toolbar's, the same toolbar-then-scroller
layout the note editor uses.

A signed-in tab holds `GET /api/stream` open for its whole life, with
`?workspace=` set on the workspace page. It carries three named SSE events:
`notification` (read and removed events patch the notification caches; a
created event refetches the list and the unread count, because the list joins
each row's workspace and member for its icon), `ingest` (patched into
the file caches) and `tree` (`{kind: files | materials}`, which invalidates
that workspace list plus the chapters list after a 300 ms trailing debounce
per kind, so one ingest's several writes cost one refetch; a hidden tab only
marks them stale and reads them on focus). Neither Redis Pub/Sub nor Postgres
NOTIFY replays missed events, so every successful connection refetches the
notification list, the unread count, and the file, material and chapter
lists. A connection that succeeds after a failed attempt (a redeploy, a
dropped network) also refetches every active query in error, so the error
states above recover without Retry. There is no polling while disconnected; the workspace lists keep only
`refetchOnWindowFocus`. A list read carries the client-only `ingestPct` over
for rows still ingesting, and one that finds a ready or failed file
invalidates its cached detail if that detail still says pending or
processing, which repairs an open viewer after a missed terminal event.

## Chat tool results

A tool block ends with an `outcome` (`succeeded`, `refused`, `failed`) and,
for mutations, `effects` with the touched resource. Failures carry a stable
error code that `toolErrorMessage` localizes; an unknown code falls back to the
generic tool failure copy. `invalidateForEffects` refreshes the affected
queries (files, materials, trash) when a receipt lands. A refused Undo or
Redo (a 4xx: `undo_unavailable`, `invalid_input`, `quota_rejected`) shows an
error toast with its localized message and disables that button for the
session; no text is added under the receipt. A refusal for a moment
(`office_editing_paused`, `unavailable_target`: the room keeps the step) and an
unknown outcome (no answer, a 5xx) show the toast and keep the button: the
server answers a retry with the step's receipt when the first request landed
(`undoRefused` in `src/features/workspace/chat/trace.ts`). A second click
while a request is out sends nothing.

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
until Reset. Pending imports keep polling in the transfer panel until Reset stops them;
under MSW the import polling budget is 12 seconds, after which the row reads
"Still importing". "Upload parsing fails" and "Upload stored without index"
upload the dialog preview's file and let the mock worker finish it as failed or
unindexed, so the panel reaches those rows through the real flow; mock ingest
progress always ends by reading the outcome from the mock server.
Reload remembers the selected button but does not replay actions.
**New account: every list empty**, first in the panel under Empty states,
answers every list a new account sees (workspaces, files, materials, attempts,
Learning and question bank progress, reviews, notifications, tasks, calendar,
trash, tags, search) with an empty result, and stays on across pages
and reloads until Reset, so each page's empty state can be checked directly.
Explicit source fixtures retain their checkpoint identities and epochs in
session storage; their drafts use the real IndexedDB code in the separate
`capy-edit-drafts-msw-scenarios` database. Ordinary MSW source files continue
to skip durable drafts.

Actual onboarding, source import, workspace settings, task, and transfer dialogs
remain available. Artificial error-container and toast galleries have been
removed. File/material buttons open the normal workspace header and viewer;
Page not found navigates to an unmatched application URL. Auth uses the local
MSW shim and does not send entered credentials or photos to Clerk.

Storage status journeys set the account and workspace responses the server
would send (`/me`, material `storageFull`,
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
loss requires Playwright browser offline emulation; the collaboration mock
follows it (its providers leave the room while the browser is offline), and
`setCollaborationReachable(false)` in `src/mocks/collaboration.ts` keeps the
service unreachable across a reload, so a reopened editor waits for it.
`moveMockMaterialRoom` moves a note's room to its next schema, as a discard
does, for the lineage journey; public summary failures
require the site worker tests. Feature-flagged pages keep their existing gates.
When the application suppresses an error or a parent guard handles it first,
the journey explains that behavior instead of inventing an inner error state.
See the [coverage audit](msw-scenarios-audit.md) for those limits.

## Stable test selectors

- Error surface: `[data-error-surface="page"]`,
  `[data-error-surface="panel"]` or `[data-error-surface="inline"]`, also
  carrying `role="alert"`.
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
saved and the save banner; the retry's receipt brings Saved back.

The save banner (`SaveBanner`, `src/components/banners/SaveBanner.tsx`) is one
strip under the file or note header with one state at a time:
`delayed` ("Saving is delayed. Your recent changes aren't saved yet."); the
offline states (grey `offline`: "Can't connect to Capy. Your edits are saved
on this device and will sync when you reconnect. They may be rejected or
lost."; red `offline-unstored`: "Your edits can't be saved on this device.
Keep this tab open until you reconnect."; grey `offline-limit`: "You've
reached the offline edit limit for this file. Reconnect to keep editing.",
see [plate-editor.md](plate-editor.md#offline-editing-and-drafts)); and the
recovery states `refused` and `changed` (below). Offline takes over from
`delayed` while the room cannot be reached, and recovery from both. `delayed` shows on a server-reported failure with unsaved
work (`source-checkpoint-failed` recoverable, `checkpoint-failed`), and also
when the client's oldest checkpoint request stays unanswered past a threshold,
without waiting for the server's 60 to 120 s timeouts: `SOURCE_SAVE_DELAY_MS`
(45 s; a source room stores at most 30 s after a change) and
`NOTE_SAVE_DELAY_MS` (25 s; a note room at most 10 s), counted in connected
time only (`SaveDelayClock` in `src/features/notes/saveDelay.ts`). An edit is
counted from the request that carries it, sent 1 s after typing stops. Any
receipt clears the banner, since saving works again; it comes back only if
the oldest request still unanswered crosses the threshold. Closing it hides it for that
episode only; the next failure shows it again. A connection still lost after
30 s puts an editor that synced once into offline mode; before the first sync
it shows only the header's red status.

A source save that fails slowly (an Office engine timeout or a dead worker, a
checkpoint that moved again after the reload and merge, a network error or a
5xx, or a 401 from the gateway's internal source routes, which means the
collaboration service's own secret was rejected and is reported on every
failure with the `service_secret_rejected` stage) keeps the room editable: the server retries it with per-room backoff
(5 s, doubling to 60 s; the room's live saves wait out the same backoff), the
editor shows the `delayed` banner and its drafts stay. After
`SLOW_SAVE_LIMIT_MS` (5 minutes) of failed saves without one success, whatever
the cause (a slow failure, a save held back by the backoff, or pending content
waiting for a client's sync, which is never refused by itself), the room takes
the refused-save path below. A save refused for good
(an engine refusal or trap, a rebuild check, the byte limit or 413, invalid
input (422 `invalid_checkpoint`), an editing epoch that ended
(`epoch_changed`, whether the gateway refuses the checkpoint or the session a
retry reloads names a newer epoch; it is never retried and never counts as lost
access)) discards the room at once, and it reopens at the last good save. Each
editor with unsaved edits keeps its drafts, marked refused, and enters
recovery. Refused drafts are never merged back on open (they would replay the
refused state). An editor with nothing unsaved just reloads. A save
refused because access was lost or the file is gone (403/404 for the file,
not for the account itself; `lostAccess` on the failure message) clears the
drafts and reloads to the
file-missing or no-access panel, with no download: the user may no longer see
that content. A storage or frozen refusal at save drops every writer to view
under the read-only strip. A trashed or deleted file, or lost access, replaces
the editor with the file-missing or no-access panel. Drafts are written as
each local edit happens, by a dedicated drafts worker, with the whole document
once per offline episode and at unmount (see
[plate-editor.md](plate-editor.md#offline-editing-and-drafts)). Draft storage
failures (private mode, a full disk, a missing draft base) never block
editing. Error
strips carry localized copy only. An epoch
change swaps a fully acknowledged editor to the new epoch with no strip
(notes and Office, the room swap of
[plate-editor.md](plate-editor.md#room-swap) and
[office-files.md](office-files.md#room-swap)); unacknowledged edits instead
enter recovery, as do drafts of another version found on open.

Every recovery path shows a recovery banner: a save refused for good the
`refused` one ("These changes couldn't be saved. Copy anything you need, then
reload to continue from the last saved version."), and edits from another
lineage (a newer version over unsaved edits, a draft from another version, a
note room that moved on) the `changed` one ("This file changed while your
edits were waiting to sync. Copy anything you need, then reload."). Unsent
edits whose group was last edited over 7 days ago (Epo 2026-10-24; for notes
until the merge view, Q251) open once under the `expired` one ("These edits
are more than 7 days old and too old to sync. Copy anything you need, then
reload."): their rows are deleted as they open (reported as
`draft_unrestorable` / `expired`) and no draft sweep sends them. The
unsaved content stays on screen read-only and selectable, with no download or
discard; a page refresh reopens the same view, except an expired one. A recovery banner has no close
button: its Reload, in the close button's place, is the only way out. It
clears the drafts on display (matching exact rows, so another tab's newer
write stays) and reopens the last saved version, after any other retained
draft group. Notes show the content through the static renderer
(`NoteRecovery`). A text source shows the content in a read-only
textarea. Office recovery sends `set-capabilities` with `selectable`, so the
runtime hands the engine `readOnly` instead of making the editor inert: DOCX
text, XLSX cells and PPTX slide text can be selected and copied. File ›
Download in the Office menus still exports what the editor shows.
Failed processing does not invalidate saved edits,
and credits are required for processing rather than persistence.

Chat `pending_sources` events show when edited source evidence is awaiting
processing. If exact pending evidence exceeds the request budget, the message
warns that source information may be outdated and offers Process file changes.
Generation returns `pending_sources_too_large` with the edited file ids instead
of silently using incomplete pending evidence, and offers the same action for
exactly those files; a plain `context_too_large` is an ordinary failure. The action toasts that processing started,
or that it could not start with the reason (`useProcessFileChanges`).
Processing shows no progress anywhere else; the workspace settings Indexing
tab lists every file with unprocessed edits as waiting, queued, processing
(a spinner) or failed (an alert icon), polling the stats every 3 s while any
file or note is queued or processing. The owner processes a waiting or failed file, or all
of them, and cancels a queued one; a file whose processing started refuses
with `processing_started`. Editors see the same rows and status as the owner
(state, "Edited …", error id) without any action, and the Auto process edits
switch disabled, since only the owner may change it (Epo 2026-10-21). Workspace
notes whose index is behind their content are listed in the same rows with
the note icon and title (Epo 2026-10-21), since a note can wait up to 10
minutes to index; a note row reads like a file row, with no auto-processing
hint (Epo 2026-10-21). A failed note is one parked after its failed jobs,
shown like a failed file. A failed row shows its error id and never the
job's own error text: the stats payload's `errorId`, sent on failed rows only,
is `source_documents.refresh_trace_id` or `materials.index_trace_id`
(migration 0105). Triggers keep it with its failure: when `refresh_error` or
`index_error` is set they take the trace id of the failed job's last
`ingest_job_attempts` row (the ingest worker's per-claim trace, which tags its
logs and Sentry events), and clearing the error clears the id. An export
failure the gateway records for the collaboration service
(`FailSourceRefresh`, and `ClaimSourceRefresh` past two attempts) stores that
request's trace instead, since the export records no attempt, and the gateway
logs one `source refresh failed` warning under that trace with the file id,
job id and failure detail, so the id is found in the gateway logs. A refusal
before any job (the scheduler's 4xx when queuing) stores none and its row
shows no id. A file under Failed files carries its id as `errorId` on the
workspace file list (`GET /api/workspaces/{id}/files`), sent while the file is
failed and only to the owner and editors, who see the Indexing tab; other
file rows never carry it. It is `files.failure_trace_id`, which a trigger sets
when the status turns `failed`: the trace of the last unsuccessful ingest
attempt of a job for the file's revision (the one that failed it or left it
partial; never an earlier successful run's or another revision's), found
through the `jobs ((payload->>'fileId'))` index, and cleared when the status
moves on. An ingest failure's id tags the worker's logs and Sentry events; any
id also finds its row with `WHERE refresh_trace_id=…` / `index_trace_id=…` /
`failure_trace_id=…`, which keeps the error text where one is stored. The owner's Process (Retry when
failed, and Process all) indexes the note at once, also with auto process
off; a `processing_started` answer (queued meanwhile by the scheduler or
another tab) counts as started, and `nothing_to_process` toasts that there
are no saved changes to process. A queued or processing note shows no action,
and there is no Cancel for a note. Notes past the list's cap (the owner's
files per workspace) show as one "Notes not shown" count line under the
list. The source coverage bar counts files only. Chapter-level quizzes and
flashcard sets are not indexed and not listed; an embedded one's edits show
under its note.

A source file whose processing failed (`files.status='failed'`) is processed
again only by its owner: automatic processing never picks it, even with Auto
process edits on (the collaboration scheduler and `RequestSourceRefresh` skip
it unless the owner asked), unless it is partial: still `indexed`, with a part
(the descriptor or a page's VLM read) missing, which the next automatic
refresh of an edited source may fill. The file row's menu offers Retry
processing in the warning tint (`MenuItem.warning`), and the Indexing tab lists
every failed file under Failed files with the same action. For a file that is
not indexed both open the upload dialog in a retry mode (`AddSourceDialog`
`retryFile`): one fixed row read from the stored bytes through the file's
presigned link, so the fast-parse check and estimate run as for an upload, then
`POST /api/files/{id}/retry-processing` with the chosen parse mode. A failed
file that is still indexed retries in one click, with no dialog, no parse-mode
choice and no estimate (parts design Q8, `retryFailedFile`): it sends `fast`,
the route every indexed file was processed on (direct routes ignore the mode),
and a success toast follows; a refusal shows the default mutation error toast.
The file's Retry stays disabled, in both places and per file, until the file
leaves `failed`: each list has one retry mutation (`useRetryFileProcessing`,
keyed per workspace), its settle awaits the files refetch, and
`useRetryingFileIds` lists the files whose mutation is still pending, so a
second click never meets the queued job's 409. The server queues the file's processing again on its stored bytes, charged to
the owner like automatic reprocessing; `none` just stores it, a file that is
not failed or already has a parse, ingest or source refresh job answers 409, a
mode the format does not offer 400 (`RetryFileProcessing`). A partial file
keeps its index and re-runs only its missing parts in its own parse mode (see
[agentic-retrieval.md](../agentic-retrieval.md), "Parts").
If a published source changes while an answer or generation request gathers
evidence, `source_changed` asks the user to retry. The Go relay preserves both
codes for HTTP responses and chat events; neither starts an automatic retry.

## Cloud source pickers

Google Picker temporarily replaces the source chooser so the Radix focus trap and pointer lock cannot intercept it. The chooser returns on cancel/error or while selected files are inspected. Google multi-select and folder selection are enabled; folders are expanded by the gateway before the source details step. Import clicks check file grants separately from login connections: Google needs `drive.readonly` or `drive`, Microsoft needs `Files.Read`. Missing grants request consent through Clerk's `additionalScopes`; login/signup uses only baseline scopes. Consent returns to the current page, where the user can reopen the importer. Both provider buttons stay disabled while a picker is opening or active.

Picker startup failures and Google `error` callbacks produce a toast and a frontend Sentry event tagged `component=source-picker`, `provider`, and `stage`. Telemetry uses a fixed message rather than the provider payload, which can contain OAuth tokens and file names. Internal HTTP failures in Google's cross-origin iframe are only observable when Google forwards an error callback; they never reach gateway Sentry.

## Source transfers

Pressing Upload or Import in the Add file dialog hands the open tab's rows to
`startSourceTransfer` (`src/features/workspace/sourceTransfers.ts`) and closes
the dialog unless the other tab still has rows. The runner lives outside React,
so closing the dialog, navigating away or switching workspace does not cancel
anything. It sends every row even after one fails, in ingest-slot waves as
before, and keeps a zustand store of one entry per file (a picked folder expands
into one entry per imported file).

`SourceTransferPanel`, mounted at the root next to the toaster and painted below
it (and below dialogs), lists those entries: waiting, uploading (bar), importing
(sweeping bar, since import jobs report no percentage), then the file's own
status read from the files cache (queued, parsing with `ingestPct`, ready,
parsing failed, or "not searchable" for a ready file without an index, shown as
neutral information because it is usually a file the user chose not to parse).
Parsing failed reads "AI won't know about its contents" only for a file without
an index; a failed file that is still indexed keeps answering search (a partial
file, or a failed retry over its previous index) and reads "Error processing
file" (parts design Q1, `transferStatus`).
Each status label takes its icon's colour. The event stream only follows the open workspace,
so the panel polls the files list every four seconds for other workspaces with
unfinished rows, and the runner's wave gate polls every five. Closing the panel
clears its rows only; the transfers continue, and the `beforeunload` guard
follows the store's separate unsent count.

A source the server refused (upload error, provider rejection, failed import
job) stays in the panel as "Not added" with its reason, and is also named in
one error toast per submission: each failure adds its file name under its
reason to the same toast id instead of stacking toasts. A storage or frozen
refusal inside a workspace still goes to the workspace status toast through
`deferStorageRefusal`. Failed sources are not kept for resubmission; the user
adds them again. An import still running after the polling budget shows "Still
importing" and appears in the workspace when it finishes.

Selections the provider refuses before anything is sent (the inspection step)
show one toast that counts files per reason, since the picker returns only ids.

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

Card thumbnails (`ThumbnailPanel`) have no error surface: a page image that
fails to load shows the kind icon once and is not retried until the list
brings a different URL. A diagram whose Mermaid source the card's light
reader cannot draw keeps the icon too.

File previews use `FileError` for Office, CSV/TSV, text/Markdown/JSON, image,
audio and PDF failures. Manual retry refreshes signed links and restarts only
the preview, even when the URL is unchanged. CSV/text retries retain their
`SourceTextView` session. An Office view reads no download link: its
source session (and bytes) failing shows its `FileError` with the error id.
Office retry is view-only and reloads the source session, bytes and iframe.
The Office iframe reports errors to the host,
which owns error presentation; recoverable errors keep editors mounted. A
refusal is a `notice` message instead, and the editor shows nothing of its
own. The host shows each notice's message as a default toast from one table
(`officeNotices`): typing into a PPTX equation (`equation-text`) once per
frame, since it repeats on every key; an inserted image over the payer's plan
cap (`image-too-large`, worded with the cap the edit session loaded) or of a
type the browser cannot decode (`image-type`), which leaves the document as it
was, on every pick.
PDF annotation-load failures use `userToast` with Retry to refetch private marks
without reloading the PDF. The file viewer reports the request failure even
while PDF bytes are loading or the PDF cannot render. Repeated failures reuse one toast per file; recovery
or closing the viewer dismisses it. Office/text recovery and PDF annotation
write errors use `FileBanner`, with recovery actions passed as `actions`; save
states use `SaveBanner`. Statistics and
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

### Public summary errors

The site Worker preserves the summary HTTP status and no-store/noindex headers,
and uses the summary HTML entry for 404 and load-failure pages. The server renders
`SummaryFailure`, which uses the shared `ErrorState` with `variant="page"`, into
the first HTML response. The client hydrates the same component and locale;
it never replaces a temporary error layout. Missing and private
workspaces reuse the standard “Page not found” title, description and Go back action,
centered in the full-width panel without the summary header; loading failures offer a manual retry.
If the asset entry itself fails, the Worker retains the self-contained HTML error.
The SPA's existing `RouteNotFoundComponent` remains the generic page-not-found UI.
