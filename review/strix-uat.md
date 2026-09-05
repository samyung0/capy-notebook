# Capy Notebook UAT rules of engagement

Test only the exact targets supplied on the Strix command line. Those hosts are
owned by the project and must be listed in `UAT_ALLOWED_HOSTS`. Do not discover,
scan, follow redirects to, or send attack payloads to sibling domains, provider
domains, private IPs, or production hosts. Ordinary browser requests to Clerk,
Stripe, or static dependencies are permitted only as needed for the UAT app to
load; those third parties are never scan targets.

The target is a disposable UAT deployment with synthetic users and data.

## Allowed work

- Map public and authenticated application and API behavior.
- Test authentication, authorization, IDOR/BOLA, role changes, shared links,
  collaboration access, uploads, URL import, SSRF, injection, XSS, CSRF,
  request smuggling indicators, webhook rejection, rate-limit boundaries, and
  business-logic abuse.
- Use the checked-out source and `openapi.yaml` to guide runtime validation.
- Create or modify a small amount of synthetic data when credentials are
  supplied.
- Prove a vulnerability with the smallest reproducible request sequence.

## Prohibited work

- Do not contact production, third-party OAuth accounts, real email addresses,
  real phone numbers, real payment methods, or unrelated internet hosts.
- Do not test volumetric denial of service, resource exhaustion, credential
  stuffing, phishing, persistence, malware, or destructive bulk actions.
- Do not delete accounts, entire workspaces, buckets, databases, or provider
  configuration.
- Do not download more private data than the minimum needed to prove access.
- Do not print credentials, session tokens, document bodies, webhook secrets,
  or provider keys in reports.
- Keep routine request rate at or below two requests per second per host. A
  focused concurrency test may briefly use five parallel requests.

## Evidence standard

Every reported vulnerability must identify the violated invariant in
`SECURITY.md`, the actor and role used, the exact affected route or component,
the minimum proof, impact, cleanup performed, and any remaining uncertainty.
Record untested areas and budget limits separately from findings.
