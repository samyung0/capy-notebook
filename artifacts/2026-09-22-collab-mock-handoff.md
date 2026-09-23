# Handoff: in-page collaboration mock, source editing under MSW, chaos peers

Date: 2026-09-22. Uncommitted, on `main`. For a reviewing agent: read this,
then `git diff` the files below. The recorded decisions are the bullets dated
2026-09-22 in `human/miscellaneous.md`; the behaviour doc is the "Source
collaboration" and "Chaos peers" bullets in
`openwiki/frontend/msw-scenarios-audit.md`. One Opus review round has already
run and its findings were resolved (see "Review round 1"); do not repeat it,
review the current tree.

## What changed and why

Under MSW no file could enter Edit: `useSourceSession` waits for a
`HocuspocusProvider.onSynced` that never comes, so txt/md/csv/json and the
Office kinds sat on "Loading…". Notes already worked through a Plate `mock`
provider in `src/mocks/collaboration.ts`. That module is now a general in-page
room layer, source editing has a provider seam, and a `collab-chaos` user
scenario ports `collaboration/scripts/chaos-peers.ts` into the page.

### Files

| File | Change |
| --- | --- |
| `src/mocks/collaboration.ts` | Rewritten. `Room` = one Y.Doc + participants; `join()` merges both ways, relays doc updates (tagged with each participant's `origin`) and awareness updates (y-protocols encode/apply), drops the room with its last participant. `MockCollaborationProvider` (Plate type `mock`) joins through it. New `MockSourceProvider` for text sources: `onSynced` on a microtask, `checkpoint-request` → `checkpoint-persisted` (microtask) and writes the room text to `db.fileLinks[id].url`. `sourceRoomName(id, epoch)` = `source:<id>:epoch:<n>` (sidecar shape). |
| `src/features/files/sourceProvider.ts` | New seam: `SourceProvider` interface, `createSourceProvider` (Hocuspocus when `!USE_MSW`; under MSW the registered mock, and throws if none is registered). |
| `src/features/files/useSourceSession.ts` | `new HocuspocusProvider(...)` → `createSourceProvider(...)`; provider typed as `SourceProvider`. Nothing else. |
| `src/mocks/handlers.ts` | `mockSourceSession()`; `GET /api/files/:id/source-session` answers text sources (`data:text/plain` mock links) and 503 for everything else; `POST /api/files/:id/collaboration-token`; `mockWorkspaceMembers` exported. |
| `src/mocks/chaosPeers.ts` | New. `setChaosPeers(enabled)`: 1 s sweep; every room with a non-peer participant gets 3 `ChaosPeer`s (headless Plate editor with `MaterialKit` + `@slate-yjs/core` `withYjs`/`withCursors` for material rooms; `Y.Text('source')` inserts for source rooms). Peers join/edit/move cursors/leave/rejoin on timers (same ranges as the script), skip void blocks, register as workspace editors and invalidate the members query. |
| `src/mocks/scenarios.ts`, `src/mocks/scenarios.test.ts` | `collab-chaos` option; it is runtime-only (no handlers), excluded from the handler-mapping assertion like `offline`. |
| `src/components/dev/MockScenarioPanel.tsx` | `setChaosPeers(scenario === 'collab-chaos')` on mount and apply; off on unmount. |
| `package.json` | `y-protocols@1.0.7` devDependency (was transitive only). |
| `e2e/editor/frontend-workspaces.spec.ts` | Sort spec follows the Workspaces default changed on 2026-09-21 (Created, newest first). Pre-existing drift, unrelated to the mock. |

Production path: `USE_MSW` is `MODE === 'development'` only; `sourceProvider.ts`
imports nothing from `src/mocks`; registration happens in the dev-only dynamic
import in `src/main.tsx`; the `useSourceSession` diff is a type/constructor
swap.

## Review round 1 (Opus, high) and what was done

Bugs, all fixed: relayed updates carried the room as Yjs origin so
`useSourceSession` treated peer edits as local (now tagged with the receiving
provider); peers built on a plugin-less Slate editor and normalization stripped
`a`/`mention`/`inline_equation` (now `createSlateEditor({ plugins: MaterialKit })`);
peers typed into void blocks (now skipped via `editor.api.void`);
`sourceRoomState` spread the whole update into `String.fromCharCode` (now
chunked).

Risks, all fixed per Epo: silent fallback to a real provider under MSW (now
throws); awareness teardown was the inverse of Hocuspocus (now others forget
the leaver, the leaver forgets the others); rooms were never released (dropped
with the last participant).

Fidelity, done: sidecar room name; checkpoint receipt on a microtask; cursor
positions sent by hand (`autoSend: false`, the script's own flaw); members
query invalidated. Skipped on purpose: mock checkpoints do not bump
`file.revision`, so draft recovery, handoff and epoch changes stay outside MSW
(documented in the audit).

## Verified

- `pnpm typecheck`, `ultracite`, `vitest run src/mocks/scenarios.test.ts src/features/notes/Collaboration.test.ts` pass.
- Editor Playwright suite (`pnpm e2e:msw:editor`, one worker): 39/39 after the sort-spec fix.
- Throwaway Playwright runs (deleted, not in the tree): open `/files/f_2`, Edit
  → textarea shows the text, typing shows "Saved", View shows the edit and so
  does reopening through client navigation; with `collab-chaos` on, peer text
  appears in the textarea and the status stays "Saved"; on the seeded note,
  `[data-remote-cursor]` decorations for Avery/Blake/Casey appear, peer
  snippets land in the text, `GET /api/workspaces/ws_bio/members` lists the
  three peers while the scenario runs and drops them on reset; cursors clear
  on reset; the collaboration-token room is `source:f_2:epoch:1`.

## Known limits and things worth a second look

- No committed test covers `join()` relay/leave semantics, the `SourceProvider`
  seam or the peers. A small vitest for `join` (two participants, origin
  tagging, awareness removal on leave, room dropped when empty) would be the
  cheapest guard. If added, list it in `openwiki/test-catalog.md`.
- Office kinds (docx/xlsx/pptx) answer 503: the regular mock db has no Office
  fixtures, only the error-scenario `dialogFiles`.
- A page reload resets rooms and `fileLinks` (module state), like every other
  MSW fixture.
- The material mock provider still answers checkpoints synchronously;
  `NoteEditorCore` documents and handles that. Only the source provider was
  moved to a microtask.
- `MockScenarioPanel.apply` resets queries and remounts routes, so enabling
  `collab-chaos` while a file is in Edit drops it back to View; enable the
  scenario first.
- Peer edits use `editor.tf.insertText`/`insertNodes` at random text leaves,
  including the H1 title block; the sidecar script does the same.
- Playwright cleans `test-results/` on each run; anything parked there is lost.

## How to try it

```bash
pnpm dev
```

Open a note (`/workspaces/ws_bio`) or `/files/f_2`, open the "User scenarios"
panel bottom-right, pick "Collaboration: chaos peers join and edit", Apply.
For a source file, apply the scenario before switching to Edit.
