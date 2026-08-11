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

Mutation failures produce an error toast by default. A mutation that renders its
own inline error, needs domain-specific messaging, or treats cancellation as
normal must use:

```ts
meta: { errorToast: false }
```

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

Public `/share/...` routes must never reveal whether a resource exists, whether
the caller is signed out, or whether the caller lacks permission. HTTP 401, 403,
and 404 all map to the same “private or unavailable” surface. Do not include
resource names, server details, or different actions that disclose which case
occurred.

## Offline and paused work

`ConnectionBanner` exposes offline state as
`[data-connection-status="offline"]`. TanStack Query's `onlineManager` pauses
network work until connectivity returns; loading UI should describe that it is
waiting rather than escalating the pause to an error. Stream disconnections use
the related `reconnecting` status.

## Streaming failures

Chat SSE failures stay on the assistant turn. An explicit `error` frame and a
stream that closes before a terminal `done` frame both mark that turn as errored;
they do not crash a page boundary or emit the default mutation toast. Ingest and
notification streams update cached connection status, reconnect with backoff,
and use the status banner when disconnected. An ingest `failed` event updates
the affected file state and triggers a refetch.

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

Playwright tests should use `expectErrorSurface(page, variant, text?)` from
`e2e/helpers/errors.ts` instead of duplicating selector details.
