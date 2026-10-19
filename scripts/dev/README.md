# Local UI with UAT APIs

Open `https://local.uat.capynotebook.com`. Your hosts file maps it to your own
machine. Caddy serves local HTTPS on port 443 and proxies to Vite on loopback
port 5173, including hot reload. Vite proxies `/api` to UAT. The deployed UAT
site remains available at `https://app.uat.capynotebook.com`.

Use these values in `deploy/.env`:

```dotenv
VITE_USE_MSW=false
VITE_API_URL=https://uat-api.capynotebook.com
VITE_CLERK_PUBLISHABLE_KEY=<UAT application's pk_live key>
```

`pnpm dev:uat` checks these values and fixes its port at 5173 to match Caddy.
It fails if that port is occupied. It does not upload source maps unless the
local environment explicitly configures Sentry uploads.

## macOS and Windows

Install Caddy first. On macOS use `brew install caddy`. On Windows use
`choco install caddy` in Administrator PowerShell, or install the official
Caddy binary on PATH. Use native Windows Node and Caddy; Bash and WSL are
not required for this lane.

From the repository root in a normal terminal, add the hosts entry once:

```sh
pnpm dev:hosts
```

Start the HTTPS proxy in one terminal:

```sh
pnpm dev:https
```

Start Vite in a second normal terminal:

```sh
pnpm dev:uat
```

Both setup and proxy commands request administrator privileges automatically.
On macOS, enter your password at the `sudo` prompt. On Windows, approve UAC;
output appears in a new elevated window and the original terminal waits for it.
Failed Windows commands keep their output visible until you press Enter.
Stop Caddy with Ctrl+C in its running window. Keep Vite running as your regular
user. Each development session needs the proxy and Vite; hosts setup is once
per machine.

## What setup changes

The hosts script adds `127.0.0.1 local.uat.capynotebook.com` to `/etc/hosts` on
macOS or `%SystemRoot%\System32\drivers\etc\hosts` on Windows. It preserves
existing content and line endings, saves the original as `hosts.capy-backup`,
and does nothing on repeat runs. A conflicting mapping stops the command.
To undo it, remove only the line marked `# Capy local UI`.

Caddy binds only to `127.0.0.1`, uses its internal CA, and installs that CA in
the local trust store when permitted. It does not request a public certificate
or need a public DNS record. Approve the OS certificate-trust prompt if shown.
If the browser reports an untrusted certificate, fix the local CA trust before
testing sign-in; see [Caddy's local HTTPS documentation](https://caddyserver.com/docs/automatic-https#local-https).

UAT must allow `https://local.uat.capynotebook.com` in both
`COLLABORATION_ALLOWED_ORIGINS` and `OFFICE_ALLOWED_PARENT_ORIGINS`. All
developers use that same origin, each resolving it locally. The repository's
B2 CORS configuration already includes `https://*.uat.capynotebook.com`.

## Full-local backend

Use `pnpm dev` on `http://localhost:5173`, local Docker Compose, the Clerk
development keys, and `VITE_API_URL=http://localhost:8080`.

Clerk webhooks are not delivered to a laptop: the first signed-in request
creates the user, and webhook handling is checked on UAT.

For Stripe development events use
`stripe listen --forward-to localhost:8080/webhooks/stripe`.
UAT provider webhooks continue going directly to the deployed UAT backend.
