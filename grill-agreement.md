# Product agreement (grill, 2026-08-20)

Decisions from grilling the unfinished product. No production server or data yet. Do not treat this as an implementation spec for parked items.

If a line here fights `.todo`, this file wins for sequencing. `.todo` may still have UI bugs and polish that are not product forks.

## Who and why

- First humans are people you can text. Success is you like using it, and some of them come back weekly.
- Dream product is shared notes plus a quiz or cards in the same sitting. The adaptive “what to practice today” engine is later or never.
- Next six months are those people, not a fundraise. Funding is a side effect.
- You are on call. Dumb alerts after there is a box. No Sentry agents until you have tried them.
- HK company. International first, Stripe. China is a later deploy, not a second checkout, not adapters “for later.”
- No production database until the core loop works. Until then you will break schema.

## Core loop (production gate)

Two invited editor friends, on a desktop browser: invite → same note → PDF parsed → generate quiz or deck → attempt → credits move. No scheduler. No phone requirement.

## When friends arrive, this is on

Workspaces, notes, files, invite, chat, generate, quizzes, flashcards, billing, settings. Comments exist, simplified (see Comments).

## Off at first public build

Explore, thinking space, schedule, tasks, dashboard calendar/task widgets. Adaptive study. Ops dashboard. Reindex. Elasticsearch. China. Airwallex. TanStack Start. Suggestion mode.

## Sharing

- Friends are invited as editor members. Share-link strangers edit notes only, no upload or generate.
- Highest of membership and share role already applies to documents. Do not add a creator role. “Member” is not a role; editor is.
- Share is a teaser. Logged-out users get a summary. Open / comment / edit requires Clerk. `WorkspaceOpen` requires a session. Old `/share/workspaces/:id` lands on the summary.
- `public`: indexable, stable slug, written description required. `link`: UUID, `noindex`. `private`: 404, even the summary.
- First public API already has this wall, plus a public summary endpoint. Anonymous file / note / editor-asset reads are 401. Workspace-filed quizzes and decks stay `private` and have no public URL.
- Summary HTML is Go `html/template` and Cloudflare cache plus purge. No summary artifacts for private workspaces. No Start migration for one catalog page.
- Friend workspaces stay private. You may publish one workspace so you can see the summary page.

## Quizzes and decks

- Standalone may be `link` / `public`. Full content in the GET. Sign-in to save or clone. No real exams on `public` (policy, not a technical lock).
- Clone workspace: members, or the source is `public`. Link does not copy the class.
- Clone a standalone quiz or deck: if you can read it, you can copy it (Anki-style).
- Clone a workspace quiz out to standalone is the allowed way to publish it.
- Explore stays off. A published deck is a URL you paste.

## Workspace catalog fields (squash before first DB)

`description`, stable `slug`, `iconType` + `iconValue` (hand-picked system icon or emoji, fallback to today’s `workspaces` icon). Color and tags stay. Auto slug from name is fine; do not silently rename the slug.

## Comments (before friends)

Two tables stay. One Yjs anchor and `anchor_quote` on the discussion (fallback when the live range dies). Do not put anchors on every comment.

Before friends: 1-depth replies, delete parent deletes children, no resolve in the UI. Suggestion mode stays dead (server already rejects `suggestion*` marks).

## Money and legal

- Stripe only until you decide otherwise. Test friends get Pro in the database. You watch Modal and B2. Policy credits and invoices are different numbers.
- First hostname ships a ToS you wrote. Lawyer when you can.
- Reports (any object the reporter can see, fixed reasons, row + email you) ship with the phone week, after the box exists. No classifier. Signed-in, cap per user, you read the mail.

## After the box exists

Phone: view and navigate first, about 5–7 days, during friend testing. Desktop density waits unless a panel cannot stack. Reports in that same bucket.

## Jobs

Keep the Postgres `jobs` table. Today that is ingest: jsonb of ids and options, worker switches on `type`. Abuse control is auth, quota, and parse slots, not a Redis rewrite.

---

## Parked (why, so you do not forget)

