# Secret rotation

Which deployment secrets to rotate, how often, and how to do it without an
outage. The names are the `secret` keys in `deploy/env-manifest.json`; that
file stays the list of what exists, this one says how each is replaced.
Setting the values up the first time is `deployment-runbook.md` §12.7.

Background: in October 2026 OpenCode's hosted console and Railway's variable
store both leaked customers' keys, aimed at AI provider keys for resale and
model distillation. A leaked provider key mostly costs money, so the AI keys
rotate most often, and every one of them carries a hard monthly spending cap
in its provider dashboard (Epo, 2026-10-23).

## Where values live

- **GitHub environments** (`uat`, later `production`) hold every deployed
  secret. Deploys render the hosts' env files from them, so a host never needs
  editing by hand.
- **`deploy/.env.uat` and `deploy/.env.prod`** on a developer machine are the
  copies `pnpm env:push` uploads from. They hold every value of that
  environment: keep them only on a machine you trust, and never in an agent's
  scratch space.
- **`.env.local`** holds development keys only, each its own key at the
  provider with a low cap, never a UAT or production value. Agents on the
  developer machine can read it.
- **The ingest host** serves production, UAT and local development (AGENTS.md),
  so its provider keys are shared across them until it is split.

## The procedure

Every rotation follows the same order, so the old value keeps working until
nothing uses it:

1. Create the new value at the issuer (or generate it, for our own secrets).
2. Put it in `deploy/.env.<env>`, then `pnpm env:check --file deploy/.env.<env>`
   and `pnpm env:push --file deploy/.env.<env> --environment <env> --repo samyung0/capy-notebook`.
3. Deploy every target the manifest lists for the key: Deploy UAT (or Promote
   production) for the app host, Deploy Ops for `ops`, Deploy ingest for
   `ingest-*`. A key on several targets is live only once all of them have
   deployed.
4. Check the service that uses it (a chat turn, an upload, a webhook delivery,
   the Ops page).
5. Revoke the old value at the issuer, then look at its usage page for calls
   after the deploy: any means something still holds it.

Rotate UAT first and production the same day, so both environments never hold
the same value. Record the date in the issuer's key name (`uat-2026-10`).

## Keys by group

### A. Two can be live at once (no downtime)

The issuer allows a second key, so steps 1 to 5 never break a request.

| Key                                                                                                                          | Issuer                                                                                | Cadence |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `DEEPINFRA_API_KEY`, `OPENROUTER_API_KEY`, `JEV_TYPESAFE_API_KEY` | AI providers                                                                          | 90 days |
| `B2_KEY_ID` + `B2_APP_KEY`, `BANK_PUBLIC_B2_*`, `BANK_PRIVATE_B2_*`, `KNOWLEDGE_BASE_B2_*`                                   | Backblaze (pairs: replace both)                                                       | yearly  |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_EMAIL_TOKEN`                                                                             | Cloudflare (set a TTL on the token)                                                   | yearly  |
| `SENTRY_AUTH_TOKEN`, `UAT_SENTRY_TOKEN`                                                                                      | Sentry                                                                                | yearly  |
| `CLERK_SECRET_KEY`                                                                                                           | Clerk (a second secret key)                                                           | yearly  |
| `STRIPE_SECRET_KEY`                                                                                                          | Stripe ("Roll key" with a delay on the old one)                                       | yearly  |
| `INGEST_HOST_SSH_PRIVATE_KEY`, `UAT_DB_SSH_PRIVATE_KEY`                                                                      | Our hosts: add the new public key to `authorized_keys` first, remove the old one last | yearly  |
| `UAT_OPS_ACCESS_CLIENT_ID` + `UAT_OPS_ACCESS_CLIENT_SECRET`                                                                  | Cloudflare Access service token                                                       | yearly  |
| `APP_HOST_ACCESS_CLIENT_ID` + `APP_HOST_ACCESS_CLIENT_SECRET`                                                                | Cloudflare Access service token `capy-deploy-github-uat` (expires 2027-10-23)         | yearly  |
| `APP_HOST_SSH_PRIVATE_KEY`                                                                                                   | Our app host: one key only, see below                                                 | yearly  |

Where the issuer supports an expiry (Cloudflare tokens, B2 keys, Access
service tokens), set it about a month past the cadence, so a forgotten
rotation fails loudly.

The app host's playbook writes the deploy user's `authorized_keys` whole, so
`APP_HOST_SSH_PRIVATE_KEY` cannot overlap: between deploys, put the new public
half in the inventory's `app_deploy_ssh_public_key`, run the playbook with
`--tags deploy`, then push the new private half and deploy once to check.

### B. Webhook signing secrets (a grace window)

`CLERK_WEBHOOK_SECRET` and `STRIPE_WEBHOOK_SECRET`: rolling the secret in the
dashboard keeps the old one valid for a window (Clerk's 24 hours; Stripe lets
you pick, up to 24 hours). Roll it, then push and deploy inside the window.
Yearly.

### C. Shared between our own services (one value)

Both sides read the same value, so they switch together and requests in
between fail. Deploy the affected targets back to back; the ingest queue
retries what fails.

| Key                                                                             | Both sides                                           | Notes                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `PARSER_TOKEN`                                                                  | API on the app host, parser on the ingest host       | Deploy ingest straight after the app host.                                                       |
| `PIPELINE_SECRET`                                                               | Gateway and retrieval on the app host, ingest worker | As above.                                                                                        |
| `COLLABORATION_SECRET`                                                          | Gateway and collaboration server                     | Open editors reconnect, as on any deploy.                                                        |
| `POSTGRES_PASSWORD`, `*_DATABASE_URL`, `OPS_*_DATABASE_URL`, `UAT_DATABASE_URL` | The database role and its clients                    | `ALTER ROLE … PASSWORD` right before the deploy.                                                 |
| `UAT_INBOX_TOKEN`                                                               | The UAT inbox Worker's `READ_TOKEN` and the journeys | `wrangler secret put READ_TOKEN --config wrangler.uat-inbox.jsonc`, then push; no deploy needed. |

Yearly, and whenever someone with access leaves.

### D. Bound to stored data (rotate only after a leak)

Changing these breaks data made with the old value, so they are not on a
schedule. Rotating them on a schedule needs two-key support first.

| Key                        | What breaks                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `SHARE_LINK_SECRET`        | Every share link already sent (the URL carries an HMAC under it).                                                         |
| `EMAIL_UNSUBSCRIBE_SECRET` | Unsubscribe links in emails already sent.                                                                                 |
| `LLM_CREDENTIALS_KEY`      | Stored user provider keys (BYOK, off behind `BYOK_ENABLED`); there is no key version yet, so they would need re-entering. |

## Rotate everything now when

- an issuer or a platform we use reports a breach that may include our keys;
- a value was pasted somewhere it should not be (a chat, a log, a screenshot,
  an issue);
- a person or machine with access leaves;
- secret scanning or push protection reports a leaked value.

Then rotate groups A to C at once, D only for the leaked key, and review each
provider's usage from the suspected start for unfamiliar models or hours.
