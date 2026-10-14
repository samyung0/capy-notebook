# Keyboard shortcuts: one contract

Status 2026-10-14: every decision below is made and recorded in
`human/miscellaneous.md` (it also settles the Office print shortcut parked in
`human/frontend/office-files.md:141`). Next: mocks. Nothing built.

## Today

- No shared layer. Shortcuts live in Plate `shortcuts:` options, hand-written
  `metaKey || ctrlKey` handlers, CodeMirror/MathLive keymaps and the Office
  runtime inside its iframe (host keys never fire while a document has focus).
- Mod+K is bound twice: the note editor palette (`EditorCommandPalette.tsx:30`,
  a window listener that also fires from chat and search inputs, during IME
  composition, and on Ctrl+K on Mac) and Plate's link edit (`meta+k, ctrl+k`).
- Every note editor hint is literal "Ctrl+…" (`notes/toolbar/ToolbarButton.tsx:5`,
  `editorCommands.ts:194`), so Mac shows Ctrl; none is translated or in
  `aria-keyshortcuts`. "Ctrl+Shift+M" (comment) is shown in three places and
  bound nowhere.
- No app or workspace shortcut at all: no search key, no panel toggles, the chat
  box has no Enter to send, study screens take no keys.
- Live quiz/flashcard Undo/Redo are buttons only; Cmd+Z in their fields hits
  Plate's own per-field history or the browser's, a different stack.
- The Apple check is copied five times on the deprecated `navigator.platform`;
  only the comment reply box guards IME composition; `cmdk` is a dependency
  nothing imports; `lib/useOutsideClick.ts` is dead.
- Already right: `ButtonTooltip` takes a `shortcut` and renders `<kbd>`
  (`IconButton`, `ToolbarButton` pass it); Office menus format per platform and
  set `aria-keyshortcuts`.

## Contract

