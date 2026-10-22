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
- The 640–1023px rail uses the same rows. The phone nav drawer's foot is a
  link to Settings → Account (avatar and name) with a danger-light Log out
  button on its right (`ProfileRow`), no menu. Phones keep the avatar menu in
  the page's top row (`PhoneTopRow`).
- Over a page frame the sidebar's rows hover with a translucent tint
  (`--surface-page-hover` and `--surface-card-hover-bg` are redefined under
  `[data-frosted]`), so the frost shows through. A row's hover ⋮
  (`HoverActions`) drops its fill there and the row's label fades out under
  it instead.
- The opened workspace has no app sidebar. Its 1-2-3 panels sit straight on
  the shell, so the frame shows around and between them.

## Theme drawer

Profile menu → Theme opens `ThemeDrawer` (`src/components/app/ThemeDrawer.tsx`).
It slides in from the right. On phones (below 640px) it is a full-screen sheet
laid out like a phone dialog: close on the left of the title, in the dialog's
title style and padding. It scrolls with its scrollbar hidden. It holds Theme
and the Page frame section (`PageFrameSection.tsx`); the Style choice is
hidden until the Notion style is finished. Every change applies at once and
stays on this device (localStorage) until the user presses Sync.

## Page frame

`src/theme/pageFrame.ts` models the frame as `{ pattern, colours, dots,
strength }`:

- **Pattern:** None, Arc, Mesh or Glow, all pure CSS gradients.
- **Colours:** one of seven presets (Dusk, Sea, Meadow, Rose, Sunset, Wheat,
  Mist) or `custom`. Custom uses `dots`: 1–3 points on a field where x is hue
  and y is saturation. Each preset keeps its own three colours, and also
  carries the dots and Strength that come closest to them on the field
  (fitted in Lab). Choosing a preset moves the dots and the Strength slider
  there, and dragging a dot switches to custom from that spot.
- **Strength:** mixes the colours toward white. It is capped at 0.92, so the
  frosted sidebar's muted labels keep their contrast. A preset draws as
  approved when Strength sits at its fitted value, and slides from there.
- **Shuffle** (right of Sync) moves every dot and Strength to random values,
  as custom colours.

How it is drawn:

- `pageFrameStyle()` turns the frame into `--page-frame-*` custom properties on
  `<html>`, plus `data-page-frame`: the three colours (`--page-frame-a/b/c`)
  and the pattern's image, which reads them. The stylesheet's `.page-frame`
  rules paint the shell (`AppShell`) and the shared pages (`PublicHeader`)
  with them.
- The three colours are registered (`@property … <color>`). While the Page
  frame section is open (`data-page-frame-edit`) they ease into a preset or a
  shuffle, and the dots and slider glide with them. While a dot or the slider
  drags (`data-page-frame-live`), the drawer redraws itself on every move but
  hands the page frame a sample every third frame (~20 a second), and the
  colours glide linearly over 50 ms between samples, so the window repaints
  from samples instead of from every pointer move. Outside the section,
  page loads included, the colours apply at once.
- Dark themes add an ink wash.
- The shell's sidebar card and the opened workspace's left panel
  (`[data-frosted]`, `Panel frosted`) turn 60% white (55% ink in dark
  themes). With None, everything returns to the page colour and the opaque
  cards.

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
