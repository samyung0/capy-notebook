# Public landing site handoff

Prepared 2026-09-14. This is a design and implementation brief, not a built site.

Build a public website that explains Capy Notebook, helps visitors decide whether it fits their study habits, and makes help, policies and credits readable without signing in. The preliminary framework choice is **Astro with static output**, replacing the earlier Next.js proposal. The dashboard remains its own application.

## Decisions and current state

| Item | Status |
| --- | --- |
| Public website at `capynotebook.com` and `www.capynotebook.com` | Approved separation from the dashboard. |
| Astro, entirely prerendered | Preliminary user choice. Use this as the planning baseline; do not silently add a server rendering requirement. |
| Building the landing app | Deferred. This request authorizes the handoff document only. |
| UAT dashboard | Live at `https://app.uat.capynotebook.com`. |
| Old UAT hostname | Temporary 302 redirect to the new app for GET/HEAD, preserving path/query and excluding `/api` and `/api/*`. User confirmed no files or browser drafts to recover. |
| Production dashboard | Source prepared for `https://app.capynotebook.com`; no production deployment exists. |
| Visual design, launch copy, public pricing, launch languages | Still to be chosen. Suggestions below are recommendations, not approved product decisions. |

The UAT migration shipped as `1f2dc5af4c5982f4f2a65aab98f5fcd6d8b73fa3`. CI, deployment and 10 authenticated UAT tests passed. Live provider import, Office save and payment journeys were not part of that verification. Read [the deployment runbook](deployment-runbook.md#102-app-hostname-transition) before touching domains.

## Product story and page design

The central story should be about studying with your own material. Show a short, concrete progression: bring a source, work through it, practise recall, then return to what needs more attention. Demonstrate what the current app can do with one coherent sample workspace rather than a grid of unrelated AI promises.

Proposed homepage order:

1. **Header.** Capy branding, a small set of navigation links such as How it works and Help & legal, and one primary action. Keep navigation available on mobile.
2. **Hero.** One sentence about the study outcome, a brief explanation, and a realistic product image. Candidate direction: “Make more of what you study.” This is draft copy, not an approved headline.
3. **A sample study session.** Use the same synthetic source across a workspace screenshot, a grounded answer with a citation, and a practice question or flashcard. Short annotations should explain what the learner does next.
4. **Study together.** Show existing sharing/collaboration only after checking the release being marketed. Do not present the long-term school-management vision as a shipped product.
5. **Practical answers.** A few questions about supported sources, sharing, AI answers and plans. Keep detailed help on its own page.
6. **Closing action.** Repeat the actual launch action. A small bottom row may link to Help & legal; a large footer is unnecessary.

Use a calm study-tool aesthetic: readable type, generous spacing, restrained colour, and recognizable Capy artwork. Reuse approved brand assets and colour references from the app. Keep the marketing layout independent of the dashboard sidebar. Avoid autoplay background video, constantly moving decorations, fabricated testimonials, usage counters and unverified learning-outcome claims.

Offer two or three distinct static mock directions before building components. Include desktop and mobile homepage views plus the help hub and a long policy page. The repository's [AGENTS.local.md](../AGENTS.local.md) requires this mock-selection step for substantial new UI. Use the [html-communication skill](../.agents/skills/html-communication/SKILL.md) when publishing those mocks for review. No mocks are created by this handoff.

Copy must distinguish current capabilities from plans. Mobile pen/drawing support, offline readiness and school operations are ambitions in [AGENTS.md](../AGENTS.md), not launch claims. Verify collaboration, import and AI-tool descriptions against the deployed app. Use synthetic demonstration material, never a real student's files or account details.

## Public pages and navigation

These are proposed routes. Keep `/privacy` and `/terms` stable because the existing Google OAuth branding already points to those apex paths.

| Route | Purpose and content |
| --- | --- |
| `/` | Product story, short demonstration and launch action. |
| `/help-and-legal` | Public hub for support, FAQs, terms, privacy and credits. Every item has an ordinary, shareable link. |
| `/support` | Working contact channel and a small set of verified FAQs. Initial recommendation: the existing `support@stablestudio.org` mail link and visible address. |
| `/terms` | Owner-approved terms with a visible effective date. |
| `/privacy` | Owner-approved description of the product's actual data practices with a visible effective date. |
| `/credits` | Attribution, source links, licence links, adaptations and required notices for assets used by the website. Clearly label any broader app attribution included here. |
| `/404.html` | Useful missing-page response with Home and Help links, served with HTTP 404. |

An About page, pricing page, blog, changelog, searchable knowledge base and newsletter can be added when there is maintained content and a concrete need. They are not required to launch this site.

The Help & legal hub lets the app keep its compact sidebar entry instead of adding a footer. Once public pages are live, the app may link from that hub to the public documents. At signup and other relevant decision points, use direct links to the applicable terms/privacy documents as well. A hub is navigation, not a substitute for reviewing the actual notices and acceptance flow.

Do not publish placeholder legal text or infer data promises from the static website architecture. Capy's product processes uploads through multiple services; the public site's lack of a database does not describe the app's data handling. The owner needs to confirm the business identity, support contact, retention/deletion descriptions, AI providers and subprocessors, billing/cancellation wording, and any applicable audience restrictions before publication.

The working tree has separate in-progress Help & legal and Credits changes in `src/routes/HelpAndLegal.tsx` and `src/routes/Credits.tsx`; those were excluded from the hostname release. Inspect their current state before coordinating links. Several support-card actions are still placeholders, so do not copy claims of live chat, response deadlines or a guides library unless those services exist. Preserve asset notices in `public/icons/`, and inspect `src/lib/icon-credits.json` if those assets are reused. A public credits page does not justify deleting bundled notices or the existing app credits.

## Static architecture

Astro prerenders pages by default and can also support server rendering. Our preliminary choice is specifically its static mode. Content changes produce a new build; a page request should only retrieve built HTML, CSS, images and any small browser scripts. See [Astro rendering documentation](https://docs.astro.build/en/guides/on-demand-rendering/).

Recommended baseline:

- `.astro` layouts and components for the shared header, navigation, page frame and calls to action.
- Plain Markdown for policy/support content. Add typed content collections if repeated documents need metadata validation; a CMS is unnecessary for the initial page count. MDX is optional only if an actual document needs components. See [Astro content collections](https://docs.astro.build/en/guides/content-collections/).
- HTML/CSS for navigation, disclosure widgets and layout wherever sufficient. Add a small client script for a mobile menu or theme control only if the chosen design needs it. Framework islands are available for isolated interaction; a React application shell is unnecessary. See [Astro islands](https://docs.astro.build/en/concepts/islands/).
- No Clerk SDK, dashboard API client, Stripe SDK, editor, Office runtime, database, SSR adapter or backend credentials in the public site.
- Contact through a working mail link initially. A form, waitlist or support widget needs a receiving service and separate decisions about delivery, spam handling and data use. A static form alone cannot deliver a message.
- Content and essential navigation remain usable with JavaScript disabled.

Keep the site as an independent package and deployment. A small standalone repository such as `capy-notebook-site` is the recommended starting point, subject to the user's repository choice. If it lives in this repository, give it its own package boundary and build command. Do not restructure the app or pull its BetterOffice, Go or Python builds into a website release.

Suggested package shape, not files to create now:

```text
astro.config.mjs
package.json
pnpm-lock.yaml
wrangler.jsonc
src/
  components/
  layouts/
  pages/
  content/       # approved help/policy content if separated from pages
  styles/
public/
  brand/
  notices/
  _headers
```

Keep public site origin, the selected app destination and contact details in one small build-time configuration. Do not use runtime user-agent detection, Clerk session checks or local storage to guess the destination. Credentials must never appear in generated assets.

## Domain and application boundary

| Host or path | Owner and behavior |
| --- | --- |
| `capynotebook.com` | Recommended canonical public-site origin. |
| `www.capynotebook.com` | Recommended edge redirect to the apex, preserving path/query. This canonical choice still needs approval. |
| `app.capynotebook.com` | Future production dashboard, including `/sign-in`, `/sign-up`, `/forgot-password` and `/sso-callback`. |
| `app.uat.capynotebook.com` | UAT dashboard, for testing rather than a public signup destination. |
| App `/w/{workspaceId}` and `/share/workspaces/{id}` | Stay with the existing app Worker and its visibility-aware summary rendering. Never export user workspaces into the static website. |
| App `/api/*` | Existing app/backend routing. The public site neither proxies it nor needs CORS access to it. |

No broad `*.capynotebook.com/*` Worker route or catch-all apex-to-app redirect. Public-site deployment must not replace app, API, Clerk, Office, collaboration, ops or mail records. Do not reuse `uat.capynotebook.com` as a website preview; it remains Clerk's UAT primary domain and now redirects old app visits.

Use ordinary links to the app's existing authentication pages when production exists. Do not create a second Clerk application just for the website, move callbacks to the public site or forward tokens through query strings. Login remains on the app origin. The public site should not inspect shared authentication cookies or personalize cached HTML.

There is no production dashboard yet. Before publishing a public call to action, choose either to launch the website together with the production app or to publish an explicitly prelaunch site with a real contact action. Do not silently send public visitors to UAT, link to an undeployed app, or display a waitlist form without a service behind it.

## Cloudflare hosting and release plan

Recommend a separate **Cloudflare Workers Static Assets** deployment serving Astro's `dist/` output. Cloudflare documents a fully prerendered Astro deployment with `assets.directory` and no Worker `main` entry point; no SSR adapter is required for that setup. Configure it explicitly because automatic framework setup can select server-capable configuration. See [Cloudflare's static Astro instructions](https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/#if-you-have-a-static-site).

Use a distinct website resource name and exact approved domains. Do not reuse the `capy-notebook-uat` app Worker or its deployment workflow. For the public-site release, no Coolify deploy, database migration or ingest restart is needed.

Recommended release sequence:

1. Build and review on a dedicated preview address. Choose the preview hostname/access policy during setup. Keep preview and production configuration explicit; preview pages should send `noindex` and stay out of the production sitemap. Authentication protection is needed if a preview must be private; `noindex` alone is not privacy.
2. Review actual copy, credits, images, page routes, CTA destination and direct policy URLs. Confirm the selected hostname and website resource before changing DNS.
3. Build with the package lockfile in an independent workflow. Deploy the reviewed revision through one release system, preferably a dedicated GitHub workflow to match the existing deployment practice.
4. Bind the public website to the approved exact hostname. Configure proxied DNS and the www redirect separately; a DNS alias alone does not change the browser's URL. Preserve all unrelated zone records and rules.
5. Configure static HTML routing and a real 404 response. Do not use SPA fallback for missing policy/help pages. See [Cloudflare SSG routing](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/).
6. Check the live site, then update app help links and the relevant Clerk, Google OAuth branding and Stripe business/support/legal links to the approved public pages. Keep webhooks and sign-in callbacks unchanged. Provider settings should point to public, unauthenticated pages that actually exist.
7. Record the website revision and rollback to the previous static deployment if needed. An app release should not be required to revert website copy.

Use long immutable caching only for content-hashed assets; allow HTML and policies to revalidate. Set deliberate security headers on the public deployment rather than copying the app's Office/LLM iframe policies. Choose any content security policy from the scripts, fonts and media actually used.

## Content quality and verification

Choose launch languages explicitly. The app currently has English and Chinese translations, but that does not establish a public-site language policy. A single-language launch is simpler; multilingual launch requires reviewed content, static locale routes, language navigation, canonical URLs and hreflang that agree. Reuse approved wording where suitable without importing the entire app translation/runtime bundle.

Use descriptive page titles, readable link text, one clear main heading, useful image descriptions, keyboard-visible focus, sufficient contrast and reduced-motion support. Keep policy text comfortable to read on a phone. Optimize product images at build time, reserve their dimensions and load below-the-fold media lazily. An initial static marketing site should not need a hydrated framework runtime for its basic navigation and FAQs.

Public production pages should have correct canonical URLs, a sitemap containing only published public routes, useful social preview metadata and intentional robots rules. Preview or UAT URLs must never appear in production canonicals or primary CTAs. Avoid copying the UAT-wide noindex policy onto the launched public site.

Analytics is a separate launch decision. Start without third-party trackers unless the owner chooses a measurement plan. If analytics is added, agree on its purpose and data handling and reflect the implementation in the published notice. Do not copy the app's user identification or session recording onto an anonymous landing site by default.

Focused acceptance checks for the eventual implementation:

- A clean install and static build produce every intended page and a real 404; no runtime backend or secret is needed to serve them.
- Homepage, help, policy and credits pages work directly and with JavaScript disabled. All published links resolve; missing pages return 404 rather than the homepage.
- Desktop/mobile layouts, keyboard navigation, focus, contrast and reduced motion pass review. Check representative real browsers and basic page performance once the final media are present.
- The launch CTA reaches the approved live destination. Login and all provider callbacks remain on their existing app/auth origins.
- Apex/www resolve as approved, with HTTPS, path/query preservation and no redirect loop. App/UAT/API/Office routes continue to work after the website deploy.
- Production canonical/sitemap/robots metadata, preview exclusion, approved policy text and complete attribution are verified against the built output.

## Decisions needed before implementation

The next designer/developer should obtain one concise decision batch: visual direction after mocks, repository location, apex-versus-www canonical host, production-linked versus prelaunch release, initial languages, approved support channel, and ownership of the policy/pricing copy. Analytics and forms can stay deferred unless requested. Reconfirm the preliminary Astro choice only if a concrete requirement would change it.

The next deliverable should be the static design options and proposed content, followed by the selected Astro implementation. Do not interpret this handoff as approval to publish the site, provision production services, draft binding policies as final text, or ship planned product features.
