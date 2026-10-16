# UAT critical paths

Run these twenty-six journeys deliberately through **Deterministic UAT quality**.
Its `critical_paths` input defaults to true for manual dispatch and false for
the lightweight deploy check. **Promote revision to production** requires it.
Normal pull-request CI does not contact UAT or these providers.

See [setup status](setup-status.md) for the applied UAT configuration and the
verification results and remaining deployment steps.

The browser performs registration, direct uploads, Office/text edits and
collaboration. Assertions read application APIs, PostgreSQL, exact B2 object
bytes/versions, Clerk, Stripe, the UAT inbox and Sentry. Selecting an editor input or
button is allowed; layout, nesting, toolbar order and screenshots are not
asserted. The existing authorization suite remains separate.

## Current coverage

| Journey | Verified outcome |
| --- | --- |
| Account | Real signup with fixed Clerk code, verified identity, processed `user.created`, durable profile, 30-day deletion grace, session revocation, delivery to the UAT inbox, real Clerk deletion and processed `user.deleted` purge. |
| Invitation | Signed-out invitation redirects to the app's password sign-in and returns to the original invitation; browser acceptance persists the recipient and viewer membership, then opens the authorized workspace. |
| Membership | `membership.spec.ts`; Auto process edits off and a store-only DOCX, so no provider session or model usage. An invited editor gets write collaboration tokens for a note and the DOCX, saves a DOCX sentence (in a second tab) and a note line from the browser, and leaves both editors open. The owner demotes them to viewer in Workspace settings → Sharing → Manage member: `workspace_members.role` is `viewer`, the workspace reads `role: viewer` with `canEdit` false, and both open editors reconnect on a read token (the server discard-evicts the workspace's rooms; the browser's own token request answers `access: read`) and drop to View under the read-only strip, with no editable content left; the note's View joins its room on a read channel and shows the line. The member still reads the note and file; both token endpoints answer `access: read` and a metadata write is refused with 403. The owner then removes them (Remove in the same menu): no `workspace_members` row, the open View's room closes and its rejoin token is refused with 404, the workspace, roster, note and file reads, both tokens and the metadata write answer the non-disclosing 404, the workspace leaves their list, and they hold the role-change and removal notifications with no email beyond the invite. What they saved as an editor stays in the projection and the saved DOCX. |
| Account deletion | `accountDeletion.spec.ts`; Auto process edits off and a store-only DOCX, so no provider session or model usage. The owner has the DOCX and a note with an image picked through the slash command, an invited editor and a viewer who copies the note as a standalone material: the copy has its own ready `editor_assets` row over the same object (two blob references) and its holder is charged the copy and its image. The owner deletes the account: during the 30-day grace the users row, file, note, image and both memberships stay, while for both members the workspace, roster, note, file, its read links, the image, both room tokens, the editor's note metadata write and the viewer's second copy answer the non-disclosing 404 and the workspace leaves their lists; their own accounts stay active. After the real Clerk deletion and its processed `user.deleted` webhook, the purge leaves no workspace, membership, file, source document, material, editor asset or upload session of the owner, the owner's recounted and counter bytes are zero, and every object only the owner held (recorded by exact key before the purge) loses its references and leaves B2, or waits out its queued `not_before`. The shared image keeps one reference, no queued deletion and its exact bytes, and the copy still reads, resolves its image, gets a write room token and costs its holder the same. |
| Checkout | App-created sandbox customer/session/reservation, expected price and return URLs, session expiration. |
| Billing | Sandbox subscription, paid renewal using a test clock, webhook-backed plan projection, deletion blocker and cancellation. Its hosted payment form is not filled; only the credits journeys fill hosted Checkout. |
| Credits | `credits.spec.ts`, a Free owner. Usage shows the monthly allowance, then the starter grant as purchased credits (`/api/billing` and `/api/usage` give the numbers), the purchased-credits marker and a Top up link to Subscription. The top-up field and `POST /api/billing/top-up` refuse $7 and $101. $8 through hosted Checkout (4242): Stripe kept the session's parameters (payment mode, card and Link, automatic tax, invoice creation, Adaptive Pricing off); Checkout returns to `?tab=subscription` with no other parameter and the tab, not reloaded, shows the credited balance (the stream's `billing` event); the processed `checkout.session.completed` adds one `credit_purchases` top-up whose credits match the session's and the `user_credits` purchased balance, saves the card for auto-reload (shown in its dialog), and its paid `topup` invoice is a Top-up, Paid row. A $10 monthly limit refuses another $8 (409, "Over your monthly limit" toast); $0 removes it. Auto-reload turned on at the balance as threshold (the save answers `armed: true`) charges $10 to that card at the top-up's rate (processed `invoice.paid`, Auto-reload, Paid row), the tab shows the new balance by itself, and the paid reload, leaving credits above the threshold, re-arms it. A limit below this month's spend plus the reload, then the threshold raised to the balance, skips the next reload with no charge, the skipped notice on the tab by itself and the `credit-reload-skipped` mail in the inbox with the English template's subject. Chinese chosen in Settings: Usage and Subscription in Chinese; a new limit from the notice clears the skip and the next skip mails in Chinese. A half refund through the Stripe API takes half the top-up's credits back (processed `charge.refunded`). |
| Declined auto-reload | `credits.spec.ts`, a Free owner. Add a card in the auto-reload dialog is hosted setup Checkout (billing address required, kept on the customer) with 4000 0000 0000 0341; the reopened dialog shows the card by itself and turns auto-reload on at the balance as threshold (a new account starts armed). The reload declines: the purchase is `retrying` with Stripe's `next_payment_attempt` and a processed `invoice.payment_failed`, the tab shows the retry notice by itself and the row the retry date with Pay, and no second reload starts while Stripe retries. That invoice marked uncollectible through the API (as after Stripe's last retry) is a Failed row with Pay; paying it through the API with `pm_card_createDispute` credits it through `invoice.paid` (`q3-uncollectible-reload` records paid or refused), and the dispute's processed `charge.dispute.created` takes the credits back. When that webhook ran before `invoice.paid` recorded the payment intent it takes nothing and the daily reconciliation holds the credits a day later: the journey records which (`dispute-hold`) and, for the second, checks the order and that the dispute is open, rather than failing. The reload re-armed by the payment declines again; a manual top-up (hosted Checkout, 4242) voids it, re-arms and keeps the declining card. Another decline, then Change in the dialog (hosted setup Checkout, 4242): the reopened dialog shows the new card by itself, the decline is voided and the re-armed reload charges the new card. |
| Credits at zero | `credits.spec.ts`, a Free owner with the declining card saved and auto-reload off. Real spend through the app: editor AI commands (Generate over about 180,000 random characters, four at a time) on the editor model with the highest catalog input rate spend the allowance and the starter credits (about 1,000 credits, about $0.50 of provider spend); the first call's ledger row sets the plan, and the journey fails at once if it would take more than 45 calls under the AI rate limit. The counter then holds the whole allowance with the overrun owed, and the editor usage rows add up to it. At zero a command is refused (403 `llm_credits_exhausted`). Auto-reload turned on at threshold 0 and a command at once: admitted, inside the window of the reload it starts, which declines (shown on the tab by itself). 65 s after the reload started a command is refused and no second reload has started. Switching auto-reload off voids the decline; switching it on answers `armed: false` with the "Top up to start auto-reload" toast, a command at zero is still refused and no reload starts. A top-up (hosted Checkout, 4242) re-arms it and keeps the card, work resumes, and a reload starts at the threshold. |
| Auto-reload arming on Pro | `credits.spec.ts`, an owner on Pro through a sandbox subscription on a test clock (its first invoice's `invoice.paid` processed first). The reload card through hosted setup Checkout (4242); auto-reload on at the highest threshold the dialog takes starts a reload at once, and the same settings saved every 250 ms through its charge (at least one save while it is charging) leave exactly one paid reload and auto-reload disarmed. The clock past the period end and Stripe's hour of finalization: the paid renewal (amount above zero, processed `invoice.paid`) re-arms auto-reload and a second reload is paid on the same card. A zero-amount invoice arming nothing is not covered. |
| Renewal failure | `renewalFailure.spec.ts`; three owners on one test clock started now (Stripe's times run ahead of real time, so grace never reaches frozen), Pro through the API with 4242, then `pm_card_chargeCustomerFail` (0341: attaches, declines) as the customer's and the subscription's default; no hosted Checkout, no model call. A stores store-only ballast past the Free limit (limits and the file cap read from the app), B stores nothing. Pro: `/api/me` planTier pro, subscriptionStatus active, state active; one `subscription-started` mail each (inbox subject from the template); the plan invoice a Pro plan, Paid row. Past the period end plus Stripe's hour of finalization the renewal declines: `past_due` in Stripe and the app, Pro limits kept (A still uploads, its note room token is write), no account banner on a freshly fetched dashboard, no over-quota notification, no `subscription-over-quota` or `subscription-ended` mail; the invoice row reads Retrying with the date and Pay. C recovers (4242 attached, the invoice paid through the API): active again, its open tab refetches `/me` on focus (the tab hidden and shown), the invoice paid, no notice or "Pro ended" mail. A and B keep declining; the clock follows each invoice's `next_payment_attempt` (a day at a time once none is left) until Stripe cancels both after the last retry: the app's `ended_at` is Stripe's, planTier free, subscriptionStatus canceled, the invoice uncollectible (a Failed row with View), exactly one `subscription-ended` mail each (inbox subject from the template). A: `over_quota_grace`, `graceEndsAt` = Stripe's ended_at + 14 days, the grace banner (role status), the note's room token read, a new note refused `storage_quota_exceeded`, renaming and trashing still allowed. B: active on Free, no banner, notice or over-quota mail. A resubscribes with 4242: Pro and active, the banner gone on the next focus, a second `subscription-started` mail. The over-quota sweep runs hourly, so its notice and mail are only bounded (at most one for A, none for B or C). Not covered: Stripe redelivering `customer.subscription.deleted` (no documented API) and a second sweep (hourly), moving a file in grace, and the 48-hour renewal tolerance (Go `TestRenewalWebhookAfterPeriodEndKeepsPro`). The Stripe events seen are attached as `subscription-failure-events`. |
| Storage lifecycle | `storageLifecycle.spec.ts`; one owner, one member, real sandbox subscriptions on a test clock started 21 days back (a monthly period started then is live in real time; a cancellation then is a lapse 21 days old), Auto process edits off and store-only ballast, so no provider session or model usage. Pro live (1 GB, 30 MiB files), the owner uploads four 26 MB `.bin` files in the browser (about 104 MB to B2, each read back once) and cancels at the clock's time: `over_quota_frozen`, `graceEndsAt` the clock-stamped `ended_at` plus 14 days. Frozen: the owner's note opens read-only in the browser for owner and member (no editable surface, no mode toggle); reads, the signed download and a new chat thread work; both get read room tokens and `account_over_quota` for a note or comment there; the owner also gets a read token and `account_over_quota` in the member's workspace, while the member still writes its own note; uploads, workspace creation, renaming, widening sharing, inviting and promoting are refused, demoting and trashing stay, and the trashed file is still charged. A second subscription on the clock makes it active: both edit the note again in the browser and the member comments. The clock moved to 3 days back, cancelling again gives `over_quota_grace`: uploads and notes there fail `storage_quota_exceeded` against the Free limit, the owner's content is view-only for both (read tokens, refused comments), the owner still writes and adds a note in the member's workspace (charged to the member), creates a workspace, renames, shares, invites and trashes. Purging the file trashed while frozen makes it active on Free with write tokens again. |
| DOCX, XLSX, PPTX | Browser reserve/PUT/complete, exact source hash, parse/index facts and vectors, saved native edits from two accounts, first open by a third account, native export, reprocessing, trash/restore/purge. Spreadsheet formulas and document content survive. |
| Rich-content DOCX, XLSX, PPTX | Store-only uploads ("No parsing"), so no parser, embedding or LLM call; the workspace has no provider session or model usage. Owner and editor make the fixture README's edits in the browser; both edits and the README's preserved content survive in the saved export, including DOCX East Asian language tags, and the editor and viewer accessibility mirrors show them. The owner's charge is the source alone after opening and grows only by pending effects and state growth beyond seed(base) after edits. All three formats then publish: the owner pastes a fixed, marked text worth about 3,500 net tokens, and the automatic refresh publishes the file export-only after 60 s idle while the editor stays open; its editor stays mounted and editable with no reload banner, and once owner and editor leave, editing moves onto the published file (a new epoch whose base is the published bytes), a reopened editor edits it, the published file keeps the content, and the charge is the new source alone. PPTX uses native clipboard paste. |
| Office refusal recovery | A parsed DOCX with a Word table of contents (`toc/report.docx`). About 3,500 pasted net tokens make the automatic publication due; it captures the paste and is held, because the owner renamed the file with `[hold-publication]` (UAT's `COLLABORATION_UAT_PUBLICATION_HOLD`). The owner types one character inside the first TOC link (`IntroZduction`), saves, leaves the editor (a rebuild waits for an empty room) and releases the hold by renaming the file back (a failure inside the held steps releases it too, so the publication never times out into a 503). The held job is done: a deferred publication of the paste. Its rebuild refuses the edit (`Office rebase:`, held in `rebuild_refusal` and recorded by the next job as `rebuildRefusal`; logged, with no Sentry event); a second automatic refresh publishes the edit, whose exact published bytes contain it, and its rebuild completes (`rebuild_pending=false`, a new epoch on the published bytes, the saved state back to seed(published)). |
| UTF-8 text and image | Browser edit, persisted Y.Text, automatic indexing and exact published bytes. A PNG generated per run (new bytes, so no caption or donor reuse) is captioned and indexed: its ingest job pins the captioning slot's default `model_configs` row, and exactly one `image_caption` provider call is applied on that row and sent to its provider (`relace` for `zai/glm-5.3-flash`), charged, with its session settled. The caption text is not asserted. |
| Digital PDF | Upload/index and unchanged bytes; unavailable source collaboration room and API-based private annotation isolation. Pointer gestures and visual rendering are outside this assertion policy. |
| CSV over a limit | A row over the direct-ingest column cap fails the job with the exact persisted error and `tabular_column_limit`, while the file ends ready and unindexed with `index_limit`, opens with the too-large banner and serves its bytes; no index/model spend publishes, and no Sentry error carries its trace (a user-file limit is not a server failure). |
| Study progress | Thin deployed-stack check (the detailed flows are in the Docker `e2e/study/study-progress.spec.ts`): one owner with progress on marks a store-only file read, submits a one-question true/false quiz (graded on the server, no Jev or other model call) and studies a one-card set; Continue opens a quiz not yet taken; a two-item review ends on "2 reviewed". Asserts the `study_progress`, `attempts` and `review_states` rows and no provider calls. Then a quiz with one open part is answered in the browser: Jev grades it (one award per marking item in the attempt snapshot, value not asserted) and the workspace's only usage is one `usage_events` row (`llm`, surface `quiz`, provider `typesafe`, model `jev-1.13.0`, 1 part, 0 credits, the quiz id and cost in its metadata), with no provider session (Jev is called by Go, not EliteLLM). |
| Chat | `chat.spec.ts`; a PDF and a text file indexed, the Library switch off. One real turn from the browser chat panel: the `start` frame, the turn's provider session pins and every LLM call name the chat slot's default `model_configs` row and its route; each call is applied and charged; the stream ends in an answer with no error frame. Two scripted turns (UAT's `RETRIEVAL_UAT_SCRIPTED_TOOLS`, `[uat-scripted-tools]` messages, no model) then call `list_sources`, `search_workspace`, `read_skill`, `read_document`, `capture_page`, `read_study_progress`, `list_trashed_files`, `create_material` (note and flashcards), `add_questions`, `inspect_document`, `edit_document`, `add_questions` (an open question into the quiz), `add_question_media`, `trash_file` and `restore_file`; every call succeeds, the answer cites a passage, each write's effect names its material, and the projections hold the note, the inserted line, the quiz's open question and chart, and the cards restored once. The scripted turns make no LLM call: the search's one query embedding is on the workspace pin (the retrieval default) and its rerank on the rerank default, both at zero credits, and the editing turn makes no provider call at all. Library, question-bank and deck tools are not called (no UAT library; a stored deck enqueues a paid parse). Response content is never asserted. |
| Scanned PDF | `scannedPdf.spec.ts`; a two-page PDF made per run (`pdf()` in `files.ts`): page 1 has a text layer, page 2 is only a JPEG of a page of text, drawn by Chromium. Uploaded with parsing on as `scan [uat-scripted-vlm] UAT_<fresh hex>.pdf`, so UAT's `INGEST_UAT_SCRIPTED_VLM` reads page 2 as `UAT scripted page 2: scan UAT_<hex>` with no provider call (the fresh token keeps the cached read to this run). The file ends `ready` and indexed; the one chunk holding the read covers page 2 and carries its whole-page box. Exactly one `vlm_page` call, applied with no provider tokens, charged to the owner at the job's pinned `vlm_ingest_page` rate; one parse usage row of 2 pages with 1 text-less, charged one page at the pinned `digital_parse_page` rate; every session settled. A scripted `search_workspace` turn for the token cites that chunk, its pages ending on page 2 with the page 2 whole-page box. Rates are read from the job, never hard-coded. Fails by name when the marker had no effect. |
| Partial file and Retry | `partialIngest.spec.ts`; UAT's `CAPY_UAT_FAIL_PARTS` and `INGEST_UAT_SCRIPTED_VLM`. A one-page PDF made per run, named `report [uat-fail-summary] UAT_<hex>.pdf`: `failed` with `indexed` true, its ingest job `done` with a note starting `summary pending (` and ending `; retry processing fills them in`, the served content ready with chunks, a parse identity and no `rag_content_summaries` row; one parse charge, embeddings and no `file_summary` call. A two-page PDF named `pages [uat-fail-pages] [uat-scripted-vlm] UAT_<hex>.pdf` (page 2 blank, so text-less; the fail marker wins): `failed` and indexed, the note ending `1 pages could not be read (p. 2); retry processing fills them in`, no parse identity and no `vlm_page` call. A scripted search for the token cites the summary-partial file. Each, renamed without its fail marker, is retried in one click from Workspace settings → Indexing → Failed files (Retry; no upload dialog) and stays indexed until `ready`. The summary file's retry session ran exactly one parts-only `ingest` job and one applied `file_summary` call: no parse, parse charge or embedding; a summary row now exists. The pages file's retry ran a parse with `parseFee` false (any parse row of it free) and exactly one scripted `vlm_page` read (page 2 only) charged to the owner at the job's pinned `vlm_ingest_page` rate; the read text is indexed. Fails by name when a marker had no effect. |
| Plate note | `note.spec.ts`, steps in `note.ts`; the workspace has Auto process edits off, so no note index, parser, embedding or LLM call (no provider session or model usage). The owner creates a note from Add file → New file; owner and an invited editor each type a marked line, both clients show both and the saved projection holds both. The editor's image, picked through the slash command's file picker, is one ready `editor_assets` row naming the note, charged to the owner, with the picked bytes in B2, and renders. The editor also picks an audio clip, stored with its exact bytes (notes hold images and audio only). The owner imports a Markdown `html-embed` fence (the editor has no insert command), then Import JSON of the every-block note (`server/internal/materialdoc/testdata/every-block-note.json`, less its asset blocks, which the uploads stand in for): every Plate type and mark a note stores, its quiz and flashcard fences turned into rows embedded in the note. The saved projection and the authenticated material read hold every type and mark of the fixture; the Go and collaboration validator tests read the same file, so schema drift fails CI first. A viewer's read view shows both lines, the image loaded and the snippet running in a `sandbox="allow-scripts"` frame from `https://uat.capy-embed.pages.dev/` (UAT's `VITE_EMBED_ORIGIN`) that resizes to the snippet's height. The Markdown export's ZIP links the block, holds the image with the stored pixels among its PNG figures (exports redraw images, diagrams, charts, graphs and equations as PNG, so bytes differ) and the audio and file with their bytes. Deleted after the grace minute, the image's save trashes its row, keeping its blob reference and charge for a day; Undo brings back the same asset id (the collaboration service's children pass restores it), and the image survives a reload. Only standalone notes have links, so the owner clones the note through the API and sets the clone to link sharing; a signed-out browser gets 200 with every type and both embeds from `GET /api/public/notes/{token}`, and `/share/notes/{token}` renders every type and every mark but the style ones (colour, background, font size and family: inline styles, held by the API read), loads the image, plays the audio (its asset route redirects to the signed link), opens and closes the image, diagram, chart and graph previews, shows no View source (visitors don't need a block's source), with no page or console error. |
| Note embedded blocks | `note.spec.ts`. The slash command's Quiz and Flashcards create rows embedded in the note (`parent_material_id`) and open their editors in place; the note references both. A 5.8 MB PNG picked in the live quiz editor (a quiz embedded in a note) is shrunk to WebP under 2 MB in the browser and uploads at once as one ready `editor_assets` row naming the quiz; once the quiz projects its content names it, the B2 object is WebP of that size and the owner's charge grows by the asset plus the content. Pasting the quiz block into its own note keeps the quiz; into a second note makes that note's copy, and copying that block within the note makes a second quiz; each copy has its own asset row over the shared object. The inserted quiz's block removed after its first minute trashes the quiz without listing it in the trash; Undo brings the block back and the children pass restores the row. Removing the original's image (over a minute old) trashes its row when the quiz projects, still charged and holding the shared object, while the copies keep theirs. A flashcard front-image case is written and marked fixme until card images are deployed to UAT. |

Each test registers a disposable primary account. Collaborators use real Clerk
accounts and short-lived sign-in tickets. No test writes the database, bypasses
app authorization, fabricates signed webhooks, or changes shared parser settings.
The invitation recipient signs out after setup and signs back in through the
password form. Its generated password stays in memory and is omitted from failure details.
Authenticated API actions wait for Clerk to restore the actor's browser session
after navigation before reading its token.
Office publication waits fail immediately when the database records a terminal
refresh error, rather than waiting out the processing timeout.
Ingest assertions read persisted indexed text, including heading context, so
facts remain verifiable when parsing recognizes an edited sentence as a heading.
Browser setup follows [Clerk's Playwright testing helper](https://github.com/clerk/javascript/blob/main/packages/testing/src/playwright/setupClerkTestingToken.ts):
it sends an instance testing token and overrides only the Clerk client CAPTCHA
flag. The token alone does not prevent the browser from waiting for a challenge.
The initial suite does not yet cover every feature or file type. Image/audio
codecs, legacy Office, structural Office edits, native citation paint,
study tool generation, account restoration and actual OAuth consent remain gaps.
The note journeys leave AI edits, offline drafts, toolbar formatting, comment
anchors, note DOCX export, note indexing and flashcard card images (fixme) to
the editor-feature and Docker suites.
The credits journeys leave out Stripe's own retry schedule ending in
uncollectible (three days; the journey marks the invoice uncollectible
itself), the hosted invoice page (the API pays it), a dispute closed won,
asynchronous Checkout payments, a zero-amount Pro invoice, and the
"Reloading" notice (the worker sends its `billing` event after the charge,
so a tab sees charging only if it loads during those seconds).

Google/OneDrive downloads are fixture-backed isolated tests in
`pipeline/tests/test_import_stage.py` and `server/internal/integrations/oauth_test.go`.
Google Docs/Sheets/Slides retain their DOCX/XLSX/PPTX export formats; Drawings
still export as PDF. Live imports are excluded from this unattended gate.

### Failed renewal: Stripe's event sequence

`renewalFailure.spec.ts` attaches every Stripe event about its three
customers, oldest first, as `subscription-failure-events` (type, the
clock-stamped time, the object and its status). Not observed yet: copy the
sequence here from the first live run, for the decline, a paid retry and
Stripe's cancellation after the last retry.

## Fixtures

Commit small synthetic inputs under `e2e/fixtures/files/`, one directory per
set, each with a README documenting its source, expected facts, editing
capabilities and preserved content. `fixture(name, marker, set)` in `files.ts`
reads `basic/` by default or another named set such as `rich-content/`.
See `e2e/fixtures/files/README.md` for the full format matrix.

Office/text copies receive a unique run marker in memory before uploading;
committed originals are never changed by a run. `files.spec.ts` names the
`basic/` fixtures and `richContent.spec.ts` the `rich-content/` ones, whose
edits and checks live in `richContent.ts`. A new set needs cases with explicit
content/edit expectations; merely putting files in a directory does not create
coverage. `pnpm e2e:uat:journeys --grep rich-content` runs only the rich-content
journeys, and `--grep note` only the note ones. Never commit real documents, credentials,
user data, screenshots, signed URLs or generated run reports.

## One-time setup

Use the isolated UAT services and deploy the same full Git SHA to the app,
gateway, collaboration, Office worker and the nonproduction ingest project.
Ingest deployment remains a separate manual operation. The suite verifies
app/Office release metadata, gateway/collaboration release headers, migration
0016, actual ingest image revisions and job attempt environment/revision.
Office uses native state and parser bundle v5; no retained PDF preview is
expected. Parse identity comes from the completed ingest job's receipt for the
current source hash, since files keep no parse reference (migration 0041) and
successful ingestion deletes the local bundle. The journey also asserts that no
retired B2 parse bundle exists for that fingerprint.

Configure these GitHub **uat environment** values. Full mappings are in
`deploy/env-manifest.json`; never paste secret values into run artifacts.

| Variables | Setup |
| --- | --- |
| `UAT_TARGET_AUTHORIZED` | Exactly `true`. |
| `COLLABORATION_UAT_PUBLICATION_HOLD` | Exactly `true` (UAT only; the deployment renderer refuses it in production). The Office refusal journey needs it to hold its publication. |
| `CAPY_UAT_FAIL_PARTS`, `INGEST_UAT_SCRIPTED_VLM` | Each exactly `true` (UAT only; rendered into `uat.queue.env` and taking effect on the next **Deploy ingest**; a UAT worker refuses any other value and the renderer refuses them in production). The partial-file journey needs both (file-name markers `[uat-fail-summary]`, `[uat-fail-pages]`, `[uat-scripted-vlm]`), the scanned-PDF journey the second. |
| `RETRIEVAL_UAT_SCRIPTED_TOOLS` | Exactly `true` (UAT only; the deployment renderer refuses it in production and retrieval will not start with it unless `SENTRY_ENVIRONMENT=uat`). The chat journey's scripted turns need it. |
| `UAT_APP_URL`, `UAT_API_URL`, `UAT_COLLAB_URL` | Exactly `https://app.uat.capynotebook.com`, `https://uat-api.capynotebook.com`, `wss://uat-collab.capynotebook.com`. Office is `https://uat-office.capynotebook.com`. |
| `UAT_CLERK_TEST_MODE` | Exactly `true`, after enabling Clerk test emails/fixed code `424242` on the isolated UAT instance. Keys must resolve to its primary domain and `clerk.uat.capynotebook.com`. |
| `CLERK_PUBLISHABLE_KEY`, `UAT_ACTOR_EMAIL_DOMAIN` | UAT frontend key and `inbox.uat.capynotebook.com`, whose Email Routing rule hands every generated `journeys+uat-…+clerk_test` address to the UAT inbox Worker. Clerk auth uses fixed codes; app mail must actually arrive there (deployment runbook §12.5). |
| `UAT_DATABASE_NAME` | Actual dedicated UAT database. Apply `scripts/uat/verifier-role.sql` manually as its owner, with the explicit psql variables described in that file; then set the role password interactively. This is operational setup, not an app migration. A role created before the study journey also needs `GRANT SELECT ON attempts, study_progress, review_states TO capy_uat_verifier;`, and one created before delta saves (migration 0075) `GRANT SELECT ON source_document_updates TO capy_uat_verifier;`: the Office and text journeys read saved edits as the state plus its current epoch's rows. One created before the model slot checks also needs `GRANT SELECT ON model_configs TO capy_uat_verifier;`: the image and chat checks compare calls with each slot's default row. The reprocessing journeys need `GRANT SELECT ON rag_material_contents, agent_edit_inverses, edit_incidents, user_credits TO capy_uat_verifier;` on a role created before them, and the credits journeys `GRANT SELECT ON credit_purchases TO capy_uat_verifier;`. |
| `B2_BUCKET`, `B2_ENDPOINT`, `B2_REGION` | Dedicated bucket whose name contains a separated `uat` component, Backblaze HTTPS endpoint and region. Existing browser CORS and hidden-version lifecycle must be configured. |
| `UAT_STRIPE_ACCOUNT_ID`, `STRIPE_PRICE_PRO` | Exact sandbox account and active recurring Pro price. Existing UAT Stripe webhook subscription must deliver the ten events of deployment runbook §12.4 (subscription, invoice, Checkout, refund and dispute), with Card and Link enabled for the credits journeys. |
| `UAT_SENTRY_URL`, `UAT_SENTRY_ORG`, `UAT_SENTRY_PROJECTS` | Sentry API origin, organization, comma-separated project slugs covering every UAT service. Services must report environment `uat` and trace/user tags. |
| `INGEST_HOST`, `INGEST_HOST_USER`, `INGEST_HOST_SSH_PORT` | Existing ingest host, explicit SSH user/port. Read-only inspection checks `/opt/capy-ingest/releases/nonprod` and actual running Docker image labels before/after. |

Required secrets: `CLERK_SECRET_KEY`, `UAT_DATABASE_URL`, `B2_KEY_ID`,
`B2_APP_KEY`, `STRIPE_SECRET_KEY`, `UAT_INBOX_TOKEN`, `UAT_SENTRY_TOKEN`,
`INGEST_HOST_SSH_PRIVATE_KEY`, `INGEST_HOST_KNOWN_HOSTS`.

The database URL must use `capy_uat_verifier`. Remote connections require
`sslmode=verify-full`; otherwise use the optional SSH tunnel. Its variables
`UAT_DB_SSH_HOST`, `UAT_DB_SSH_USER`, `UAT_DB_SSH_PORT`,
`UAT_DB_SSH_KNOWN_HOSTS`, `UAT_DB_FORWARD_HOST`, `UAT_DB_FORWARD_PORT`,
`UAT_DB_LOCAL_PORT`, and secret `UAT_DB_SSH_PRIVATE_KEY` are all-or-none.
The tunneled URL must use `127.0.0.1:UAT_DB_LOCAL_PORT`. Obtain the SSH host key
out of band and pin it; the script never accepts an unknown host key.

B2 credentials need bucket/object reads and version listing. The verifier
has no storage-write operation. `UAT_INBOX_TOKEN` equals the inbox Worker's
`READ_TOKEN` secret and only reads messages. Sentry
needs `org:read` for the organization events query, scoped to the listed
projects. Stripe accepts only `sk_test_` keys and checks the
account ID before cleanup. Keep keys limited to UAT wherever the provider
supports it.

## Running and cleanup

The journeys run in lanes, one Playwright project per lane. The workflow runs
each lane in its matrix as its own job, in parallel:

| Lane | Specs | In the workflow matrix |
| --- | --- | --- |
| `office` | `files.spec.ts`, `chat.spec.ts`, `officeRefusal.spec.ts`, `scannedPdf.spec.ts`, `partialIngest.spec.ts` | Yes |
| `billing` | `billing.spec.ts`, `credits.spec.ts`, `renewalFailure.spec.ts` (Stripe sandbox: subscriptions, top-ups, auto-reload, failed renewals; about 60 min) | Yes |
| `app` | Every other spec; a new spec lands here unless a lane names it | Yes |
| `refresh` | `officeLifecycle.spec.ts` (J2), `noteIndex.spec.ts` (J4), `textLifecycle.spec.ts` (J5) | Not until those specs exist: an empty project fails with "No tests found" after preflight |

- Each lane is a run of its own: its own `UAT_RUN_ID`
  (`<run id>-<attempt>-<lane>` in the workflow), manifest, cleanup, Sentry gate
  and artifact. A failing lane does not stop another (`fail-fast: false`).
- J2, J4 and J5 share the refresh lane: J2's hold on a store-only file stops the
  collaboration refresh scheduler while it lasts, and J4/J5 time refreshes.
- A check that looks at the whole environment rather than at the run's own
  resources (the "no `source_refresh` job pending over 10 minutes" canary) runs
  only in the refresh lane.
- Latency windows (J4/J5's 45–90 s waits) are recorded in the evidence, not
  asserted: the other lanes share UAT's single ingest worker.

Each lane's job uses one Chromium worker, no whole-test retries, a 90-minute
suite budget (Playwright's `globalTimeout`) in a 95-minute step and a separate
10-minute cleanup step, inside a 150-minute job.
A failing journey does not stop the ones after it.
Browser actions time out after 30 seconds and navigation after 60 seconds;
parse/index polling retains its explicit longer limits. Uploads use the actual
file-picker button, which waits for the workspace upload policy before accepting
files. Office preparation has a separate 30-minute cap.
These initial budgets have not been calibrated against a full live run.
Missing configuration or failed required checks fail the gate.

Local operators need Node/pnpm, uv, the same BetterOffice Bun/Rust/WASM build
toolchain as CI, and Chromium. Export the same UAT configuration above, plus
`EXPECTED_REVISION` and a fresh lowercase `UAT_RUN_ID`. Then run one lane
(without `--project`, every lane runs one after another under one run ID):

```sh
export RUNNER_TEMP="$(mktemp -d /tmp/capy-uat.XXXXXX)"
pnpm office:prepare
scripts/uat/journey-tunnel.sh start
scripts/uat/verify-journey-releases.sh before
pnpm e2e:uat:journeys --project=office
pnpm e2e:uat:cleanup --run-id "$UAT_RUN_ID"
scripts/uat/verify-journey-releases.sh after
scripts/uat/journey-tunnel.sh stop
rmdir "$RUNNER_TEMP"
```

The local `RUNNER_TEMP` is a disposable directory for the SSH control files.
Keep this path short; macOS's default temporary path can exceed SSH's Unix
socket path limit.
Run cleanup and tunnel stop even if a preceding command fails. The manual
workflow does this automatically. Local Playwright alone does not inspect
the ingest host. Preserve `UAT_RUN_ID` across these commands.

Sanitized assertion evidence is persisted under the run directory’s `evidence/` folder.
Every creation records exact resource IDs under
`e2e/uat/journey-runs/<run-id>/manifest.json`, outside Playwright's cleared
output directory. Cleanup runs in Playwright teardown; an `always()` workflow
step reruns it unless the teardown wrote `cleanup.json` with no failures.
Download the artifact and restore that directory
to retry `pnpm e2e:uat:cleanup --run-id <run-id>` with the original revision
and UAT configuration. Existing run IDs cannot be reused for new tests.

Cleanup removes run-owned Clerk identities, expires Checkout sessions,
cancels/deletes sandbox customers (first expiring their open Checkout sessions,
voiding their open and uncollectible invoices and deleting drafts, all listed
by that exact customer) and removes test clocks. Real signed Clerk
webhooks purge content. Read-only checks verify content removal, released
reservations, due deletion jobs and exact B2 versions. Recovery inventory must be saved before Clerk deletion; failed reads preserve
the accounts for a retry. Missing evidence, unreferenced live objects and
failed provider actions fail cleanup. It never
deletes by a broad prefix or directly mutates SQL/B2.

`cleanup.md` and `cleanup.json` list failures and retained resources with exact
IDs and follow-up actions. Expected retention includes:

- Late-upload deletion jobs until their recorded `not_before` deadline.
- Shared cache objects until configured unused TTL expiry; another live
  reference can retain an object. Inspect references before manual removal.
- Hidden B2 versions/delete markers under the bucket lifecycle policy.
- Parser spool and temporary native conversion files under existing host
  cleanup policies. The suite does not remove or inventory the shared host
  filesystem; use recorded job IDs for operator investigation.
- Scrubbed account tombstones and pseudonymous billing/usage/webhook/audit
  ledgers under product retention.
- Cloudflare Email Service send logs (the UAT inbox drops its copies within
  a day), and sandbox Stripe invoice/payment, refund and dispute history.

Journeys never reach Sentry: a healthy run sends no event. Cleanup queries
Sentry by the run's exact trace, actor and uploaded-file IDs (collaboration
tags a source rebuild's event with its `file_id`) after a 30-second delivery window
and fails on any event, whatever its level. Expected outcomes the journeys
cause on purpose (the CSV over its column limit, the refused Office rebase) are
logged, not captured. This is bounded delivery verification, not a guarantee
that an event cannot arrive after the final query.

Hard cancellation, lost runners and uncertain provider responses can leave
resources. Re-run cleanup from the manifest, inspect failed actions and exact
provider IDs, and use the provider dashboards if automatic ownership recovery
cannot establish a match. Never remove the persistent authorization fixture
or another run's resources. Artifacts are retained for 30 days; save a failed
run's manifest before that window expires.

## Offline checks

```sh
pnpm test:deployment
pnpm test:uat:verifier
pnpm exec tsc --noEmit -p e2e/uat/tsconfig.json
pnpm e2e:uat:journeys --list
```

These checks contact no UAT services and do not certify a live gate run.
