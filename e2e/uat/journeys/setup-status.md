# UAT journey setup status

Configured and checked on 2026-09-14. Live runs have passed account and Checkout
journeys; the full suite has not passed yet.

## Applied

- GitHub `samyung0/capy-notebook`, environment `uat`: added 15 journey variables
  and secrets `UAT_DATABASE_URL` and `UAT_DB_SSH_PRIVATE_KEY`. Read back every
  variable and confirmed both secret names. Secret values are write-only in
  GitHub. The matching values are in ignored, mode-0600 `deploy/.env.uat`.
- Restricted the GitHub UAT environment to the `main` branch, as required by
  the deployment runbook. No reviewer or wait timer was added.
- Enabled Clerk test mode on the instance whose primary domain is
  `uat.capynotebook.com`. Read back `auth_config.test_mode=true`, verified
  signup uses email codes, and successfully created a short-lived bot-protection
  testing token. Test emails use `+clerk_test` and code `424242`.
- Applied `scripts/uat/verifier-role.sql` to database `capy` on the UAT VM
  `159.195.250.206`. Created `capy_uat_verifier`, set a generated password and
  the `capy.environment=uat` marker. A real connection verified 32 SELECT
  grants, zero table-write privileges and read-only transactions by default.
- Verified the SSH tunnel through existing `capy-ingest@159.195.61.195` to
  `10.77.0.3:5432`, using the existing pinned host key and deploy credential.
  The runner connects at `127.0.0.1:15432`. The verification tunnel was closed.
- Added native Office capture settings to the private UAT env file and GitHub:
  `PARSER_URL=http://10.77.0.2:8091/file_parse` and
  `PARSER_BIND_ADDRESS=10.77.0.2`. Verified the ingest host's WireGuard address,
  all required GitHub deployment keys and complete configuration rendering.
  This fixes the deployment's missing `PARSER_URL` error. The matching ingest
  deployment applies the private parser bind; the old parser binds loopback.
- Verified the private `capy-notebook-uat` bucket, required browser CORS,
  one-day hidden-version and unfinished-upload cleanup, and staging-prefix
  expiry. They already matched the repository policy, so no bucket settings
  were changed. The configured application key passed bucket and version reads.
- Verified Stripe sandbox `acct_1U8Djl2ZZopeANOe`, active monthly USD 8 Pro price
  `price_1UBXuV2ZZopeANOehrbUr1Qx`, and the enabled UAT webhook endpoint with
  the events handled by the gateway during initial setup.
- Run `34855166757` exposed HTTP 400 responses to subscription webhooks: the
  unpinned endpoint inherited `2026-07-29.dahlia`, incompatible with the deployed
  `stripe-go/v82` SDK. Created replacement `we_1UFazI2ZZopeANOeYbwCk8PA`, pinned
  to `2025-08-27.basil`, with the same UAT URL and five handled events. Its
  signing secret is synchronized to private `.env.uat` and GitHub `uat`.
  Redeploy UAT before disabling old endpoint `we_1UBtgI2ZZopeANOeoftHsYMT` and
  rerunning the billing journey. Keep the disabled endpoint's delivery history
  for diagnosis; the failed run's account and provider cleanup succeeded.
- Configured `stablestudio.org` as the generated account email domain and
  `capy-web,capy-backend` as the Sentry projects. The existing Clerk webhook
  ledger has successful `user.updated` deliveries; signup/deletion delivery
  still needs the real journey run.
- Verified the catch-all test email in the connected macOS Mail inbox for
  `samyung@stablestudio.org`: subject `Testing`, received at 15:21 JST on
  2026-09-14, addressed to `uat-catchall-check+clerk_test@stablestudio.org`,
  with the developer's test message. The Hostinger plugin's mail tools were
  unavailable in this task, so verification used Mail instead.
- Synchronized the new token into both `SENTRY_AUTH_TOKEN` and
  `UAT_SENTRY_TOKEN` in the private UAT env file and GitHub's `uat` environment.
  Authenticated scope inspection confirms organization/project reads and
  release-upload access. Explore returns 200; an individual-event read for a
  deliberately nonexistent ID now returns 404 instead of the old token's 403.
- Verified the replacement Resend key: the domains API returns 200 and reports
  `uat.capynotebook.com` as verified; an email read for a deliberately
  nonexistent ID returns 404 `Email not found`, proving authentication and
  read access. Synchronized the same key into `RESEND_API_KEY` and
  `UAT_RESEND_READ_KEY` in the private UAT env file and GitHub's `uat`
  environment. No send was attempted. The sender remains
  `Capy Notebook <notifications@uat.capynotebook.com>`.

No provider credentials or mailbox configuration remain outstanding from
this setup. Actual application email delivery and the full lifecycle still
need the deployed journey run.

Mailbox copies remain after test accounts are deleted; clear them when no
longer needed. The Hostinger catch-all applies to every nonexistent mailbox
on `stablestudio.org`.

## Before the first run

1. Commit and push the implementation, including `deploy/env-manifest.json`.
   At setup time, local HEAD and remote `main` were
   `2b366ee3acfbaf0faf72666249f2ca45c5b1838f`; the new journey files and workflow
   changes were still uncommitted. The old configuration parser does not know
   the newly added GitHub variables.
2. The journey settings and updated provider secrets are already synchronized
   to GitHub. Review any other pending environment changes with `env:check`
   before using `env:push` to upload the whole file.
3. Deploy the same new SHA through Deploy UAT and Deploy ingest for UAT.
   The running database had migrations through **0015** at setup time; the
   native Office suite requires **0016**. The deployment migrator must apply it.
   The verifier grants are table-level and survive the removed preview columns.
   Deploy UAT also applies the replacement Resend key to the application;
   changing the GitHub secret alone does not update a running container.
4. Dispatch Deterministic UAT quality from `main`, with the deployed full SHA
   and `critical_paths=true`.
5. Review the uploaded journey evidence and cleanup report. Retry cleanup from
   its manifest if a run is interrupted, as described in the main guide.

Setup changed configuration and verifier permissions only. It did not deploy
application code, run migrations, send emails, create test accounts or run
the heavy suite.
