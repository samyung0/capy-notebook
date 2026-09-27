# Client export diagnostic

Windows, AMD Ryzen 7 3700X, Chromium 151.0.7922.34. Dedicated Vite production bundle. Three measured repetitions per case after a small warmup; medians below. This is local diagnostic evidence, not a CI budget or a device-independent latency claim. Other development work was running on this PC.

Fixtures contain paragraphs and a heading every twentieth block. The node count includes text leaves. No remote requests or backend export service were involved.

| Case | Nodes | Serialized source bytes |
| --- | ---: | ---: |
| Medium | 1,000 | 114,446 |
| Near node limit | 9,800 | 832,167 |
| Near byte limit | 4,000 | 1,959,022 |

The repository's authored-document ceilings are 10,000 nodes and 2,097,152 bytes. Referenced materials and image bytes can make the resolved export much larger than the parent note's stored JSON.

| Main thread case | Markdown elapsed | Markdown timer delay | DOCX elapsed | DOCX timer delay |
| --- | ---: | ---: | ---: | ---: |
| Medium, normal CPU | 146 ms | 131 ms | 58 ms | 37 ms |
| Near node limit, normal CPU | 1,349 ms | 1,333 ms | 524 ms | 468 ms |
| Near byte limit, normal CPU | 649 ms | 633 ms | 305 ms | 249 ms |
| Medium, 4x page throttle | 613 ms | 598 ms | 478 ms | 434 ms |
| Near node limit, 4x page throttle | 7,036 ms | 7,021 ms | 3,490 ms | 3,288 ms |
| Near byte limit, 4x page throttle | 3,679 ms | 3,664 ms | 1,691 ms | 1,444 ms |

Timer delay is the largest observed excess over a 16 ms interval during each job and its short surrounding sampling window. It is a responsiveness proxy, not INP or input-to-paint latency. Main-thread Markdown reuses an empty configured editor and passes the document to `serializeMd` through its `value` argument; editor mounting and document normalization are not timed. DOCX starts with semantic HTML and calls `htmlToDocxBlob`, so these numbers exclude the current failing Plate-to-HTML render stage.

The first bundled worker attempt could not import the Markdown stack: `document is not defined`. `decode-named-character-reference@1.3.0` selects `index.dom.js` under the browser condition and accesses the DOM at module scope. Its existing `worker` condition selects a table-based implementation. The second isolated build selected that condition. Both serializers then ran in a module worker.

| Worker case, normal CPU | Markdown elapsed | Page timer delay | DOCX elapsed | Page timer delay |
| --- | ---: | ---: | ---: | ---: |
| Medium | 159 ms | 11 ms | 55 ms | 1 ms |
| Near node limit | 1,476 ms | 16 ms | 443 ms | 1 ms |
| Near byte limit | 623 ms | 15 ms | 223 ms | 1 ms |

Worker elapsed includes posting the actual document tree into the worker, JSON size measurement, conversion and returning metrics. It does not include returning the full final Markdown string or DOCX blob. Input generation occurs before worker timing. The earlier main-thread baseline includes its small synthetic input generation cost. Treat the table as evidence that blocking moves off the page, not a clean measurement of worker speedup.

The 4x CDP setting throttles the page and is not assumed to impose equivalent CPU throttling on workers. Worker-run page timer-delay medians under that setting were about 254 ms for near-node-limit Markdown and 176 ms for DOCX. Worker use substantially reduced blocking but did not prove a sub-50-ms end-to-end budget on the throttled page. Raw records retain this result rather than hiding it.

Text DOCX outputs passed a ZIP signature check; Markdown outputs retained the last numbered block. This does not establish Word layout fidelity. A separate tiny embedded-PNG case failed with `Buffer is not defined` in both execution contexts. Images, formulas, Mermaid, chart rendering, asset access, reference expansion and final download were not benchmarked. The production implementation must cover them before claiming complete export support.

The result supports a lazy export worker for both formats. Reuse the installed libraries with worker-compatible resolution and a scoped image-byte fix first. Keep conversion client-side. No production code or package dependencies were changed by this investigation.

## Reproduce

1. Run `node bench/editor/scripts/export-probe-server.mjs` and wait for port 5200. It builds and serves only the probe.
2. Run `node bench/editor/scripts/export-probe.mjs` in a second terminal. This records the default-condition main/worker results.
3. Stop the probe server. Set `EXPORT_WORKER_CONDITION=1` in both terminals, restart the server command, then rerun the probe command. This measures the worker-compatible build and includes actual input-tree transfer.
4. Raw results are ignored local files `bench/editor/.results/export-2026-09-27/results.json` and `worker-condition.json`. The initial current Markdown fixture output is in the same directory as `current.md`.

The runner and build script live in `bench/editor/scripts/export-probe*`. They intentionally report compatibility failures without acting as a CI gate. The app's running dev server is not restarted or reconfigured.
