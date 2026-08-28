# UAT and release review procedure

## Hard safety boundary

Read `review/strix-uat.md` and `openwiki/deployment-runbook.md` section 12 before any remote action. Run `scripts/review/preflight.sh uat`.

Remote testing is permitted only when all of these are true:

- `UAT_TARGET_AUTHORIZED=true`;
- HTTP targets use HTTPS and the collaboration target uses WSS;
- every target hostname appears exactly in `UAT_ALLOWED_HOSTS`;
- the environment contains synthetic data and accounts;
- the target is UAT, not production;
- the operator accepts the documented scan scope and rate limits.

If any condition is missing, stop remote work and report the missing prerequisite. Never infer authorization from a hostname.

## UAT layers

Run `scripts/review/remote-smoke.sh` for service reachability. Run `pnpm e2e:uat` for authenticated role-boundary checks using the dedicated Clerk UAT application and fixture. Run `scripts/review/strix-scan.sh uat <quick|standard|deep> <budget>` only after the authorization guard passes.

Use Stripe sandbox credentials and test data only. Never place Stripe or Clerk secrets in command arguments, reports, screenshots, or source files. Do not perform destructive availability testing, social engineering, credential attacks, persistence, data exfiltration, or tests outside the documented allowed hosts. When UI quality is in scope, read `ui-quality-review.md`; retain the viewport, theme, input method, and trace or screenshot for runtime findings.

## Release mode

Release mode combines the source evidence with the most recent successful UAT evidence for the exact candidate revision. Re-run stale evidence. Start in report-only mode. When the baseline is understood, gate release on validated high or critical findings and incomplete required jobs.

Treat scanner process failure, an incomplete run, missing authorization tests, or missing artifacts as an incomplete review—not as a clean result. Do not test production as a substitute for missing UAT.
