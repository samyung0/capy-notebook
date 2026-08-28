# Evo Notes source security review

Perform a full white-box security review of the checked-out repository. Treat
`SECURITY.md` as the threat model and reportability contract. Read the linked
OpenWiki documents before judging an apparent authorization, quota, lifecycle,
retrieval, collaboration, metering, or operator-access issue.

Prioritize cross-account access, shared-role escalation, account lifecycle,
storage ownership, upload and cleanup races, SSRF, untrusted document
rendering, prompt injection with tool consequences, unmetered provider calls,
webhook ordering, secret exposure, operator privilege, and production bypasses.

Validate findings against reachable first-party code. Record gaps in coverage
separately. Do not modify source files or contact any deployed target.
