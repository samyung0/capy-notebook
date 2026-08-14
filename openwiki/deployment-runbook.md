# Deployment Runbook — manual actions

Everything that cannot be done from this repository. Each step says what breaks
if it is skipped, because several of them fail silently.

Order matters: DNS before Cloudflare rules, Cloudflare before origin lockdown,
origin lockdown before trusting `CF-Connecting-IP`.

Code-side configuration lives in `observability-metering.md` §9.

---

## 1. DNS & hostnames

Decide the topology first; several later steps hard-code it.

| Hostname | Serves | Proxied through Cloudflare |
| --- | --- | --- |
| `abcd.com` | SPA (static) | yes |
| `www.abcd.com` | redirect to apex | yes |
| `api.abcd.com` | Go gateway | yes |
| `collab.abcd.com` | Hocuspocus WebSocket | yes |
| `ops.abcd.com` | internal operator dashboard | yes |

Actions:

1. Move the domain's nameservers to Cloudflare (registrar side). Propagation is
   up to 24 h; do this first.
2. Create `A`/`AAAA` records for each hostname above, **orange cloud on**.
3. Set SSL/TLS mode to **Full (strict)**. "Flexible" terminates TLS at
   Cloudflare and speaks plain HTTP to the origin — anyone between them reads
   every bearer token.
4. Enable **Always Use HTTPS** and **HSTS** (start with a short max-age).

> **Both the SPA and the API must be proxied.** Proxying only the SPA leaves
> `api.abcd.com` publicly resolvable, which is where the rate limiting, the WAF,
> and the origin's anonymity actually matter.

Set `CORS_ALLOWED_ORIGINS=https://abcd.com,https://www.abcd.com` on the gateway
once the SPA is on its own hostname. Leaving it unset falls back to `*`.

---

## 2. Cloudflare — rules

**Rate limiting rules** (free tier allows one; Pro allows several). The edge
layer only handles volumetric floods — semantic limits are in the gateway.

```
Rule:  (http.host eq "api.abcd.com" and not starts_with(http.request.uri.path, "/webhooks/"))
Rate:  100 requests per 10 seconds per IP
Action: Block, 60s timeout
```

The window on the free tier is fixed at 10 seconds, which is why anything
expressed in requests-per-hour lives in the application instead.

**Excluding `/webhooks/` is not optional.** Stripe and Clerk burst deliveries
and retries from a small set of IPs. Rate limiting them produces subscription
and identity state that silently drifts out of sync, and the failure surfaces
days later as a user on the wrong plan.

**WAF custom rules:**

```
Skip all security rules for:
  starts_with(http.request.uri.path, "/webhooks/")
```

**Do not enable Bot Fight Mode.** It cannot be skipped per-path, so it
challenges webhook deliveries, which cannot solve a JavaScript challenge.

**Cache rules:** bypass cache for `api.abcd.com` and `collab.abcd.com` entirely.
A cached SSE or WebSocket response breaks streaming in ways that look like an
application bug.

**Timeouts:** the default 100 s proxy read timeout will cut long chat streams
and Modal parse waits. Either keep individual responses under it or move those
hostnames to a Cloudflare Tunnel, which is not subject to it.

---

## 3. Origin lockdown

Until this is done, `CF-Connecting-IP` is forgeable and every IP-keyed rate
limit — edge and application — can be bypassed by hitting the origin directly.

Pick one:

- **Cloudflare Tunnel (recommended).** Run `cloudflared` next to the gateway;
  the origin needs no inbound ports at all and its IP is never published.
- **Firewall allowlist.** Restrict :80/:443 to Cloudflare's published IP ranges
  and enable **Authenticated Origin Pulls**. Requires re-checking the ranges
  periodically.

---

## 4. Backblaze B2

1. Create the bucket **private**. Public buckets make every presigned URL
   pointless.
2. Create an application key **scoped to that bucket only**, with
   `listBuckets`, `listFiles`, `readFiles`, `writeFiles`, `deleteFiles`.
   Record `B2_KEY_ID` / `B2_APP_KEY` — the secret is shown once.
3. Set `B2_ENDPOINT`, `B2_REGION`, `B2_BUCKET`, and `B2_PRESIGN_TTL` (default
   900 s).
