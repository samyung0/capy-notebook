# Finding and report contract

Each validated finding must contain:

- stable ID and category;
- severity: critical, high, medium, low, or informational;
- confidence: high, medium, or low;
- status: validated or disputed; put unvalidated surfaces in the separate coverage-gaps section;
- concise title and affected invariant;
- threat or failure scenario;
- impact and affected actors/data;
- exact evidence with file/line, command/test, or sanitized request/response;
- minimal reproduction or proof path;
- existing controls considered;
- remediation direction and a focused regression-test recommendation;
- challenger verdict and any severity adjustment.

Severity reflects demonstrated impact and realistic reachability, not scanner labels alone:

- critical: broad, immediate compromise or irreversible loss with practical exploitation;
- high: serious confidentiality, integrity, authorization, billing, or availability impact;
- medium: meaningful impact with constraints or limited blast radius;
- low: narrow weakness, hardening issue, or limited-impact defect;
- informational: useful observation without a demonstrated security or correctness impact.

Keep scanner output as evidence, not truth. Deduplicate candidates by root cause. If the challenger cannot reproduce a claim, downgrade or reject it and explain why. If infrastructure prevents validation, preserve it as a clearly labeled coverage gap.

The final report must state the reviewed revision, dates, mode, engines, executed commands, skipped checks, limitations, and whether the challenger used a genuinely different model family. End with one of: `release recommended`, `release conditionally recommended`, `release not recommended`, or `insufficient evidence`.

When emitting machine-readable output, validate its shape against `review/findings.schema.json`.
