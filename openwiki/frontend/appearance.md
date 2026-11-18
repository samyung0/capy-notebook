# Appearance: shell, Theme drawer, page frame and Sync

How the app shell is laid out, what the Theme drawer controls, how the painted
page frame is drawn and stored, and how Sync carries a look to the user's
other devices. Decisions: `human/miscellaneous.md` (2026-10-20 and 2026-10-21
entries); mocks: `artifacts/2026-10-20-painted-cards-cursors-mocks.html`.

## Shell

- The page panel (`PagePanel`, `src/components/app/layout.tsx`) has no notch.
  Its header and body scroll together at every width.
- There is no top bar. From `lg`, the app sidebar (`Sidebar account`) carries
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
  the page's top row (`PhoneTopRow`), which holds only the menu button and the
  avatar (the recent-files arrow and the mic were removed, Epo 2026-11-11).
- Over a page frame the sidebar's rows hover with a translucent tint
  (`--surface-page-hover` and `--surface-card-hover-bg` are redefined under
  `[data-frosted]`), so the frost shows through. A row's hover ⋮
  (`HoverActions`) drops its fill there and the row's label fades out under
  it instead.
- The opened workspace has no app sidebar. Its panels sit straight on the
  shell, 8px apart, so the frame shows around and between them.
- **Names (Epo, 2026-11-05):** the app's front page (`/`,
  `src/routes/Workspaces.tsx`) is **Workspaces**, and `/workspaces` redirects
  there; there is no Home. A workspace's front page, its landing with no file
  open, is its **Dashboard**. **To do** (`/todo`, `src/routes/Todo.tsx`) sits
  under Workspaces in the nav, with the notifications dot while anything is
  open: a table of what each class holds for the viewer, a folding group per
  class, the page's full width (Epo 2026-11-10), under tabs To do ·
  Done and a Type filter (see study-progress.md).
- **Dashboard (Epo 2026-11-03, boards H1 owner, H2 member, H3):**
  `WorkspaceDashboard.tsx`, the centre with nothing open (without a file
  header wherever the rail shows, as every page but Files, whose header holds
  Add file and Add topic below lg; a phone keeps it for Back and ⋮, Epo
  2026-11-17). The workspace's name with "owner · N
  members", Upload and a disabled "Make a quiz from a file" ("Coming soon")
  for those who may add; **What to practise next**, Practice's suggestions for
  whoever practises here (`studyView`, board U3), each with Practise, which
  opens its topic session; **Recent files**, the newest four as bordered
  preview cards with the name under each (`PreviewCard bordered`); and
  **Activity**, the five newest uploads and added materials with who and
  when, the agent's own rows under the AI icon, a hidden item's with the eye
  after its name for the owners and editors who get it
  (`GET /api/workspaces/{id}/dashboard`, see
  [study-progress.md](../study-progress.md#endpoints)), each row opening its
  file or material. An empty section does not show, but for To do, which says
  "Nothing to do" (see [study-progress.md](../study-progress.md)). A workspace
  with no files shows `WorkspaceEmpty` under To do, instead of the actions and
  Recent files: the map's ink book, "No files yet" and Add file, which opens the
  upload dialog, for those who may add.
  Wrapped actions sit 16px from the visible text above and below them, as
  Practice's do: negative margins that a one-line header cancels out. The old
  landing's Add file, Quick open, Workspace settings and Practice cards went.

## Workspace rail

From md (768px, so iPads keep it, Epo 2026-11-06) every workspace page leads with a labelled icon rail
(`WorkspaceRail.tsx`): 68px wide, as wide as its items (Epo 2026-11-13), straight on the shell with no panel of its own
(Epo 2026-11-04), so it has the app sidebar's page colour and a frame shows
through behind it, with
← Workspaces (to `/`), the workspace's icon as a 34px badge that only
says where you are, then Dashboard (Hugeicons' `DashboardSquare01Icon`),
Files (a folder), Agent (the AI icon), then the four pages that were Study's
until Epo 2026-11-11 gave each its own place (`workspaceSections`, by `studyView`):
To do, which a class's owner and editors see as Assignments, with the count of
what waits there by its icon; Practice; Members (every member: a class's owner
and editors with each member's marks, everyone else the people without marks;
a link or public visitor has none); and Study (an open book),
the viewer's own marks and mastery, which a class's owner and editors do not
have. Last, for members,
Canvas (the drawing board, `frontend/plate-editor.md`), each icon
over its 11px label in a 48px-high item, 8px apart, that takes the sidebar's dark
fill while current. Labels sit on the frame plainly, with no halo (Epo 2026-11-08). The app sidebar's rows are 32px high and 2px apart from `sm` (the
phone drawer keeps 36px and 4px for touch).
At its foot, Settings (a gear, for whoever has Workspace settings, Epo
2026-11-13) opens the Workspace settings dialog, and under it your avatar (44px,
no ring) opens the profile menu upwards, headed by
the workspace's part: Invite member (owners and editors; it opens Members), Workspace settings, and Clone for readers who may.

There is no right panel (Epo 2026-11-04). Files and Chat are pages (Epo
2026-11-14), each a side panel beside the rail from lg and a centre; the other
sections are pages without one. The side panel is 340px by default, resizable
from 220px up to half the group, so the viewer never drops under its 400px
least width. A drag past its least width folds it on release. It keeps its
width between Files and Chat and comes back at the width it closed at until the
page is left:

- **Files:** the topic tree under its search and the New file or topic row,
  with Collapse all topics on the title row. The centre is the open file, or
  with none the Recent files grid (`FilesHome`: up to four cards, 2×2 in a
  400px column, the Dashboard's `RecentCard`; the blank Add file state when
  the workspace has none). The chat button floats at its bottom right at every
  width; from lg it opens the chat as a 420×620 window over the file or the
  recent files (New chat as a plus, history, Open on the Chat page, close: 28px
  buttons, no workspace menu), below lg it morphs into the dock's field.
- **Chat:** the chats, with voice and Archived chats on the title row and New
  chat over the list; the centre is the chat, its thread and composer in a
  768px column. No chat button.

The page is in the URL: an open file or material is the Files page, `study`
names a section's page (`assignments` for To do, `practice`, `members`,
`summary` for Study), and otherwise `view` (`files`, `files-chat`, `chat`,
`chats`, or `canvas` in dev builds); none is the Dashboard (Epo 2026-11-05).
`view=chat` beside a file is the chat over it (the window from lg, the sheet
below), `files-chat` the same over the Files page with nothing open, and
`chat` on its own the Chat page; a rail press adds a back step. From lg a citation or
a file the chat made opens under the window, the chat kept. Pressing the
shown Files or Chat folds or unfolds its side panel; the others open their
page. `view=canvas` is the drawing board in the centre at every width: it has
no side panel, and below md, with no rail, a back button leads to the
Dashboard.

Below lg there is one column, with the rail from md. Files is the tree as a
page (`view=files`) under the workspace header, and a file leads back to it
with "← Files" on phones in place of the workspace's back; Chat is the list as
a page (`view=chats`), and a conversation over it leads back with "← Chats".
The header's ⋮ carries Dashboard, the pages this person has (To do or
Assignments, Practice, Members, Study) and Workspace settings.