4. **CORS rules on the bucket.** The browser uploads directly to B2 via
   presigned PUT, so B2 itself must allow the SPA origin:

   ```
   allowedOrigins: ["https://abcd.com"]
   allowedOperations: ["s3_put", "s3_get", "s3_head"]
   allowedHeaders: ["*"]
   exposeHeaders: ["etag"]
   maxAgeSeconds: 3600
   ```

   `etag` must be exposed or upload completion cannot verify what was stored.

5. **Lifecycle rule:** delete unfinished large-file uploads after 1 day. An
   aborted multipart upload is billed indefinitely and is invisible in the
   bucket listing.
6. Leave file versioning off, or set versions to expire after 1 day. With
   versioning on, the blob reaper's deletes only hide objects and storage grows
   without bound.

> B2 egress is **not** in `usage_events` — the browser fetches presigned URLs
> directly and the gateway never sees the transfer. B2's own reporting is the
> only source. Set a spend alert.

---

## 5. Sentry

1. Create **four** projects: `gateway` (Go), `retrieval` (Python),
   `collaboration` (Node), `spa` (React). Separate projects keep alert routing
   and quotas per service.
2. Set `SENTRY_DSN` per service and `VITE_SENTRY_DSN` for the SPA. The SPA DSN
   is public and belongs to a browser-only project.
3. Set `RELEASE_SHA` / `VITE_RELEASE_SHA` in CI, and upload SPA source maps —
   without them every browser stack trace is minified and useless.
4. Set an **inbound filter** for `AbortError` as a second line of defence
   behind the client-side `ignoreErrors`.
5. Set a spend cap. Default sampling can burn a month's quota in a day during
   an incident, which is exactly when reporting must not stop.

---

## 6. PostHog

1. Create a project; use the **EU** host if any user is in the EU.
2. Set `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST`.
3. Under project settings, **enable "Authorized URLs"** for `https://abcd.com`
   only, or anyone can post events into your project with the public key.
4. Do **not** enable autocapture or session replay defaults in the UI; both are
   configured in code and the UI settings will override intent silently.

---

## 7. Modal

1. Set `modal_parse_token` and keep the parse endpoints authenticated. An
   unauthenticated GPU endpoint is a free GPU for whoever finds it.
2. Set a **spend limit** on the workspace. A parse loop on a malformed document
   is the most expensive failure mode in the system.
3. Optionally enable Modal's OpenTelemetry export for queue wait and cold start
   — the two numbers the ledger cannot see.

---

## 8. Database

1. Apply migrations (automatic on gateway boot with `MIGRATE=true`).
2. **Grant operator access by hand.** There is no API for this by design:

   ```sql
   INSERT INTO operators (user_id, role, note)
   VALUES ('user_2abc...', 'admin', 'founder');
   ```

   The id is the Clerk user id, which must already exist in `users` — sign in
   through the product once first.
3. Create a **read-only role** for the operator dashboard:

   ```sql
   CREATE ROLE evo_ops LOGIN PASSWORD '...';
   GRANT CONNECT ON DATABASE evo TO evo_ops;
   GRANT USAGE ON SCHEMA public TO evo_ops;
   GRANT SELECT ON usage_daily, usage_events, user_credits, user_storage,
                   users, workspaces, operators TO evo_ops;
   ```

   The dashboard is the least-hardened thing that will ever touch this
   database; it should not be able to write to it.

---

## 9. Post-deploy verification

| Check | Expected |
| --- | --- |
| `curl -sI https://api.abcd.com/healthz` | `x-request-id` header present |
| Send a chat turn, then `SELECT * FROM usage_events ORDER BY id DESC LIMIT 5` | rows with non-zero `output_tokens` |
| Same `trace_id` searched in Sentry and in gateway logs | both return the request |
| `SELECT * FROM credit_reservations WHERE status='open' AND expires_at < now()` | empty after a minute (sweeper is running) |
| `SELECT * FROM usage_daily` | populated within 5 minutes (rollup is running) |
| Fire >40 AI requests in an hour | `429` with `code: "ai_rate_limited"` |
| Open 4 chat streams at once | 4th returns `429 too_many_streams` |
| Hit the origin IP directly | connection refused |

If `usage_events` stays empty while chat works, the usual cause is a streamed
completion without `stream_options={"include_usage": True}` — the request
succeeds and reports nothing.
