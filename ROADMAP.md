# ROADMAP (2026-08-29)

No explict roadmap items or planning. Current application is unfinished and not ready for launching. I recorded a few items that maybe relevant in the future but they have been moved aside for different reasons.

## Undecided Items

**Ops suspend / unsuspend controls.** Add explicit suspend and unsuspend user
actions to the Ops dashboard, including an audit entry and immediate session,
stream, and collaboration eviction. Account-state enforcement already treats a
manually suspended database user as unable to authenticate; this item is only
the operator workflow and is deliberately out of scope for the current
lifecycle work.

**Reindex in case of embedding model deprecation.** A workspace pins `embedding_model_key` for life. There is no job that re-embeds a corpus, and there must not be a per-file re-embed path either: once one upload can rewrite vectors in place, every later change inherits that cost. Parked on purpose. Retargeting the default only affects new workspaces. An embedding `model_configs` row can never be disabled, deleted, or rewritten onto a different model (Postgres refuses). Same width is a new row and a new vector table. If you ever build a cutover, it needs progress, credit reservation, and a rewrite of that pin's vector table + `rag_contents` + workspace pins per content, while search is blocked or stale.

**Elasticsearch.** Hybrid search is Postgres `tsvector` + `pgvector` + RRF. ES would be a second index, sync, and ops bill. Parked until the current search is wrong in a way friends can name, or corpus size makes `tsvector` hurt. Chapter filter stays soft-steered; that is a data-model limit (one entity, many files), not an ES feature.

**Storybook / Storyblok.** You wanted a way to open dialogs and error states without clicking through the app. Parked: the friend loop does not need a component museum. If you add one later, prefer something that mounts real providers (Clerk, query, i18n) or you will screenshot lies.

**Radix → Base UI.** `@base-ui/react` is already a dependency; a lot of chrome is still Radix. A full migrate is visual and a11y risk across every dialog. Parked until the product loop is boring. Do not mix a migrate into the phone week.

**PostHog feature flags.** Flags today are Vite env (`VITE_FEATURE_EXPLORE`, `VITE_FEATURE_THINKING`). You want schedule/tasks gated the same way on the first box, compile-time is enough. PostHog (and “kill switch without redeploy”) waits until you have more than one deploy and a reason to flip a flag for one user. Empty `VITE_POSTHOG_KEY` already disables analytics.

**China product.** Clerk + Cloudflare + B2 and the current overseas ingest host fail or degrade from the mainland. Alipay/WeChat via Airwallex needs the right merchant entity (HK can do some of that later). CAC filings if you offer genAI there. Parked: one international codebase, zh as a UI language only. A later China deploy swaps vendors (auth, payments, models, storage), not a second Vite app.

**Airwallex.** Can sit next to Stripe as the account that holds money and does FX. Two processors both owning subscriptions is a mess. Replacing Stripe is a rewrite of checkout, portal, webhooks, reconcile. Parked: no revenue, Stripe already wired, Airwallex Billing’s hosted portal was still missing when we looked. Revisit when you have a first paid user Stripe cannot charge.

**Sentry-reading agents.** Idea was Hermes on cheap DeepSeek, reading traces, paging only on “real” issues. Parked: you have not tried it, there is no production trace volume, and an LLM will not reliably tell a dead ingest queue from one bad PDF. First unattended pager is a stuck-job count and email, after the box exists.

**Calendar and tasks as a product.** Built, in the sidebar and dashboard, not flagged. You think nobody will use them and they are over-engineered. Parked as a product: first build hides them. Do not keep polishing due dates. If you ever need a personal calendar, do not put it back in this app until the notebook loop has weekly humans.

**Adaptive study engine.** Frequencies, weak topics, coverage while the workspace keeps changing. Generate already has types and cognitive levels; flashcards already have FSRS. The missing piece is a scheduler. Parked: you have not named Tuesday, and you will launch without it if it eats the calendar.

**Website MCP / extra tool surfaces.** Workspace chat vs site-wide chat, extra tools. Parked: two friends do not need a second agent. Curate tools after they actually ask questions the current chat cannot answer.

**Languine / i18n pipeline.** en + zh messages exist. Parked as a process change. Do not add a translation SaaS before you have strings changing every day in production.
