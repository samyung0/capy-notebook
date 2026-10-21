# Appearance: shell, Theme drawer, page frame and Sync

How the app shell is laid out, what the Theme drawer controls, how the painted
page frame is drawn and stored, and how Sync carries a look to the user's
other devices. Decisions: `human/miscellaneous.md` (2026-10-20 and 2026-10-21
entries); mocks: `artifacts/2026-10-20-painted-cards-cursors-mocks.html`.

## Shell

- The page panel (`PagePanel`, `src/components/app/layout.tsx`) has no notch.
  Its header and body scroll together at every width.
- There is no top bar. From `lg`, the sidebar (`Sidebar account`) carries
  Search and Notifications under the app name. Its foot is your profile row,
  which opens the profile menu upwards: Settings, Billing & usage, Theme and
  Log out (`ProfileMenu trigger="row"`).
- The 640–1023px rail and the phone drawer use the same rows. Phones keep the
  avatar menu in the page's top row (`PhoneTopRow`).
- The opened workspace has no app sidebar. Its 1-2-3 panels sit straight on
  the shell, so the frame shows around and between them.

## Theme drawer

Profile menu → Theme opens `ThemeDrawer` (`src/components/app/ThemeDrawer.tsx`).
It slides in from the right, and on phones (below 640px) it is a bottom sheet,
so the top of the page stays in view. It holds Style, Theme and the Page frame
section (`PageFrameSection.tsx`). Every change applies at once and stays on
this device (localStorage) until the user presses Sync.

## Page frame

`src/theme/pageFrame.ts` models the frame as `{ pattern, colours, dots,
strength, grain }`:

- **Pattern:** None, Arc, Mesh, Glow, Painted, Waves or Contours.
- **Colours:** one of seven presets (Dusk, Sea, Meadow, Rose, Sunset, Wheat,
  Mist) or `custom`. Custom uses `dots`: 1–3 points on a field where x is hue
  and y is saturation.
- **Strength:** mixes the colours toward white. It is capped at 0.92, so the
  frosted sidebar's muted labels keep their contrast.
- **Grain:** the opacity of a static noise tile, never animated.

How it is drawn:

- Arc, Mesh and Glow are pure CSS gradients.
- Painted, Waves and Contours blend one small grey texture
  (`src/assets/paint/`, 3–14 KB) over a gradient of the three stops.
- `pageFrameStyle()` turns the frame into `--page-frame-*` custom properties on
  `<html>`, plus `data-page-frame`. The stylesheet's `.page-frame` rules paint
  the shell (`AppShell`) and the shared pages (`PublicHeader`) with them.
- Dark themes add an ink wash.
- The shell's sidebar card (`[data-frosted]`) turns 60% white (55% ink in dark
  themes). With None, everything returns to the page colour and the opaque
  sidebar.

Measured against the landing page's live SVG filters (bench in the mocks,
headless Chromium):

- **24-card grid, hover and scroll:** filters took about 10× the raster work
  of images.
- **20 resizes of a full window:** images 95 ms, CSS blend 382 ms, SVG filters
  3,459 ms.

The frame is one background behind opaque panels, so it repaints only on
resize.

Storage, all local:

- `capy.pageFrame` holds the settings.
- `capy.pageFrameCss` holds the resolved properties. The pre-paint scripts in
  `index.html` and `share.html` read it, so the frame shows with the first
  frame. They copy only `--page-frame-*` string values.
- Shared pages read nothing else: no header or account request, so their edge
  cache stays shared.

## Sync

Sync, under the Page frame section, sends the device's style, theme and frame
as `PUT /api/me/customization`. Changes never save on their own.

The server stores it in `users.customization`. That column is nullable jsonb,
and NULL means the user never synced.

- **Validation:** `store.Customization` is a struct with enums, min/max and
  1–3 dots. Huma refuses unknown fields and out-of-range values with 422, and
  `Customization.Validate` repeats the bounds before the write. Only the
  struct's known fields are marshalled into the column, so future fields are
  added to the struct, not stored blindly.
- **Event:** the server then publishes `notification` `{type:"customization"}`
  to `notif:{userId}`. Every open tab of the user hears it, the sender
  included; there are no connection ids. Each tab refetches `/api/me` and
  passes `customization` to `ThemeProvider` (`customizationEvents.ts`).
- **Applying:** `ThemeProvider` checks each field and applies it locally. The
  sender finds its own values.
- **Reading:** `GET /api/me` returns `customization` when set. Nothing applies
  it outside that event: a window-focus refetch of `/api/me` leaves the local
  look alone.
