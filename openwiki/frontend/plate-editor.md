---
type: Frontend
title: 'Frontend: Plate.js Editor Deep Dive'
description: 'How Plate.js v53 works and how evo-notes composes it into an editable, persistent, collaborative, AI-enabled material editor with a separate static renderer.'
tags: [frontend, plate, slate, rich-text, collaboration, ai, serialization]
---

# Frontend: Plate.js Editor Deep Dive

This page is the detailed guide to the Plate.js integration. Read
[Frontend: Editor & UI](editor-and-ui.md) first for the surrounding React
application, routing, and API layer; this page focuses on the editor runtime
and the boundaries around it.

The short version is:

- **Plate/Slate own the in-memory editor tree, selection, history, plugin
  behavior, and rendering lifecycle.**
- **Evo Notes owns the persisted material envelope, validation, IDs, save and
  revision handling, collaboration APIs, asset storage, and AI transport.**
- **Interactive and static rendering use different plugin/component registries
  over the same persisted node vocabulary.**

That distinction is important. Plate suggestion metadata in the persisted
`MaterialDocument` is authoritative for each active operation and diff.
Discussion/comment rows and runtime comment marks are separate concerns: rows
hold collaboration lifecycle data, while comment marks are ephemeral editor
decorations. AI previews, placeholder uploads, selections, and plugin options
are runtime state rather than database contracts.

## Version and package boundaries

The lockfile currently resolves the core `platejs` package to `53.2.4`.
The application uses the Plate 53 package family, with some packages on
different 53.x patch releases; keep the family aligned when upgrading. The
direct dependency declarations are in [`package.json`](../../package.json) and
the resolved versions are in [`pnpm-lock.yaml`](../../pnpm-lock.yaml).

The important export boundaries are:

- `platejs` — headless Slate/Plate types, node APIs, editor creation, core
  plugin primitives, and transforms.
- `platejs/react` — `usePlateEditor`, `Plate`, `PlateContent`, React hooks,
  `PlateElement`, `PlateLeaf`, and React-aware plugin factories.
- `platejs/static` — hook-free `PlateStatic`, `SlateElement`, and `SlateLeaf`
  rendering.
- `@platejs/*` — feature plugins and their base or React variants. For
  example, the editable registry imports `TablePlugin` from
  `@platejs/table/react`, while the static registry imports
  `BaseTablePlugin` from `@platejs/table`.

Upstream references:

