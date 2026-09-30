# Banner redesign handoff (2026-09-29)

Mocks: `artifacts/2026-09-28-banner-mocks.html` (https://dqt8rskh07mz.postplan.dev, v4, approved).
Decisions: `human/frontend/error-handling.md` (the 2026-09-28 bullets), `human/frontend/office-files.md` (the newer-version banner is closable).
Docs: `openwiki/frontend/error-handling.md`.
Nothing is committed. The changes are on `main` alongside other sessions' edits (Mermaid, parser); commit only the files below.

## Files

New
- `src/components/banners/FileBanner.tsx`: the flat strip used by every file and material banner. It has no icon and uses `text-fg`, on grey for neutral or red tint for errors. Close hides it until the message changes or the page remounts. Actions are ghost, underlined and right aligned.
- `src/components/banners/DashboardBanner.tsx`: the dashboard slot, replacing `DashboardDefaultBanner`. It shows one card at a time: frozen, grace, offline, reconnecting, then the default. Mock A styling, with underlined `text-fg` links. Carries `data-connection-status`.
- `src/components/app/AccountBlockedScreen.tsx`: the full-screen block for suspended or deleted accounts, split out of `AccountStatusBanner`.
- `src/features/workspace/WorkspaceHealth.tsx`:
  - `useStorageIssue`: the owner is in grace or frozen, or the reader's own account is frozen.
  - `useWorkspaceStatus`: storage takes precedence over offline.
  - `useStorageDialog`: a zustand store for the dialog's open state.
  - `WorkspaceHealth`: offline toast on arrival and whenever the browser goes offline, one storage toast per visit, and the details dialog (md buttons, rounded-input).

Deleted
- `src/components/app/AccountStatusBanner.tsx`, `src/components/app/ConnectionBanner.tsx`, `src/components/banners/DashboardDefaultBanner.tsx`, `src/features/workspace/StorageOwnerBanner.tsx`

Changed
- `src/features/files/FileStates.tsx`: `SourceReplacedBanner` and `FileNotIndexedBanner` now use `FileBanner`. New `SourceBanners` combines the error strip, the paused-at-open strip and the replaced banner.
- `src/features/files/{DocxView,SheetView,PptxView,SourceTextView,PdfAnnotations}.tsx`: moved from `WarningBanner` to `FileBanner` / `SourceBanners`.
- `src/features/files/useSourceSession.ts`: a maintenance-pause refusal before the room opens sets `paused` instead of an error.
- `src/features/files/useOfficeRuntime.ts`, `SourceTextView.tsx`: compute `pausedAtOpen = paused && !doc`. When it holds, the view drops to view mode in the same frame with no remount, and Edit retries.
- `src/features/materials/CenterContent.tsx`: the ingest progress bar is gone; the progress text is now a `FileBanner`.
- `src/features/materials/CenterContentHeader.tsx`: the status slot shows the red triangle (opens the dialog), then `wifiOff`, then the note save state.
- `src/components/ui/Sonner.tsx`: the toast action is the dark filled button, centred vertically; close is a round button on the top-left corner. This applies to every toast.
- `src/components/app/AppShell.tsx`: renders only `AccountBlockedScreen`.
- `src/routes/Dashboard.tsx`, `src/routes/WorkspaceOpen.tsx`: mount the new components.
- `src/components/ui/Icon.tsx`: adds the `database` icon.
- `messages/{en,zh}.json`:
  - Replaced: `connection_offline` and `connection_reconnecting` become `*_title` / `*_body`.
  - Added: `workspace_storage_owner_*_short`, `account_frozen_short`, `workspace_storage_status`, `action_details`.
- `src/mocks/scenarioJourneys.ts`: the account grace and over-quota journeys open `/`, and the source-replaced journey waits for the banner text.
- `src/components/banners/WarningBanner.tsx`: kept, now used only by `ShareDialog`.

## Verified
- `tsc -b`, biome, and `vitest --dir src` (443 tests) pass.
- In the MSW app:
  - The file strips and their close button.
  - The frozen dashboard card, the entry toast, the triangle and the dialog.
  - Offline while inside a workspace.
  - `?mode=edit` during a stubbed pause, for both docx and md.
- Playwright e2e was not run. `e2e/errors/error-surfaces.spec.ts` checks `[data-connection-status="offline"]` on `/`, which should still pass through the dashboard card.

## Remaining
1. **Plan-limit "full" state (needs Epo's decision).** Grace and frozen only cover a paid plan that lapsed while over the Free limit. An active Free or paid account at its limit shows only the `storage_quota_exceeded` error toast when a write fails.
   - Own account: could use the used and limit numbers on `/me`. Check that the frontend `Me` type exposes them.
   - Owner of someone else's workspace: needs a new server field on the workspace.
2. **Own grace in someone else's workspace.** When the reader's account is in grace (not frozen) and they are in another person's healthy workspace, nothing shows. This is intentional, since the owner pays for that storage; confirm with Epo.
3. **Frozen owner wording.** A frozen owner sees "Your storage is full", because the owner check runs before the frozen check. Swap the order if "Account frozen" should win.
4. **Office banner position.** Office recovery and paused strips sit under the Office toolbar row, not directly under the file header. This is unchanged from before.
5. **PDF annotation write error position.** The strip renders where `PdfAnnotations` mounts, not under the header. This is also unchanged.
6. **Header status on empty workspaces.** The triangle and wifi icon appear only when a file or material is open; with nothing open there is no header, so only the toasts show.
7. **Offline toast on reconnect.** The offline toast does not dismiss itself on reconnect; it expires after 7 seconds like other warning toasts.
8. Run `pnpm e2e:slow` for `e2e/errors` and the editor specs before committing, and update `openwiki/test-catalog.md` if any spec changes.
