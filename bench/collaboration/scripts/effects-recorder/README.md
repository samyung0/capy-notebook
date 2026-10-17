# Effects recorder

Records the real yrs update streams the BetterOffice editors write, through
Capy's own Office runtime page, for the effects-reader investigation
(capy-harness `2026-10-17-effects-misses`). Recording format:
`recordings/FORMAT.md` in that folder.

- `host.html`, `host.ts`: the page that plays Capy around the runtime frame
  (`useOfficeRuntime.ts` + `roomProvider.ts` wiring, one Yjs doc per peer, a
  relay for the server) and records what the provider would send.
- `vite.recorder.config.ts`: Capy's `vite.config.ts` on port 4793, own cache,
  no watcher, no browser window.
- `session.ts`, `drivers.ts`, `cases.ts`, `record.ts`: headless Chromium,
  mouse/keyboard/menu primitives, the scripted cases, the runner.
- `check/`: native cargo project over collaboration-rs's crates and lockfile:
  `seed` (the server seed, `office_service::seed`) and `check` (replay on the
  seed through `sources::admit_update`, pending structs, equality with the
  editor's replica, engine effects and export).
- `ootext.py`: visible text per story of an Office file, and text diffs.
- `explore.ts`: opens one fixture and dumps the editor DOM and menus.

Setup in a worktree (no `pnpm`): junction `node_modules` to a frozen install,
`bun install --frozen-lockfile` in `vendor/betteroffice`, then
`setup/build-under-lock.sh` (takes the machine's heavy lock).

```bash
node_modules/.bin/tsx bench/collaboration/scripts/effects-recorder/record.ts 'docx-type'
node_modules/.bin/tsx bench/collaboration/scripts/effects-recorder/record.ts --fixture book-30p
```
