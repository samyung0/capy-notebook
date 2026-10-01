# DOCX edit performance probes (2026-10-02)

Throwaway Playwright probes behind the performance section of
`artifacts/2026-10-01-docx-followup-handoff.md`. They open the MSW fixture
`bio-office-docx` (`exchange-plan.docx`, 15 pages, Chinese) in edit mode at
1280×800 in headless Chromium.

- `edit-profile.cjs`: keystroke-to-painted-frame latency over `CHARS` keys
  (default 40), a CPU profile of that typing (`typing.cpuprofile` in `OUT`,
  default the working directory), self time by script and function, and process
  memory before and after.
- `memory-curve.cjs`: process memory, JS heap, every WASM memory in the
  runtime frame and canvas backing stores after each 40 keys, up to 200.

Run from the repository root against an MSW dev server (`BASE`, default
`http://localhost:5173`):

```bash
BASE=http://localhost:5174 node artifacts/2026-10-02-docx-perf-probes/edit-profile.cjs
```

Dev numbers include React's dev-only render profiling (about 18% of typing
CPU). For production React with MSW still on, build with
`NODE_ENV=production VITE_USE_MSW=true vite build --mode development --outDir <dir>`
and serve it with `vite preview --mode development`. That build has `PROD` set,
so the runtime refuses the app origin in view mode; edit mode still opens. Set
`VITE_OFFICE_RUNTIME_ORIGIN` to a second origin to measure view mode too.