**Paid-plan downgrade buffer.** `.todo` wants a grace period after Pro expires so people can pull files out, and no grace if the account is already deleted (keep the user row, flag it). Parked because there are no paid users and no production bytes. Build it before the first real Stripe customer, not before the two friends. Storage limits jump on Pro; without a buffer, downgrade is “we delete your corpus.”

**Reindex.** A workspace pins `embedding_model_key` for life. There is no job that re-embeds a corpus, and there must not be a per-file re-embed path either: once one upload can rewrite vectors in place, every later change inherits that cost. Parked on purpose. Retargeting the default only affects new workspaces. An embedding `model_configs` row can never be disabled, deleted, or rewritten onto a different model (Postgres refuses). Same width is a new row and a new vector table. If you ever build a cutover, it needs progress, credit reservation, and a rewrite of that pin's vector table + `rag_contents` + workspace pins per content, while search is blocked or stale.

**Ops dashboard.** Spec is `todo-ops-dashboard`: `ops.abcd.com`, read-only `evo_ops`, Cloudflare Access plus Clerk, charts from `usage_daily` never `usage_events`. Parked because there is no production ledger to chart. Building it now is decorating an empty kitchen. The model-registry grid (admin write role) waits with it; until then registry edits stay `psql`.

**Elasticsearch.** `.todo` low-priority “elastic search?” Hybrid search is Postgres `tsvector` + `pgvector` + RRF. ES would be a second index, sync, and ops bill. Parked until the current search is wrong in a way friends can name, or corpus size makes `tsvector` hurt. Chapter filter stays soft-steered; that is a data-model limit (one entity, many files), not an ES feature.

**Storybook / Storyblok.** You wanted a way to open dialogs and error states without clicking through the app. Parked: the friend loop does not need a component museum. If you add one later, prefer something that mounts real providers (Clerk, query, i18n) or you will screenshot lies.

**Radix → Base UI.** `@base-ui/react` is already a dependency; a lot of chrome is still Radix. A full migrate is visual and a11y risk across every dialog. Parked until the product loop is boring. Do not mix a migrate into the phone week.

**PostHog feature flags.** Flags today are Vite env (`VITE_FEATURE_EXPLORE`, `VITE_FEATURE_THINKING`). You want schedule/tasks gated the same way on the first box, compile-time is enough. PostHog (and “kill switch without redeploy”) waits until you have more than one deploy and a reason to flip a flag for one user. Empty `VITE_POSTHOG_KEY` already disables analytics.

**China product.** Clerk + Cloudflare + B2 + Modal fail or degrade from the mainland. Alipay/WeChat via Airwallex needs the right merchant entity (HK can do some of that later). CAC filings if you offer genAI there. Parked: one international codebase, zh as a UI language only. A later China deploy swaps vendors (auth, payments, models, storage), not a second Vite app.

**Airwallex.** Can sit next to Stripe as the account that holds money and does FX. Two processors both owning subscriptions is a mess. Replacing Stripe is a rewrite of checkout, portal, webhooks, reconcile. Parked: no revenue, Stripe already wired, Airwallex Billing’s hosted portal was still missing when we looked. Revisit when you have a first paid user Stripe cannot charge.

**Sentry-reading agents.** Idea was Hermes on cheap DeepSeek, reading traces, paging only on “real” issues. Parked: you have not tried it, there is no production trace volume, and an LLM will not reliably tell a dead ingest queue from one bad PDF. First unattended pager is a stuck-job count and email, after the box exists.

**Calendar and tasks as a product.** Built, in the sidebar and dashboard, not flagged. You think nobody will use them and they are over-engineered. Parked as a product: first build hides them. Do not keep polishing due dates. If you ever need a personal calendar, do not put it back in this app until the notebook loop has weekly humans.

**Adaptive study engine.** Frequencies, weak topics, coverage while the workspace keeps changing. Generate already has types and cognitive levels; decks already have FSRS. The missing piece is a scheduler. Parked: you have not named Tuesday, and you will launch without it if it eats the calendar.

**Website MCP / extra tool surfaces.** Workspace chat vs site-wide chat, extra tools. Parked: two friends do not need a second agent. Curate tools after they actually ask questions the current chat cannot answer.

**Languine / i18n pipeline.** en + zh messages exist. Parked as a process change. Do not add a translation SaaS before you have strings changing every day in production.
