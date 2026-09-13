# Fix round 2

Source: `review-2.md`. All three decided by the developer on 2026-09-12; no
third review follows, so run every check yourself and report verbatim.

- **R2-1** `pipeline/pipeline/retrieval/structured.py`: the streaming
  renderer and `parse_structured` treat `passages` entries the same way:
  digit strings (`"2"`) count as that number; any other non-integer token
  (`2.0`, `true`, `"x"`) makes the object fail parsing, so the agent takes
  the repair path instead of streaming an answer with dropped citations.
  Tests: renderer and parser agree on `["2"]`, `[2.0]`, `[true]`, and the
  agent test shows the repair call fires for the rejected shapes.
- **R2-2** `server/migrations/0009_default_chat_model.sql`: wrap in a `DO`
  block that raises when no enabled `zai/glm-5.3-flash` row exists, so the
  clear of the DeepSeek chat default never runs without the GLM assignment.
  Extend `store/migrate_test.go::TestForwardSeedMigrationsAreRerunnable` (or
  a sibling) with the disabled-GLM case expecting the migration to fail and
  the slot default to stay on Flash.
- **R2-3** `pipeline/tests/test_parser_client.py`: three tests: a bundle
  without `refinement.json` is rejected; a `refinement.json` over its 4 MiB
  entry limit is rejected; the B2-restore fallback on a bundle that lacks the
  entry takes the repair path rather than serving it.

Then: `pnpm run fmt`, `pnpm run fix`, `pnpm run fmt:go`, `pnpm run fmt:py`,
`pnpm test:pipeline:offline`, `pnpm test:pipeline:replay`, `pnpm test:go`,
`pnpm test`, `pnpm test:deployment`, `pnpm check`, `go vet ./...`; update
`openwiki/test-catalog.md` for new tests. Report per finding the change
(file:line) and the test, plus the check outputs.