1. **Catalog** `src/lib/shortcuts/catalog.ts`: every action with a key is one
   typed entry: id (`workspace.toggleFiles`), default keys (`mod+\`, `mod` = ⌘
   on Apple, Ctrl elsewhere; a per-platform pair where one key cannot serve
   both, as for Copilot), group, label message, rebindable or fixed.
   Nothing else in the app spells a key.
2. **Scope by mounting**: a component that owns an action registers its handler
   with `useShortcut(id, handler)`; it fires only while that component is
   mounted (the workspace page, the chat box, a study screen). No `when` language.
3. **One window listener** (bubble phase) dispatches. It ignores events already
   handled (`defaultPrevented`), IME composition (`isComposing`, keyCode 229)
   and, while focus is in a text field, any binding without ⌘/Ctrl/Alt.
4. **Editors win inside editors**: Plate, MathLive, CodeMirror and Office claim
   their keys first. Plate's `shortcuts` take their keys from the catalog, so the
   labels match what fires.
5. **Matching**: the typed letter on Latin layouts, the physical key otherwise
   (zh/ru keyboards), as Office already does.
6. **Display**: `shortcut` props take an action id, never text. Tooltips, menus,
   the slash menu, the palette and the help sheet render the user's current
   binding: Mac `⇧⌘O` (⌃⌥⇧⌘ order, no separator), elsewhere `Ctrl+Shift+O`, plus
   `aria-keyshortcuts`; hidden on touch screens.
7. **Office iframe**: the host sends the app/workspace bindings to the runtime;
   the runtime forwards a match its editor did not handle as `shortcut {id}`
   (protocol bump).
8. **Customization**: overrides only, `{id: keys[]}` (`[]` unbinds), stored on
   the server per user. Settings › Shortcuts lists the catalog by group with search, a key
   recorder, "Also used by …" on conflict (same key in overlapping places), and
   Reset per row and for all. The recorder refuses browser-reserved keys and bare
   keys outside study sessions. The help sheet (? when not typing) lists the
   same with a Customize link.

Reserved, never offered: ⌘N ⌘T ⌘W ⌘Q ⇧⌘N ⇧⌘T ⇧⌘W, ⇧⌘P (Firefox private
window), Ctrl+Tab, Ctrl+⇧Tab, Ctrl+PgUp/PgDn, ⇧⌘[ ⇧⌘], ⌥⌘←/→ (Mac Chrome tab
switching). Avoided as defaults: ⌘1–9 (browser tab jump), ⌘L ⌘R ⌘D ⌘=/-/0, and
Tab/⇧Tab on their own (keyboard focus navigation) anywhere.

## Catalog (defaults; Windows/Linux use Ctrl for ⌘, Alt for ⌥)

| Id | Action | Default | Where | Rebindable | Today |
|---|---|---|---|---|---|
| `app.search` | Search | ⌘K | anywhere, notes included | yes | none |
| `app.shortcuts` | Keyboard shortcuts sheet | ? | anywhere, not while typing | yes | none |
| `note.palette` | Editor command palette | ⌘/ | note editor | yes | ⌘K |
| `selection.clear` | Leave select mode | Esc | pages with selectable items (Files) | fixed | yes |
| `workspace.toggleFiles` | Show/hide the file tree (pin left; drawer below 1260px) | ⌘\ | workspace | yes | button |
| `workspace.focusFiles` | Files tab, focus the tree | ⇧⌘E | workspace | yes | none |
| `workspace.nextFile` / `prevFile` | Open next/previous file in tree order | ⌥⌘↓ / ⌥⌘↑ | workspace, not in editors | yes | none |
| `workspace.study` | Study tab | none | workspace | yes | none |
| `item.toggleMode` | View ⇄ Edit | none | open item | yes | toggle button |
| `chat.new` | New chat | ⇧⌘O | workspace | yes | button |
| `chat.focus` | Focus the chat box (opens Chat) | ⇧Esc | workspace | yes | none |
| `chat.send` | Send (⇧Enter new line, never while composing) | Enter | chat box | fixed | button only |
| `study.flip` | Show answer / flip card | Space | flashcard study, review sessions | yes | none |
| `study.prev` / `study.next` | Previous / next card | ← / → | flashcard study, review sessions | yes | none |
| `study.again` … `study.easy` | Rate Again/Hard/Good/Easy | 1 2 3 4 | flashcard study, review sessions | yes | none |
| `study.option` | Choose option n | 1–9 | quiz attempt, review | fixed | chat questions only |
| `edit.undo` / `edit.redo` | Undo / Redo | ⌘Z / ⇧⌘Z (Ctrl+Y) | every editor; live quiz/cards share the header buttons' stack | fixed | buttons on live items |
| `edit.save` | Save now | ⌘S | notes, text, Office | fixed | yes |
| `edit.export` | Export: opens the format menu | ⇧⌘S | notes (Export menu), Office (File › Download) | fixed | menus only |
| `edit.find` | Find | ⌘F | Office DOCX; browser elsewhere | fixed | DOCX |
| `edit.print` | Print through Capy | ⌘P | Office; browser elsewhere | fixed | menu only |
| `note.*` | Bold ⌘B, italic ⌘I, underline ⌘U, strike ⇧⌘X, code ⌘E, highlight ⇧⌘H, sub/sup ⌘, ⌘., H1–3 ⌥⌘1–3, quote ⇧⌘., code block ⌥⌘8, AI ⌘J, comment ⇧⌘M (new binding); links from the toolbar only | as listed | note editor, rich quiz fields | fixed | labels wrong |
| `copilot.*` | Ask / accept word / accept / reject | Mac ⌥Space / ⌥→, others Ctrl+Space / Ctrl+→; Tab; Esc | note editor while a suggestion shows (feature-flagged off) | fixed | Ctrl+Space, ⌘→ |
| Office | Google Docs/Sheets/Slides keys | unchanged | Office | fixed | correct |

Study keys fire only in the full-screen sessions, where the card is the only
thing on screen; an embedded card or a document keeps Space for scrolling. Esc
never stops a chat answer, and ⇧Tab is never a mode toggle.

## Decisions (all recorded 2026-10-14)

- ⌘K opens Search everywhere; the editor palette moves to ⌘/; Plate's ⌘K link
  binding goes, links come from the toolbar.
- ⌘\ toggles the file tree; the right panel stays always visible, no collapse.
- App, workspace, chat and study shortcuts are rebindable; formatting,
  undo/redo, save, find, print and export are fixed.
- Rebinds are per-user overrides on the server: a JSON column on users,
  `PATCH /api/me/shortcuts`, saved on each change like study preferences.
- Enter sends chat; Esc keeps closing dialogs/menus and clearing selection.
- Study: Space, ←/→ and 1–4 in full-screen sessions only.
- Live quiz/flashcard undo is one browser-side Yjs stack; no server change.
- ⌘P prints Office documents, ⇧⌘S opens export, ⇧⌘M comments.
- Copilot's Mac clashes move to ⌥Space / ⌥→.

## Phases

1. Decisions recorded in `human/`.
2. Mocks: Settings › Shortcuts, the help sheet, `<kbd>` in tooltips and menus,
   desktop and phone.
3. Core: catalog, matcher, formatter, listener, `shortcut={id}` display; move
   the editor palette, Plate labels, Save and the live-item undo onto it; drop
   the five Apple checks and `useOutsideClick`.
4. Workspace, chat and study actions.
5. Customization: users column + `PATCH /api/me/shortcuts` and the
   Settings tab.
6. Office forwarding and ⌘P print.

Tests: unit tests for matching (layouts, IME, Apple/other), formatting and
override merging; one e2e that rebinds a key and sees the tooltip and the
action follow.

## Research

Compared t3code, Codex (TUI and app), VS Code, Zed, Excalidraw, tldraw, AFFiNE,
Outline, Obsidian, Notion, Linear and ChatGPT web, 2026-10-14. t3code is the
model (`packages/contracts/src/keybindings.ts`, `apps/web/src/keybindings.ts`):
one registry, labels from the binding that fires, server-stored overrides that
replace a command's defaults, Settings with conflicts and reset, ~450 lines and
no library. Rich-text notebooks keep ⌘B for bold and move the sidebar (Notion
⌘\, AFFiNE ⌘/, Outline ⌘.); code tools take ⌘B. ⇧⌘O is the web-safe new chat
(ChatGPT, Codex, t3code). Reserved keys verified in Chromium
`browser_command_controller.cc` / `global_keyboard_shortcuts_mac.mm` and Firefox
`browser-sets.inc.xhtml`; Safari's list is unverified.
