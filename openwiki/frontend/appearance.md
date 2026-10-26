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
- After onboarding, the browser that ran it shows a "Get started n/3" row
  with a progress ring above Settings, which opens its list in a popover
  (`GettingStartedRow`; behaviour in
  `openwiki/authorization-permissions-lifecycles.md`).
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

## Styles

A style is the app's look on `<html data-style>`: `capy` (the default),
`fisheye` or `notion`; the theme (`data-theme`: Latte, Frappé, Mocha) picks
its light or dark palette. Settings → Customizations → Theme chooses it.

- Capy and Fisheye share colours and type (`src/styles/tokens/themes/capy.css`,
  selected with `:is([data-style="capy"], [data-style="fisheye"])`). Each has
  its own shape: radii and control heights. Capy's block sits in `capy.css`,
  Fisheye's in `fisheye.css`, Notion's in `notion.css`.
- Shape tokens: `--radius-input`, `--radius-button`, `--radius-button-lg`,
  `--radius-button-xl` (Button `lg`: a pill in Fisheye and Notion),
  `--radius-tile` (preview-card thumbnails and quick-review tiles; the
  thumbnail's outer focus ring is 1px more, its image 1px less),
  `--radius-card`, `--radius-card-lg`, `--radius-card-xl` (shell panels),
  `--radius-flashcard` (study and grid flashcards; Capy keeps Fisheye's 24px).
- Control heights: `--button-h-sm`, `--button-h-lg` and `--control-h`
  (Button, Input and Select `md`, one value so a button beside a field lines
  up), phone values first and the `sm` breakpoint's in a media block.
  Components read them and never set a height per style; one that needs a
  control's height uses `h-(--control-h)`.

| | Capy | Fisheye |
| --- | --- | --- |
| card-xl / card-lg / card | 14 / 12 / 10px | 28 / 24 / 18px |
| input / button / button-lg / button-xl | 8 / 8 / 10 / 10px | 18 / 12 / 18px / pill |
| tile / flashcard | 10 / 24px | 14 / 24px |
| button sm / lg (phone, then `sm`) | 28 / 40→44px | 30 / 48→52px |
| control: button, input, select md (phone, then `sm`) | 36→40px | 40→44px |

A stored or synced style the app no longer knows (an old `classroom`) is
ignored, and the default applies.

## Theme drawer

Profile menu → Theme opens `ThemeDrawer` (`src/components/app/ThemeDrawer.tsx`).
It has a URL: `?theme=open` on any signed-in page (the auth shell's search,
`themeDrawerSearch.ts`), so opening it is an in-app navigation and Back
closes it; the shell renders the one drawer. Onboarding's Customize theme
saves the profile as Confirm does (the button shows the spinner) and opens
the drawer only once the save succeeds; a failed save keeps the dialog.
It slides in from the right. On phones (below 640px) it is a full-screen sheet
laid out like a phone dialog: close on the left of the title, in the dialog's
title style and padding. It scrolls with its scrollbar hidden. It holds Theme
(two cards, Capy and Fisheye; Notion is left out until it is finished, though
Settings lists it), Mode (Latte, Frappé, Mocha) and the Page frame section
(`PageFrameSection.tsx`). Every change applies at once and
stays on this device (localStorage) until the user presses Sync.

## Page frame

`src/theme/pageFrame.ts` models the frame as `{ pattern, colours, dots,
strength, frosted }`:

- **Pattern:** None, Arc, Mesh or Glow, all pure CSS gradients.
- **Colours:** one of eight presets (Dawn, Dusk, Sea, Meadow, Rose, Sunset,
  Wheat, Mist) or `custom`. Dawn is the pale one (lavender, pink, peach); Mist is the neutral one (slate greys). Custom uses `dots`: 1–3 points on a field where x is hue
  and y is saturation. Each preset keeps its own three colours, and also
  carries the dots and Strength that come closest to them on the field
  (fitted in Lab). Choosing a preset moves the dots and the Strength slider
  there, and dragging a dot switches to custom from that spot.
- **Strength:** mixes the colours toward white. It is capped at 0.92, so the
  frosted sidebar's muted labels keep their contrast. A preset draws as
  approved when Strength sits at its fitted value, and slides from there.
- **Frosted:** which panels frost over the frame, any of Left, Centre and
  Right (a toggle row under Strength). Left is the default; an empty list
  frosts none. A frame stored before the field existed takes the default.
- **Default:** a device with no stored frame draws Arc in Mist with the left
  panel frosted. A frame the user stored or synced, None included, wins.
  The pre-paint scripts only copy a stored frame; `ThemeProvider` applies
  the frame in a layout effect, so a brand new device still shows it with
  the shell's first paint.
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
- Frosted panels (`[data-frosted]`) turn 60% white (55% ink in dark
  themes). Each panel names its place: `Panel frost="left|center|right"`,
  `PagePanel` is the centre and the shell's sidebar is the left; `useFrosted`
  sets `data-frosted` only when the frame lists that place, so the stylesheet
  has one rule for all three. Left is the sidebar and the workspace's left
  panel; centre is the page panel, the workspace viewer and the bank's
  questions; right is the workspace's right panel and the bank's topics.
  The rail sidebar (640–1023px) overlays the page and never frosts.
- Inside a frosted panel a few tokens turn translucent, the same for every
  panel: hovers, `--divider` (Tabs' line, rules), `--border-default`, and
  fields (`--surface-field-bg`, so selects and inputs). `--frost-fill` is the
  light fill for controls and tiles that would paint the card colour; the
  `frosted:` variant applies it (`frosted:bg-(--frost-fill)`): outline and
  surface buttons, the chat composer, Quick review tiles, a note's flashcard
  tiles and the flashcard study card. Cards (workspace
  cards, notices) keep their own fills. Menus and dialogs portal out of the
  panel and stay opaque.
- Floating toolbars (`BlockToolbar`: the text, column, table, media and link
  toolbars, and the study block's) portal out of the panel too, so the
  stylesheet's `[data-frosted]` cannot reach them: `Panel` and `PagePanel`
  pass their state down in `FrostedSurface` (`src/theme/theme.ts`), dialogs
  reset it, and a toolbar inside a frosted panel marks itself `data-frost`
  and turns frosted glass like the chat dock's field (`tailwind.css`).
- Anything that paints its own fill across a panel hides the frost, so it
  drops it there: the workspace viewer's wrapper fills only in fullscreen,
  the note toolbar and source editor go transparent, a CSV's sticky header
  blurs instead.
- Office views: `set-appearance` carries `frosted` (Office protocol 13) when
  the centre frosts over a shown frame and no show is presenting. The
  runtime then marks its `<html>` `data-frosted` and `office-runtime.css`
  clears the desk and toolbar row: DOCX's `--doc-bg` and `--doc-toolbar-bg`
  (also on the editor's `.oox-root`, which declares them again, and on its
  toolbar wrapper, which fills with `--doc-surface`), and PPTX's `--pptx-bg`,
  `--pptx-strip-bg` and `--pptx-surface` in view and edit (desk, toolbar row,
  slide strip, notes box). The frost shows around pages and slides; pages,
  cells, slides, menus and the DOCX editor's popups and dialogs keep their
  fills. A PDF view stays opaque.
- The chat dock below lg floats over the centre panel, outside its card: it
  marks itself `data-frost` when the centre frosts, and its open field is
  frosted glass (`motion-chat-dock`: translucent fill, 16px backdrop blur).
- With None, everything returns to the page colour and the opaque cards.

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