The one chat stays mounted at every width whichever page shows, so it keeps its
thread, draft and stream (hidden while Make a quiz's dialog or the canvas
shows); a thread that moves on while hidden shows its end on return. Every way
into a chat goes to the Chat page (`openChat`): `?chat=new` from Get started,
the list's rows and New chat, and voice. The thread on screen comes back after
a reload or a closed tab (`capy.chat.open.<id>`, T19).

A page has one `h1`: the Dashboard, these pages, a quiz and a flashcards set
head themselves; with anything else open it is an `sr-only` workspace name.

The AI icon (`ai` in `Icon.tsx`, a curved four-point star stroked like the
rest; Epo picks the final shape from a mock) marks the agent: the rail's
Agent, the sidebar's Agent, the chat panel's title and empty state, and Generate in the AI generate form.

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
  `--radius-toolbar` and `--radius-toolbar-button` are every floating bar and
  its buttons, BlockSuite's and the app's shared `BlockToolbar` alike, and
  BlockSuite's menus (8 and 5px in Capy and Notion, 14 and 10px in Fisheye);
  see "The note's and the board's chrome" in
  [plate-editor.md](plate-editor.md#the-notes-and-the-boards-chrome).
- Control heights: `--button-h-sm`, `--button-h-lg` and `--control-h`
  (Button, Input and Select `md`, one value so a button beside a field lines
  up), phone values first and the `sm` breakpoint's in a media block.
  Components read them and never set a height per style; one that needs a
  control's height uses `h-(--control-h)`.
  A page or file header's action (New workspace, Add task, the workspace
  Dashboard's Upload and Make a quiz, New assignment, Add practice, a
  file's Preview, a quiz's or set's Practice) is `PageButton`: 36px (`h-9`) in every
  style and on every screen (Epo 2026-11-16). The center header row
  (`data-center-header`) is `shrink-0`, so a tall page under it, as the
  Files view is, cannot squeeze it below its 48/60px.
  An open file's header (`CenterContentHeader`, Epo 2026-11-16): back (a
  phone's bare arrow, named Files for screen readers), the file's icon, name,
  Hidden chip and save status on the left; presence, Undo/Redo and Preview (its
  word, no eye: the eye read as the Hidden chip's) on the right, with ⋮ last
  at every width. On phones Preview (a quiz's, a note's Preview/Edit/Close) is
  the first item in ⋮ instead (`usePhoneMenuItem` in `fileModeContext.ts`).
  A quiz's or set's Practice is not in the header: it sits at the pane's top
  right beside the title (`QuizPaneTitle`, `PaintedCards`). Neighbours sit about 10px apart by their ink:
  the save status is pulled 4px in after the name or chip, a quiz's buttons
  Preview 4px past Redo, and ⋮ 4px past Preview. Its dots are a thin column
  in a wide box, so from sm the ⋮ box is 24px wide (not 32) and its hover
  never overlaps Preview; on phones (no Preview there) its 30px box sits 4px
  in. The status's label (Saved) shows from a 42rem
  header (`@2xl/header`, `data-wide` on WebKit), 36rem until then.

| | Capy | Fisheye |
| --- | --- | --- |
| card-xl / card-lg / card | 14 / 12 / 10px | 28 / 24 / 18px |
| input / button / button-lg / button-xl | 8 / 8 / 10 / 10px | 18 / 12 / 18px / pill |
| tile / flashcard | 10 / 24px | 14 / 24px |
| button sm / lg (phone, then `sm`) | 28 / 40→44px | 30 / 48→52px |
| control: button, input, select md (phone, then `sm`) | 36→40px | 40→44px |

A stored or synced style the app no longer knows (an old `classroom`) is
ignored, and the default applies.

## Shared pieces

Built screens copy the mock boards exactly (Epo, 2026-11-03; boards K2, K3
and K5 of the study-tracking canvas). Choices a board does not settle go back
to Epo as visual options, not a call made in code.

- **Toast** (`Toast` in `src/components/ui/Toast.tsx`, board K2): every kind
  is the same pill: `#222`, white 14px semibold text, 44px tall with a 44px
  icon slot, 22px corners, 20px right padding, `0 8px 24px` shadow. Only the
  icon and its colour change: done is a check (`#86d6a8`), plain is info or
  the caller's `icon` (white, I1), working a ring spinner (white, S1),
  warning a triangle (`#f2c46d`), error a circled ! (`#ff9b9b`). Buttons
  follow the ding library (Epo 2026-11-09): 30px tall, 8px apart, 7px in
  from the pill's edge, 13px semibold, each with a 44px tall hit area: the
  action (`button`) a white capsule with `#222` text, and on errors and
  working toasts a round 30px close with a 16px × in white 65%, which hovers
  with a white 10% wash. Copy too wide to sit
  beside them puts the buttons on their own row at the right. A repeat
  shows `×2` in a white 16% capsule. An open error sits at the bottom with the other toast
  8px above it (E2), centred on phones too and drawn over the chat button
  (P3). A description or a title that wraps takes more
  lines in the same pill, 384px wide (less on phones), with 18px corners and
  the description at 13px, white 72%. Dark themes draw it as an overlay
  surface (`--surface-overlay-bg` with an `--border-overlay` ring and
  `text-fg`), so it stands apart from the dark page (T2). Behaviour (one at a
  time, counts, timers) is in `error-handling.md`; motion in `motion.md`.
- **Workspace card** (below `sm`, canvas board P1: a 40px cover at the side, the
  icon before the name at 20px, the ⋮ at the top right; from `sm`:
  `WorkspaceCardFace` in `src/components/ui/WorkspaceCard.tsx`,
  board K3 row H2): the cover is a 76px banner across the top (plain
  `--surface-page-hover` without one, N1), the 36px icon sits on its
  bottom-left edge in a 2px card-coloured ring, and the ⋮ on the banner is
  `CardActions`, the one button the file cards use too: a plain 24px circle in
  the card's colour, with a larger invisible hit area. From 1280px with a
  mouse it shows on the card's hover, focus or open menu; narrower and on touch
  screens it always shows. Below: the name (14px bold, one line, L1), the topic
  count (`chapterCount` until chapters become topics), then access and tags as
  22px boxes with 6px corners. The card border is `--divider`. The settings
  cover picker previews the same face; covers and the picker are unchanged.
- **Answer boxes** (board K5): options, True / False and ordering items; see
  `question-bank.md` § Answer keys and server grading.

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
- **Default (Epo, 2026-11-03):** None. It lives in one place,
  `DEFAULT_PAGE_FRAME` in `pageFrame.ts`, which also stands in for any
  invalid stored field. A device with no stored frame, and an account that
  never synced (`users.customization` NULL; the server keeps no default of
  its own), shows the page colour with opaque panels. Picking a pattern
  from there starts on Mist with the left panel frosted. A frame the user
  stored or synced wins. The pre-paint scripts only copy a stored frame's
  paint (`capy.pageFrameCss`), so with nothing stored they paint nothing,
  which is the default.
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
  questions; right is the bank's topics.
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
  blurs instead, and the Members Topics grid's All members row turns a light
  wash.
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
- The chat dock below lg (phones only in a workspace and only on an open file,
  where the rail's Agent opens the chat from 768px, Epo 2026-11-12, 2026-11-14) floats over the centre panel, outside its card: it
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