- [Plate documentation](https://platejs.org/)
- [Plate source repository](https://github.com/udecode/plate)
- [Plate architecture in DeepWiki](https://deepwiki.com/udecode/plate)

## Plate's mental model

### The document is a Slate tree

Plate builds on Slate's tree model:

- A **text node** has `text` plus arbitrary mark properties such as `bold`,
  `italic`, `color`, or `suggestion`.
- An **element node** has a `type`, `children`, and type-specific properties
  such as `url`, `lang`, `assetId`, `width`, or `variant`.
- A **path** identifies a node by child indexes, and a **point** identifies a
  text offset inside a path.
- The editor also owns the current `selection`, undo/redo history, and
  normalization behavior.

Plate does not prescribe a database schema. It adds a plugin registry and
React rendering around the Slate editor. In this repository, that Slate value
is wrapped by `MaterialDocument`:

```text
MaterialDocument
└── schemaVersion: 1
    value: MaterialElement[]
        └── element { type, children, ...properties }
            └── text leaf { text, ...marks }
```

The application model is defined in
[`src/features/materials/document.ts`](../../src/features/materials/document.ts).
`createMaterialDocument` normalizes and validates values before they cross the
save/import boundary.

### Plugins are behavior, schema, and rendering composition

A resolved Plate plugin can contribute several different things:

- a unique plugin `key`;
- node metadata, including element/inline/void classification and the
  persisted node `type`;
- React node components or render wrappers;
- editor APIs and transforms;
- keyboard shortcuts, input rules, handlers, and decorators;
- injected node props or behavior targeted at another plugin;
- parsers/serializers for external formats;
- plugin options and plugin-specific runtime state.

The repository uses both plugin primitives:

- `createSlatePlugin` for logic-only behavior such as the custom
  `evo-autoformat` plugin;
- `createPlatePlugin` for React-aware behavior such as the save shortcut,
  discussion plugin, and study-block plugins.

Feature packages provide their own plugins. The application normally combines
them with `.configure(...)`, `.withComponent(...)`, or `.extend(...)` rather
than writing one large switch statement.

### APIs versus transforms

The v53 editor surface separates queries from mutations:

- `editor.api.*` reads or queries the tree, selection, DOM, and node state.
- `editor.tf.*` performs core transforms such as `setNodes`,
  `insertNodes`, `removeNodes`, `setValue`, `focus`, and `select`.
- Plugin-specific APIs and transforms are commonly accessed with
  `editor.getApi(Plugin)` and `editor.getTransforms(Plugin)`.

Examples in this repository include:

- `editor.api.findPath(element)` followed by `editor.tf.setNodes(...)` when a
  callout, equation, or code language changes.
- `editor.getTransforms(TablePlugin).table.merge()` for table operations.
- `editor.getTransforms(PlaceholderPlugin).insert.media(...)` for dropped
  files.
- `editor.getApi(AIChatPlugin).aiChat.submit(...)` and
  `editor.getTransforms(AIPlugin).ai.acceptPreview()` for AI.

The code intentionally uses `editor.getApi`/`editor.getTransforms` for many
plugin operations because those APIs are contributed by the resolved plugin,
while the core `editor.api`/`editor.tf` namespaces are used for general tree
operations.

## Runtime lifecycle in evo-notes

The editor is not mounted for every material mode. The entry path is:

```text
CenterContent
└── MaterialBody
    ├── view/study       → MaterialPreview / study views
    └── edit/suggestion  → lazy NoteEditor
                              └── CollaborativeNoteEditor
                                  └── EditorRuntimeProvider
                                      └── NoteEditorCore
                                          └── NoteBlockDialogsProvider
                                              └── Plate
                                                  └── CollaborationProvider
                                                      ├── NoteToolbar
                                                      ├── PlateContent
                                                      ├── FloatingToolbar
                                                      └── AiMenu (when enabled)
```

The main files are [`CenterContent.tsx`](../../src/features/materials/CenterContent.tsx),
[`NoteEditor.tsx`](../../src/features/notes/NoteEditor.tsx), and
[`EditorRuntime.tsx`](../../src/features/notes/EditorRuntime.tsx).

### 1. Material mode selects the surface

`CenterContent` asks `materialModePolicy` which modes the material and current
capabilities allow:

- `view` uses the static Plate renderer;
- `study` uses the action-oriented quiz/flashcard views;
- `edit` uses the interactive editor and direct autosave;
- `suggestion` uses the interactive editor but submits a suggestion instead of
  changing the material directly.

The interactive `NoteEditor` is lazy-loaded. View and study modes therefore do
not pay the cost of the editable Plate bundle.

### 2. `NoteEditor` loads data and checks capability

`NoteEditor` loads the material, rejects an unavailable material, and checks
the requested mode against `material.capabilities`. It then renders
`CollaborativeNoteEditor`, which loads:

- the current user;
- workspace members for mentions and author display;
- material discussions for comment marks and threads.

The component converts the member list into a `userId → member` map and passes
all runtime inputs into `NoteEditorCore`.

### 3. Runtime context carries application policy

`EditorRuntimeProvider` is deliberately separate from Plate's store. It
contains application policy that node components need but that is not part of
the Slate document:

- material and workspace IDs;
- current user and workspace role;
- `canEdit` and `canComment`;
- `edit` versus `suggestion` mode;
- the structural `allowExternalAssets` gate.

`useEditorRuntime` throws when used outside this provider. This gives media,
mention, study-block, toolbar, and collaboration components a stable
application context without placing non-document data in every Slate node.

### 4. Plugins are built once per runtime configuration

`NoteEditorCore` memoizes `buildPlugins(...)` using the workspace, user,
members, discussions, mode, asset gate, and save callback. The registry is
then passed to `usePlateEditor`:

```text
plugins = buildPlugins(runtime options)
editor = usePlateEditor({
  plugins,
  components: noteComponents,
  value: () => structuredClone(initialDocument.value)
})
```

The value factory is significant. It gives the editor a private initial tree
instead of letting Plate mutate the same object held in React state or the
material query cache. The memoized editor also prevents re-creating the
history, selection, and plugin state on ordinary React renders.

### 5. `Plate` provides the editor store

`<Plate editor={editor} onChange={onEditorChange}>` supplies the Plate/Slate
context consumed by `PlateContent`, toolbars, node components, plugin hooks,
and `CollaborationProvider`.

`PlateContent` is the editable surface. It must be below `Plate`; hooks such as
`useEditorRef`, `useEditorSelector`, and `useReadOnly` depend on that context.
The content component also controls the editor-level placeholder. A separate
`BlockPlaceholderPlugin` handles top-level block placeholders, so
`NoteEditorContent` keeps the two placeholder mechanisms mutually exclusive.

### 6. Application providers sit inside the Plate context

`CollaborationProvider` calls `useEditorRef`, so it is intentionally rendered
inside `<Plate>`. It owns the UI and API workflows for:

- creating and resolving discussions;
- adding replies;
- submitting suggestion drafts;
- accepting or rejecting suggestions;
- replacing the editor value after a server-side review.

The `NoteToolbar`, `FloatingToolbar`, and `AiMenu` are also children of
`Plate`, allowing them to read selection and plugin state directly.

### Shared insertion command catalog

`src/features/notes/editorCommands.ts` is the shared insertion catalog for the
slash menu and the responsive `All blocks` popover. Each command carries its
group (`basic`, `lists`, `media`, `advanced`, or `inline`), Lucide icon,
optional shortcut display, optional widget preference, and a runner that
reuses the existing Plate transforms.

The catalog includes headings `h1` through `h6`, lists (including task lists),
media placeholders, tables, callouts, all four column layouts, equations,
TOC, study/diagram blocks, mentions, and inline equations. Preferences filter
command surfaces but never unload the corresponding parser or renderer plugin.
The popover renders grouped rows with icons on the left and shortcuts on the
right; direct toolbar groups remain quick-access duplicates and may be hidden
by responsive layout.

## Plugin registry: what is always present

The registry is assembled in
[`src/features/notes/plugins.ts`](../../src/features/notes/plugins.ts).
`MaterialKit` is the universal document vocabulary. `buildPlugins` adds
runtime-only behavior around it:

```text
buildPlugins
├── AI plugins                       (when allowExternalAssets)
├── MaterialKit
│   ├── blocks, marks, lists, links, code, tables, TOC
│   ├── media, callout, columns, equations, mentions, styles
│   ├── quiz, flashcards, Mermaid
│   ├── Docx and Markdown parsers
│   └── Juice/HTML-related support
├── discussion, comment, suggestion
├── slash command and slash input
├── autoformat substitutions
├── mod+s save shortcut
├── block selection, context menu, and drag/drop
├── exit-break and trailing-block behavior
└── block placeholders
```

The registry is not reduced when a user hides optional commands in editor
preferences. Preferences filter toolbar and slash-menu entries only. Existing
document nodes must remain renderable even when their insertion command is
hidden; unloading a parser or renderer based on UI preferences would make
persisted content disappear or deserialize incorrectly.

### Base nodes, marks, and injections

The standard kits configure behavior rather than just HTML tags:

- headings and blockquotes have Markdown input rules and keyboard shortcuts;
- marks support Markdown variants and shortcuts;
- lists combine `ListPlugin` with `IndentPlugin`, task-list state, and injected
  list props;
- links add paste/space/break autolinking and a floating toolbar;
- code blocks use a `lowlight` instance with the common language set instead of
  bundling every grammar. Code blocks are intentionally excluded from list
  targets, and the editor removes inherited list metadata from them;
- font and alignment plugins inject leaf or element properties into selected
  target node types;
- `ExitBreakPlugin` and `TrailingBlockPlugin` keep block editing usable.

The list configuration is a good example of composition: `IndentPlugin` and
`ListPlugin` target normal list-compatible block types (paragraphs, headings,
blockquotes, and images). Code blocks deliberately sit outside those targets,
so a code block converted from a list item does not render a bullet or inherit
list indentation.

### Code-block shape and keyboard behavior

`CodeBlockPlugin` requires a nested node shape:

```text
code_block
└── code_line
    └── text
```

This nesting is functional, not cosmetic. The plugin's `insertBreak` transform
finds the active `code_line`, splits it, and inserts another `code_line` inside
the same `code_block`. Its plain-text and fragment paste transforms use the
same lookup to turn newline-separated content into code lines. Lowlight
decoration paths are also calculated through the line element.

A previous insertion path used the generic `editor.tf.toggleBlock('code_block')`.
That only renamed the current paragraph and produced `code_block → text`
(sometimes with an invalid `type: 'code_line'` property on the text leaf)
instead of wrapping a real `code_line`. As a result, Enter could fall back to
splitting the top-level block into a second code block, multiline paste could
fall through to normal block insertion, and syntax decorations had no valid
line paths to attach to.

All code-block insertion paths now use Plate's `toggleCodeBlock` through
[`src/features/notes/editorTransforms.ts`](../../src/features/notes/editorTransforms.ts).
The toolbar, editor commands, and keyboard shortcut therefore create the
required nested shape. (A pre-launch normalizer used to repair legacy
malformed code blocks on load; it was removed in Jul 2026 after a database
reset because no persisted documents predate the canonical shape.)

### Code-language highlighting

The code block stores the selected language in its `lang` property. Updating
that property causes `CodeBlockPlugin` to re-run lowlight decorations. For
example, JavaScript `console.log()` produces token classes such as
`hljs-variable language_` and `hljs-title function_`. The editable and static
`CodeSyntax` components forward each decoration's `leaf.className` to a
`span`; theme-aware rules in
[`src/styles/tailwind.css`](../../src/styles/tailwind.css) provide the colors.
Changing the selector's displayed value without changing `lang`, or failing to
forward the class name, leaves the text visually unhighlighted even though
lowlight can parse it.

### Custom node components

`noteComponents` in
[`src/features/notes/nodeComponents.tsx`](../../src/features/notes/nodeComponents.tsx)
maps persisted node types to editable React components. The components use
Plate primitives:

- `PlateElement` merges Slate attributes and Plate node props into the
  element's DOM output;
- `PlateLeaf` does the same for marks;
- `PlateText` is used for the AI text leaf;
- `useEditorRef`, `useEditorSelector`, `useElement`, and `useReadOnly` connect
  a component to runtime editor state.

The map covers ordinary nodes (`p`, `h1`–`h6`, `blockquote`, `a`, lists, and
marks) and richer nodes (`table`, `column_group`, `callout`, `toc`, `mention`,
equations, media, and study blocks).

Interactive node components follow a few rules:

- pass through `props.attributes` and `props.children`;
- use `contentEditable={false}` for controls, previews, portals, and other
  DOM islands that should not become editable text;
- use `data-plate-prevent-deselect` on controls that should not lose the Slate
  selection before their click handler runs;
- perform document changes through `editor.tf` or a plugin transform;
- derive paths with `editor.api.findPath(element)` instead of caching paths
  across transforms.

For example, code language, callout variant, equation source, table sizing,
and column layout all find the current node path and then transform node
properties. They do not maintain a second shadow document in component state.

## Editable versus static rendering

The application intentionally has two render pipelines over the same node
schema.

### Interactive pipeline

The editable pipeline uses:

```text
usePlateEditor → Plate → PlateContent
```

It has an editor store, selection, history, transforms, keyboard handlers,
plugin options, React hooks, floating controls, and side effects such as
autosave and uploads.

### Static pipeline

[`MaterialPreview.tsx`](../../src/features/materials/MaterialPreview.tsx)
creates a memoized headless editor with `createSlateEditor` and
`StaticMaterialKit`, then renders it with `PlateStatic`:

```text
createSlateEditor(StaticMaterialKit)
└── PlateStatic(value, staticNoteComponents)
```

`StaticMaterialKit` in
[`staticPlugins.ts`](../../src/features/materials/staticPlugins.ts) uses
`Base*Plugin` variants. `staticNoteComponents.tsx` uses `SlateElement` and
`SlateLeaf`, not `PlateElement` hooks or editor transforms. Static components
must be safe to render without a Plate store and without an editable DOM.

Static rendering is used for view mode, study previews, and public/share
surfaces. It also provides visual parity through shared classes from
[`nodeStyles.ts`](../../src/features/notes/nodeStyles.ts). When a node is
added to the editable registry, the static registry and static component map
usually need a corresponding update.

### Preview input resolution

`MaterialPreview` accepts either:

1. a versioned `MaterialDocument`, in which case it renders `document.value`;
2. raw Markdown, in which case it uses the Markdown plugin to deserialize it;
3. invalid input, in which case it logs in development and renders a plain
   paragraph fallback.

The editor and preview are therefore not two unrelated renderers. They share
the node vocabulary, Markdown rules, validation model, and styling, while
deliberately separating edit-only behavior from read-only behavior.

## Persisted document model

### Material envelope and IDs

The persisted content is a JSON `MaterialDocument`:

```json
{
  "schemaVersion": 1,
  "value": [
    {
      "type": "p",
      "id": "block_...",
      "children": [{ "text": "A note" }]
    }
  ]
}
```

`normalizeMaterialValue` adds a stable ID to every element and preserves
existing IDs. Every top-level block must have a non-empty, unique ID before a
document crosses the API boundary; suggestion scanning does not fall back to
array positions because reordering would change that identity. Those IDs
support:

- Plate drag/drop identity;
- `data-block-id` DOM targeting;
- discussion and suggestion anchors;
- custom study-block duplication and review;
- stable media identity.

`isMaterialDocument` validates that elements have children and a text
descendant, media nodes have an `assetId` and no persisted `url`/`src`, and
custom study nodes have the expected child shape and IDs. The validator is
application policy layered on top of Slate's general node model.

**Validator recursion pitfall (fixed Jul 2026):** `isMaterialNode` owns the
recursion into children; `isElementNode` is a shallow shape check only. An
earlier version recursed from both functions, so validation cost doubled per
nesting level (~2^depth) and a deeply nested document could hang the tab.
The "every element has a text descendant" invariant needs no separate
`hasTextDescendant` walk either: children must be non-empty and each valid
child inductively contains a text leaf. `document.test.ts` has a depth-40
regression test. The Go validator (`server/internal/materialdoc/document.go`)
still runs `hasTextDescendant` per element, which is O(n·depth) — acceptable
server-side but do not copy that shape back into the frontend.

### Media is an ID, not a URL

Media nodes store `assetId`, metadata, and a Plate media type (`img`, `video`,
`audio`, or `file`). They do not store signed URLs or browser blob URLs.

The flow is:

```text
placeholder node
  → uploadEditorAsset (reserve/upload/complete through workspace storage)
  → mediaNodeFromAsset(asset)
  → persisted assetId
  → MediaAssetView resolves a short-lived URL when rendered
```

This keeps document content stable when signed URLs expire and prevents a
temporary browser URL from becoming a database contract. See
[`MediaNodes.tsx`](../../src/features/notes/MediaNodes.tsx),
[`media.ts`](../../src/features/notes/media.ts), and
[`editorAssets.ts`](../../src/api/editorAssets.ts).

## Save and revision flow

Direct edit mode uses Plate's `onValueChange` as the boundary into the
application save protocol. It must stay `onValueChange`, not `onChange`:
`onChange` also fires for selection-only operations (caret moves), which must
not schedule saves or metric refreshes.

```text
Plate onValueChange
  └── onEditorChange            (cheap: no tree walk per keystroke)
      ├── discussion-mark application? ignore
      ├── debounced read-only metrics count (countMaterialMetrics, 1s)
      ├── suggestion mode? mark draft dirty, do not autosave
      └── edit mode → mark pending + reset 5-second debounce
          └── flush
              └── createMaterialDocumentWithMetrics(editor.children)
                  └── useUpdateMaterial(expectedRevision)
```

**Per-keystroke cost pitfall (fixed Jul 2026):** an earlier version ran
`createMaterialDocumentWithMetrics` (full normalize walk that rebuilds every
node, plus full validation) inside the change handler on every keystroke — up
to 10k nodes re-allocated per character typed. Slate's own normalization is
incremental (dirty paths only), so there is no built-in full-tree walk to
piggyback on; any walk in the change handler is a walk added on top. The
normalize/validate/serialize walk now runs once per debounced `flush`, against
the live `editor.children` at flush time. The normalize walk itself is minimal:
it assigns missing element ids and deep-copies the tree so payloads and parsed
snapshots never alias Slate's mutable `editor.children`. (Legacy-shape repair
was removed in Jul 2026 after a database reset; no persisted documents predate
the canonical schema.)

**Performance harness:** `pnpm perf` runs a dedicated Playwright suite
(`e2e/perf/`, own config — MSW mocks, no Docker) that measures typing latency
(Event Timing + Long Animation Frames with script attribution), the save-flush
cycle, and scroll FPS on a deterministic ~8k-node note seeded via
`VITE_PERF_SEED` (`src/mocks/perfSeed.ts`). `PERF_CPU` sets the CDP throttle
(default 4x). Budgets in `editor.perf.ts` are dev-build regression tripwires
calibrated Jul 2026, not UX targets. Calibration showed the remaining
large-document costs live in Slate/Plate `oninput` handling (~0.7s p95 per
keystroke at 8k nodes, dev build, 4x throttle), not in the application change
handler, which is O(1) since the Jul 2026 fix.

**Save acknowledgement optimization (Jul 2026):** PATCH previously returned
the full saved `Material`, so the browser JSON-parsed the 8k-node document and
`NoteEditor` then normalized it again in `materialDocumentSnapshot`. PATCH now
returns only `MaterialUpdateResult` (`id`, `revision`, `contentBytes`,
`updatedAt`). The query cache and `baseSnapshot` reuse the immutable,
already-normalized request document. Content-only autosaves also no longer
invalidate the workspace `MaterialRef` list because none of its fields change.
At 8k nodes under the dev-build 4x-CPU harness, save-cycle blocking fell from
roughly 2.3s to 1.3s; the remaining cost is primarily request serialization,
server/mock validation, and the cache notification render.

`NoteEditorCore` keeps:

- `baseSnapshot` — the last known server document and revision;
- `revisionRef` — the revision expected by the next mutation;
- `pending` — dirty flag; the document is serialized at flush time;
- `saveTimer` — the debounce timer;
- `metricsTimer` — the stats-footer refresh debounce;
- `saveInFlight` — a single request guard;
- `saveState` — `saved`, `pending`, `saving`, or `error`.

Important behavior:

- Each edit marks the document dirty and resets the five-second timer; the
  payload is built from the live editor value when the timer fires.
- A save sends `expectedRevision`, so two browser sessions cannot silently
  overwrite each other.
- A successful response updates the base snapshot and revision.
- If more edits arrived while a request was in flight, the next pending value
  is saved after the normal debounce rather than being sent in a burst.
- A failed request re-marks the document dirty and exposes the error state.
- Unmount attempts a final flush.
- Server-applied discussion marks are wrapped in `editor.tf.withoutSaving` and
  guarded by `applyingDiscussionMarks`, so merely decorating a loaded document
  does not create an autosave.
- `createMaterialDocument` strips `comment` and `comment_<discussionId>` marks
  during normalization. A later user edit can therefore save the real content
  without leaking loaded runtime comment decorations into material JSON.

This is optimistic concurrency with server revisions, not realtime
multi-cursor editing. Plate's editor state is local to the browser; the Go
API and material revision are the authority for persistence.

## Suggestion mode and collaboration

The repository uses Plate's comment and suggestion plugins for rendering and
interaction. The persisted Plate JSON is the source of truth for active
suggestion operations and diffs; collaboration tables supply lifecycle and
discussion data without duplicating that content authority.

### Discussions/comments

`buildCollaborationPlugins` creates:

- `discussionPlugin`, an application plugin whose options contain the current
  user, discussion records, and member directory;
- a configured `BaseCommentPlugin` with `CommentLeaf` and the
  `mod+shift+m` draft shortcut;
- the configured `BaseSuggestionPlugin`.

When discussions load, `NoteEditorCore` applies comment marks at each
revision-relative anchor:

```text
discussion.anchor
  → editor.tf.setNodes(
      { [KEYS.comment]: true, [getCommentKey(discussion.id)]: true },
      { at: anchor, match: TextApi.isText, split: true }
    )
```

Stale comment ranges are caught and ignored for decoration. Collaboration
items render in a **per-block popover**: `BlockDiscussion`
(`render.aboveNodes` of the discussion plugin) matches by the stable top-level
`blockId` and renders a "Show N collaboration items" trigger next to that
block. Clicking a rendered suggestion or comment mark also sets the
corresponding active ID, opens the owning block popover, filters to that item,
and keeps the card/mark hover state synchronized.

Creating a normal comment saves the selected range, stable block ID, and rich
comment content to the API, then applies the returned discussion ID as a
decoration-only comment mark inside `withoutSaving`. Normal comment
discussions render as standalone thread cards. A discussion linked to a
suggestion renders its comments and one-level replies inside that suggestion's
card instead of duplicating them as a second thread card. The same
`DiscussionComments`/`CommentEntry` interaction is used for both discussion
kinds, so a root comment in a suggestion card exposes the same `Reply` action
as a normal comment. The action sends the existing `parentCommentId` field;
the database contract and one-level nesting limit are unchanged.

### Suggestions

Suggestion mode changes the meaning of an editor change:

- typed insertions become suggestion insert marks;
- deletions remain in the tree as removal suggestions;
- `SuggestionLeaf` renders inserts as `<ins>` and removals as `<del>`;
- block suggestions and void removals get custom wrappers/overlays;
- local edits set `suggestionDirty` rather than entering the autosave queue.

Submitting a draft sends the **complete marked `MaterialDocument`** plus
`expectedRevision` to `POST /api/materials/{id}/suggestion-commits`. It does not
send original/proposed fragments or construct a separate submitted anchor.
The full commit remains revision-guarded: a stale revision is rejected rather
than overwriting the current head.

The server validates stable top-level block IDs, scans `suggestion` and
`suggestion_<id>` metadata, and stores the marked document as the next material
revision. Each scanned change is keyed by `(blockId, Plate suggestion ID)`.
`scanSuggestions` derives operation, before/after preview, line-break state,
and block association directly from that revision head.

Relational suggestion rows are deliberately narrower lifecycle projections.
They hold the Plate ID, status, author, reviewer/timestamps, commit and
resolution revisions, and discussion linkage. They do **not** own operation
or preview data. `joinActiveSuggestions` joins each pending lifecycle row to
the current Plate scan; unmatched Plate metadata remains visible as an orphan
so imports or interrupted migrations do not make active changes unreviewable.

This boundary was introduced as a destructive clean-schema change:
`0001_init.sql` no longer defines operation or preview columns on
`material_suggestions`. There is no backfill, fallback read, or dual-write
compatibility path for databases created from the older projection shape.

Accept/reject is finalized by
[`finalizeSuggestionValue`](../../src/features/notes/suggestions.ts):

- accepting removes `remove` content and strips the selected suggestion
  metadata;
- rejecting removes `insert` content and strips the selected suggestion
  metadata;
- all remaining nodes retain normal document properties and stable IDs.

Review and withdrawal send raw Plate IDs with the current expected revision.
The server resolves those IDs against the marked revision head, updates the
lifecycle rows, and returns the replacement material state only after the
atomic mutation succeeds.

Suggestion cards render the operation and before/after preview from the joined
Plate scan. DB lifecycle fields provide attribution, status, permissions, and
review controls only. This avoids stale denormalized previews after the same
Plate suggestion is edited.

### Submitted suggestions in every material mode

The marked material revision head already contains all pending suggestion
metadata, so interactive Edit/Suggestion surfaces and static View rendering
read the same document vocabulary. `<ins>`, `<del>`, block suggestions, and
line-break markers remain visible after submission and reload. The detailed
card and review controls stay in the stable block's collaboration popover;
clicking a mark focuses that item directly.

Accepted, rejected, or withdrawn IDs are projected out of the document during
the revision-guarded review mutation. Their lifecycle rows may remain for
history, but they no longer supply active diff content and no longer render as
pending marks.

### `withoutSuggestions` pitfalls (fixed Jul 2026)

While suggesting mode is on, **every** editor transform is recorded as a
suggestion — including programmatic ones the user never made. Two concrete
bugs came from this:

- **Phantom trailing line:** `TrailingBlockPlugin` inserts an empty paragraph
  whenever the last block isn't one. In suggesting mode that insert got
  `insert` suggestion marks, so every draft showed an appended line the user
  didn't type. Fix: `suggestionSafeTrailingBlockPlugin`
  (`collaborationPlugins.ts`) overrides the plugin's `insert` option to run
  inside `editor.getApi(BaseSuggestionPlugin).suggestion.withoutSuggestions`.
- **Whole-file delete/re-add diff:** `replaceEditorDocument` in
  `NoteEditor.tsx` calls `editor.tf.setValue` when server content replaces
  local content (e.g. after submitting a draft). Unwrapped, the replacement
  itself was recorded as "delete everything, insert everything". The
  `setValue` is now wrapped in `withoutSuggestions` too.

Note the API lives on `editor.getApi(BaseSuggestionPlugin)` — getting the API
via the locally configured `suggestionPlugin` object does not type-expose
`suggestion.withoutSuggestions`.

**Block wrapper vs. tables/columns:** the suggestion plugin's
`render.belowNodes` line-break wrapper (`SuggestionLineBreak` in
`Collaboration.tsx`) used to wrap children of every suggested block in a
`<div>`. Inside `table`/`tr`/`td`/`th` that inserts an invalid element between
table parts and collapses cell widths; inside a `columnGroup` it destroyed the
flex row so columns collapsed. It is now element-type-aware: table-family
elements render children with no wrapper, `columnGroup` keeps the wrapper but
with `flex size-full gap-2`.

### The single-configuration-slot pitfall

Plate plugins have one effective configuration slot. A later `.configure(...)`
can replace earlier configuration instead of merging the parts a developer
expects. This matters for the suggestion plugin because it needs both:

- stable render/injection configuration (`<ins>`, `<del>`, block wrappers);
- runtime options (`currentUserId`, `isSuggesting`, active/hover IDs).

The repository puts the structural render/inject configuration in the
module-level `suggestionPlugin` and supplies runtime values through the one
configuration path used by `buildCollaborationPlugins`. The regression tests in
[`Collaboration.test.tsx`](../../src/features/notes/Collaboration.test.tsx)
protect against the renderer being silently dropped or suggestion authors
being normalized away.

## AI integration

AI plugins are added by `buildAiPlugins` when the structural
`allowExternalAssets` gate is enabled. The editor mode still separately gates
uploads: `canCreateExternalEditorAssets` only returns true in `edit` mode.
The gate is a UI/runtime policy, not a replacement for backend authorization.

The AI stack has three layers:

```text
AiMenu / keyboard shortcuts
  → @platejs/ai/react plugin APIs
      → @ai-sdk/react useChat
          → DefaultChatTransport
              → Go /api/workspaces/:workspaceId/ai/*
                  → retrieval/AI service
```

### Command chat and streamed edits

`PlateAi.tsx` creates an `AIChatPlugin` around `useChat`:

- command chat uses `/api/workspaces/{workspaceId}/ai/command`;
- the chat ID is scoped to the material;
- streamed `data-toolName` selects `comment`, `edit`, or `generate`;
- table updates are applied with `applyTableCellSuggestion` inside
  `withAIBatch`;
- AI comments are converted to a Slate range with `aiCommentToRange`, saved as
  a material discussion, and then applied as a comment mark;
- generated inserts start a Plate AI preview, insert a transient AI-chat
  anchor, and stream text with an AI mark;
- edit operations apply AI suggestions as a preview rather than silently
  replacing the user's selection.

`AiMenu` makes the preview explicit: the user accepts or rejects it. This is
important for save semantics and for avoiding an invisible AI mutation.

### Copilot

`CopilotPlugin` uses `/api/workspaces/{workspaceId}/ai/copilot`. Its prompt is
the highest current block serialized as Markdown. A completion is stripped of
Markdown before being shown as ghost text; `Tab`, `mod+right`, `Escape`, and
`ctrl+space` control accept, word-accept, reject, and trigger behavior.

### Transport boundary

[`plateAiTransport.ts`](../../src/api/plateAiTransport.ts) wraps the AI SDK
transport with authenticated fetch. Before sending JSON, it recursively removes
browser-controlled `apiKey`, `key`, `model`, and `provider` fields. Provider
selection and credentials therefore stay server-controlled even if a caller
passes a body copied from a Plate Playground example.

The transport tests in
[`plateAiTransport.test.ts`](../../src/api/plateAiTransport.test.ts) cover
workspace URL encoding, recursive field removal, and preservation of
non-JSON streaming bodies.

## Rich blocks and node-specific behavior

### Tables

`TablePlugin`, `TableRowPlugin`, `TableCellPlugin`, and
`TableCellHeaderPlugin` define the table schema and transforms. The custom
[`TableNodes.tsx`](../../src/features/notes/TableNodes.tsx) components add:

- a `TableProvider` around each table;
- selected-cell DOM behavior;
- calculated column sizes and a `<colgroup>`;
- row and column drag handles;
- cell merge/split controls;
- row/column insertion and deletion;
- resize handles from `@platejs/resizable`;
- a floating toolbar that appears for a focused cell or multi-cell selection.

Block selection deliberately excludes table cells and other nested structures
so `mod+a` and text selection continue to work inside a table.

### Columns/layout

`ColumnPlugin` and `ColumnItemPlugin` model a `column_group` containing
`column` elements. Each column persists a width such as `50%`. The custom
components use `setColumns` for layout changes and constrain horizontal
drag/drop to columns with the same parent.

The static renderer reads the persisted width and applies the same CSS custom
property, so a `66.667% / 33.333%` layout does not collapse to equal columns
in view mode.

### Media

The editable registry uses the React variants of `ImagePlugin`, `VideoPlugin`,
`AudioPlugin`, `FilePlugin`, and `PlaceholderPlugin`. A placeholder is an
intentional transient node that gives the user a drop/click target and upload
progress. `MediaPlaceholderElement` replaces it with an asset node only after
the upload completes.

The `DndPlugin` file-drop handler inserts media placeholders only when the mode
and asset gate allow side effects. `@platejs/media` handles the editor-side
placeholder lifecycle; the application handles storage, authorization, and
asset URL resolution.

### Study blocks

Quiz, flashcard, and Mermaid blocks are application-owned Plate element trees.
The plugin declarations are in
[`blocks/plugins.ts`](../../src/features/notes/blocks/plugins.ts), and editing
components are in
[`blocks/elements.tsx`](../../src/features/notes/blocks/elements.tsx).

Examples of persisted shapes:

```text
quiz
└── quiz_question
    ├── quiz_prompt
    ├── quiz_option*
    └── quiz_explanation?

flashcards
└── flashcard
    ├── flashcard_front
    └── flashcard_back

mermaid
└── mermaid_caption
```

The document validator enforces these relationships, including IDs and
question metadata. Dialogs edit the domain representation and convert it back
to a Plate tree with `quizNodeFromFence` or `flashcardsNodeFromFence`.

### Links, equations, callouts, and TOC

- Links use Plate's link plugin for validation/autolinking, then the custom
  component prevents accidental navigation while editing and opens a link only
  when the user holds `Ctrl`/`Cmd`.
- The link dialog clones the current Slate range before moving focus into its
  native inputs, restores that range before `upsertLink`, and initializes the
  displayed-text field from the selected text. Without the saved range, modal
  focus can make link insertion target the wrong cursor position or fall
  through to normal Enter behavior.
- Equations store `texExpression` and render through the app's lazy KaTeX
  component. Editing changes the node property through `setNodes`.
- Callouts store a `variant` and render an icon plus nested paragraph content.
- The editable TOC uses `@platejs/toc` heading state, scrolls to the matching
  DOM node, and flashes the target through Plate navigation transforms.
- The static TOC derives headings from the static editor value and scrolls the
  preview DOM without selecting an editor range.

## Slash commands, mentions, and block interactions

### Slash commands

`SlashPlugin` creates the inline combobox node and `SlashInputElement` renders
the native input and popup. The command list in
[`editorCommands.ts`](../../src/features/notes/editorCommands.ts) is
application-owned so commands can open quiz/flashcard dialogs or insert custom
nodes.

The command flow is:

```text
type "/"
  → Plate creates slash input node
  → SlashInputElement tracks query with a native input
  → PointRef tracks the insertion point before the input
  → command is chosen
  → remove input and restore Slate point
  → command runs an editor transform or opens a dialog
```

The `PointRef` is necessary because focusing a nested native input can clear
Slate's selection. The component also distinguishes command selection from a
real blur so it does not restore stale slash text after inserting a new node.

Preferences only hide commands. `isEditorCommandAllowed` additionally hides
media commands in suggestion mode, because uploads are external side effects.
The corresponding plugin remains registered so existing media nodes still
render.

### Mentions

Typing `@` activates `MentionInputElement`. It queries workspace members,
tracks the point before the inline input, and uses Plate's
`getMentionOnSelectItem` to replace the input with an inline mention. Like the
slash input, it defers blur handling because nested input focus can temporarily
clear the Slate selection.

The saved mention contains the member identity/value, while the renderer
displays the current member label. Member directory loading is therefore a
runtime dependency, not a reason to duplicate user profile data in every
mention node.

**Dropdown clipping pitfall (fixed Jul 2026):** both combobox dropdowns must
render through `FloatingPortal` (floating-ui), not inline under the input
node. The inline version was clipped/hidden when the input sat inside a
heading or any ancestor with overflow/transform, so "@ inside a heading"
appeared to do nothing. `MentionInput.tsx` now portals its listbox the same
way `SlashInput.tsx` does.

### Block selection and drag/drop

The interaction layer was ported from `plate-playground-template` in Jul 2026
(`BlockInteractions.tsx` + `BlockSelection.tsx`) after the earlier simplified
version left right-click selection, handle-click selection, and the selection
overlay non-functional. The moving parts:

- `BlockSelectionPlugin` itself injects a `slate-selectable` class and a
  right-click `onContextMenu` handler into every selectable block via
  `inject.nodeProps` (`useBlockSelectable`). Right-click selection therefore
  works at the plugin level once `enableContextMenu: true` is set — what was
  missing was the **visual** layer: a `render.belowRootNodes` component
  (`BlockSelectionBelowRootNodes`) that renders an absolute overlay inside
  each selected block. Plate injects `position: relative` on selectable block
  elements, so the overlay anchors per block.
- The overlay must be a `<span>` (styled block), not a `<div>`: it renders
  inside the block element itself, which can be a `<p>` where nested `<div>`
  is invalid HTML.
- `BlockDraggable` wraps root blocks **and** blocks nested in columns (path
  length 3) and table cells (path length 4). The drag handle's `onMouseDown`
  sets the block selection (expanding list items with
  `expandListItemsWithChildren`) and builds a stacked multi-block drag
  preview; `onClick` calls `blockSelection.focus()`.
- `BlockContextMenu` is a Radix `ContextMenu` (`src/components/ui/ContextMenu.tsx`)
  whose items operate on the block selection transforms (`duplicate`,
  `removeNodes`, `setIndent`, `setNodes({ align })`, turn-into via
  `toggleEditorBlock` per selected path).
- The `.slate-selection-area` marquee rectangle is styled through arbitrary
  variants on `PlateContainer` in `NoteEditor.tsx`.
- `CursorOverlayPlugin` is registered unconditionally: the AI plugin set
  brings its own variant (hides during streaming); non-AI editors get
  `EditorCursorOverlay` from `BlockSelection.tsx`.

**Deselect-on-mousedown pitfall (Jul 2026):** the plugin registers an
editor-level `onMouseDown` that clears the block selection on any left click.
Its escape hatch checks `event.target.dataset.platePreventDeselect`
**directly on the event target — no `closest()`** — and in the published
`@platejs/selection` 53.1.6 dist one of the two dataset keys is even mangled
by minification. A click that lands on an SVG icon inside a
`data-plate-prevent-deselect` button therefore still deselects. The reliable
fixes used in `DragHandle`: call `event.stopPropagation()` in the handle's
`onMouseDown` (the plugin handler sits on the editable root, so stopping
propagation is deterministic) and give icons `pointer-events-none`.

Nested table rows/cells and columns have their own drag behavior and are
excluded from the root block wrapper (`UNDRAGGABLE_KEYS`). The block draggable
uses `MemoizedChildren` so the extra gutter/handle does not disturb the
editable subtree. `isSelectable` excludes `column`, `code_line`, and `td` so
text selection keeps working inside nested structures, while their top-level
ancestors remain block-selectable; the template's progressive `mod+a`
(select block text → select all blocks) is enabled (no `disableSelectAll`).

## Markdown, JSON, and DOCX boundaries

The shared Markdown configuration is in
[`src/features/notes/markdown.ts`](../../src/features/notes/markdown.ts).
It configures:

- GitHub Flavored Markdown;
- math;
- MDX;
- emoji shortcodes;
- custom rules for the `quiz`, `flashcards`, and `mermaid` fences.

The custom fence contract is intentional:

````text
```quiz
<YAML>
```
↔ quiz element tree
````

Unknown code fences become the normal `code_block`/`code_line` tree. Custom
study blocks serialize back to their existing fence formats so the Go backend
and read-only renderer can continue to consume the same representation.

[`documentAdapters.ts`](../../src/features/notes/documentAdapters.ts) provides
the application boundary:

- Markdown deserialization through `MarkdownPlugin`, followed by link
  sanitization and `createMaterialDocument`;
- JSON import through `assertMaterialDocument`, followed by the same
  sanitization;
- lazy DOCX import/export through `@platejs/docx-io`;
- Markdown, DOCX, and JSON downloads.

The DOCX package is loaded only when the user chooses a DOCX operation, keeping
Mammoth/JSZip/XML code out of the initial editor chunk.

## Adding a new Plate node or feature

Use this checklist for a new persisted editor feature:

1. Define the persisted node shape and invariants in
   [`document.ts`](../../src/features/materials/document.ts). Add IDs or
   validation when the node participates in anchors, drag/drop, or domain
   actions.
2. Add the plugin to `MaterialKit` in `plugins.ts`. Use a base plugin in the
   static kit as well.
3. Add the editable component to `noteComponents`, using `PlateElement`,
   `PlateLeaf`, or a plugin's component registration.
4. Add a hook-free static component to `staticNoteComponents` and keep the
   CSS class shared through `nodeStyles.ts`.
5. Add insertion/UI paths: toolbar, slash command, dialog, or paste/input
   rule. Do not make the UI preference the source of truth for whether an
   existing node is supported.
6. Add Markdown or DOCX rules if the node must round-trip through an external
   format.
7. Decide which changes are user document edits and which are runtime
   decoration. Use `withoutSaving` plus an explicit guard for the latter.
8. Add tests for document validation, editable behavior, static rendering,
   import/export, and any API/revision workflow.
9. Verify both edit and suggestion modes, because external side effects and
   save semantics differ.

For logic that does not render React, prefer `createSlatePlugin`. For a
React-aware node or render wrapper, use `createPlatePlugin` or the package's
React plugin variant. Keep the plugin's `key` and persisted node `type`
stable; changing either is a document migration, not just a UI refactor.

## Common failure modes

### A hook throws that there is no editor context

`PlateContent` or a component using `useEditorRef`/`useReadOnly` is outside
`<Plate>`. Move it below the provider, or use the static `SlateElement`/`SlateLeaf`
path if the surface is intentionally read-only.

### A node renders as a generic paragraph or disappears in previews

Check all three registrations:

1. the node/plugin schema;
2. `noteComponents` for the editable path;
3. `StaticMaterialKit` and `staticNoteComponents` for the static path.

Also check that a UI preference did not accidentally remove a plugin from
`buildPlugins`.

### Suggestions render as plain text or lose their author

Check the single `.configure(...)` path on `BaseSuggestionPlugin`. A runtime
options configuration must not replace the structural renderer/injection
configuration. Also ensure `currentUserId` is available or the stable fallback
is supplied before the first suggestion keystroke.

### Clear formatting appears to do nothing

`editor.tf.removeMarks()` with no arguments only clears marks at a collapsed
cursor; over an expanded selection it is a no-op. Formatting must be cleared
with an explicit key list — `clearEditorFormatting` in
[`editorTransforms.ts`](../../src/features/notes/editorTransforms.ts) passes
`CLEARABLE_MARK_KEYS` (bold/italic/underline/strikethrough/code/sub/super,
highlight, kbd, colors, font size/family/weight, line height). Route any
"clear formatting" UI through that helper instead of calling `removeMarks`
directly.

### A discussion mark causes a save or a stale anchor crashes rendering

Discussion anchors are revision-relative. Mark application is guarded and
wrapped in `withoutSaving`; stale anchors are intentionally ignored for
decoration. The discussion thread remains the recovery surface.

### A URL or media preview is not stable

Do not persist `url`, `src`, or signed URLs. Persist an asset ID and resolve a
short-lived URL in `MediaAssetView`. Run imported links through the existing
validation path.

### The editor resets unexpectedly

Look for an unstable `plugins` array, an unstable `usePlateEditor` dependency,
or a changed React key based on material ID and mode. The editor instance
contains selection, history, plugin options, and transient previews; recreating
it is not equivalent to rerendering a component.

### Enter, paste, or highlighting breaks inside a code block

Inspect the persisted tree before changing keyboard handlers. A valid code
block must be `code_block → code_line → text`; using generic `toggleBlock` for
code blocks creates a malformed `code_block → text` tree and prevents Plate's
code-specific break, paste, and decoration transforms from matching. Route
toolbar, command, and shortcut insertion through `toggleCodeBlock`. Do not
reintroduce a custom `onKeyDown` workaround: it can intercept the plugin's own
Enter behavior and does not fix malformed persisted nodes.

### AI controls are visible but the request fails

The frontend transport authenticates and scopes the workspace URL, but the
backend still controls authorization and provider configuration. Inspect the
Go gateway/pipeline AI route rather than adding provider credentials to the
browser request.

## Tests and useful entry points

The most relevant tests are:

- [`Collaboration.test.tsx`](../../src/features/notes/Collaboration.test.tsx)
  — suggestion plugin configuration and authored insert/remove marks;
- [`suggestions.test.ts`](../../src/features/notes/suggestions.test.ts)
  — accepting/rejecting marked values;
- [`insertEditorNode.test.ts`](../../src/features/notes/insertEditorNode.test.ts)
  — replacing empty paragraphs and selecting inserted nodes;
- [`editorMode.test.ts`](../../src/features/notes/editorMode.test.ts)
  — edit/suggestion side-effect policy;
- [`media.test.ts`](../../src/features/notes/media.test.ts)
  — media purpose/type and stable asset node behavior;
- [`document.test.ts`](../../src/features/materials/document.test.ts)
  — material schema, normalization, and custom block invariants;
- [`editorTransforms.test.ts`](../../src/features/notes/editorTransforms.test.ts)
  — code-block shape, Enter, multiline paste, and JavaScript decorations;
- [`staticNodeComponents.test.tsx`](../../src/features/materials/staticNodeComponents.test.tsx)
  — static rendering parity and safe link handling;
- [`plateAiTransport.test.ts`](../../src/api/plateAiTransport.test.ts)
  — AI endpoint scoping and request sanitization.

Browser-level editor behavior (block selection, context menu, drag/drop,
mention/slash dropdowns, table/column insertion, suggestion mode) is covered
by the MSW-based Playwright matrix in `e2e/editor/` — run it with
`pnpm e2e:editor`; see the [testing page](../testing/e2e-and-unit.md) for the
spec breakdown.

Run the frontend checks with:

```bash
pnpm typecheck
pnpm test
```

When changing a plugin or node, test both the interactive editor and
`MaterialPreview`. A passing edit-mode test is not enough if the same persisted
value is later rendered in view, study, or public-share mode.
