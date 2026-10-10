# Agent shell discussion

Session record, 2026-10-11. Developer Epo with Claude (Opus 5.5) in Claude Code. User messages are quoted; answers are condensed. The idea is parked: no code changed. Outcome: the shell is not worth building for notes or sources today, and a render-review loop for agent output is the useful piece (planned separately).

**Parked state, in one paragraph.** A Linux-like shell for the chat agent (just-bash, a TypeScript bash with a virtual file system) only pays off for plain text files and computation. Notes, parsed PDFs, Office files and decks stay behind the existing tools, because file views of them confuse writes and skip the citation machinery. Revisit when users build code projects inside Capy (many `.py`/`.js` files that need running and editing together), or when agents clearly need Python for counting and checking.

---

## Go GC latency

> someone claims that because golang does garbage collection automatically, some requests can spike up for hundreds of ms, causing latency spike, and language like rust where you manage memory management, you dont have this issue, is rust viable for webservers?

- Go's GC has been concurrent since about Go 1.8. Stop-the-world pauses are usually well under 1 ms. Hundreds of ms is not a normal GC pause.
- The claim most likely traces to Discord's 2020 post: a huge long-lived in-memory cache on an older Go runtime that forced a collection every two minutes. Workload-specific.
- Real GC costs: allocation-heavy requests are drafted into GC work (mark assist), the GC takes about 25% CPU while running, and a heap pressed against `GOMEMLIMIT` can collect almost continuously. Hundreds-of-ms spikes in Go services usually come from slow queries, lock contention, swap, or container CPU throttling (Go before 1.25 ignores cgroup CPU limits for `GOMAXPROCS`).
- Rust has tail latency too: dropping a large structure at once, allocator fragmentation, and blocking calls inside async tasks that stall a Tokio worker.
- Rust is a mature web-server language (tokio, hyper, axum, sqlx; Cloudflare Pingora, Discord, AWS). Costs: compile times, learning curve, async complexity, slower feature work.
- For Capy: the Go backend is I/O-bound (Postgres, B2, ingest host, LLM providers taking seconds). GC pauses are noise. Rust already sits where it pays: the yrs collaboration server, which holds large long-lived CRDT documents. Measure before rewriting anything (`GODEBUG=gctrace=1`, `runtime/metrics` `/gc/pauses:seconds`, pprof).

## Go in wasm

> they claim another thing that its hard to bundle go apps into wasm because of garbage collection, causing stuff like esbuild struggling to get wasm working, and stuff like ts-go doesnt go inside of the browser for this reason, if its for this cause, does it justify rust?

- Go does compile to wasm (`GOOS=js GOARCH=wasm`, `wasip1`, TinyGo). The cost is that it ships its own GC and goroutine scheduler inside the binary: a few MB minimum, tens of MB for real programs, and slower than native. `esbuild-wasm` exists and works; it is just heavy and slower. tsgo accepted the same trade-off.
- Rust ships no runtime: binaries of tens to hundreds of KB, first-class tooling (wasm-bindgen, wasm-pack), and one codebase for server, browser and mobile (yrs and ywasm are an example).
- It does not justify rewriting the Go backend, which never runs in a browser. It does justify Rust for logic that must run on both client and server and be fast: CRDT (already Rust), FSRS scheduling offline (fsrs-rs, used by Anki), offline grading or local search later.

## Running code in the browser today

> so far to run actual go/node code in browser we need to use something like webcontainers which relies on wasm heavily I suppose, and it has heavy limitation a few years back if I recall, with all the rust porting and development going on, what are the current limitation/progress on running different kind of code in an isolated environment in browser right now?

Four approaches:

| Approach | Examples | Cost |
|---|---|---|
| Interpreter compiled to wasm | Pyodide/JupyterLite, ruby.wasm, WordPress Playground (PHP), quickjs-emscripten | C-extension packages must be prebuilt |
| Program compiled to wasm | Rust, C/C++, Zig; Kotlin/Dart/Java via WasmGC; Go (heavy) | No sockets; WASI only through shims |
| OS kernel faked in wasm, JS runs natively | WebContainers (a Rust kernel compiled to wasm, Node's JS on the browser's own engine) | No native addons, no TCP, needs cross-origin isolation, commercial licence |
| Full x86 emulation | v86, CheerpX/WebVM, container2wasm | Slow, large downloads, networking through a relay |

Shipped in the last few years: WasmGC (all major browsers by late 2024), JSPI (Chrome first), Memory64 (Chromium, Firefox), OPFS sync access handles, exception handling and tail calls, WASI 0.2. Remaining walls: networking, threads needing cross-origin isolation, native code needing recompile or emulation, download size, mobile Safari memory.

## Networking, isolation, native code, missing features

> for networking, that means anything that fetches from registry e.g. npm, will require server side relay? why cant it be called from client side
> so cross origin isolation, i remember we had to do this right now as well (i forgot what piece it is, office editing?), why do we need it? for shared array buffers?
> for native code compiles, whats the limitation? (aside from dependencies needing their own compiled version for wasm), and whats a shim?
> can you also explain whats the not shipped technologies, and can you give a few examples on whats possible and difficult/not possible right now

- **Networking.** A page can fetch any HTTP server, but reads a cross-origin response only when the server sends CORS headers. npm's registry (I believe) and PyPI do, which is how Pyodide's `micropip` installs straight from the browser. A relay is needed when the server lacks CORS (`git clone` from GitHub), the protocol is not HTTP (Postgres, Redis, SMTP, SSH), or a secret is involved. The browser is strict because it carries the user's logins and sits inside their network.
- **Cross-origin isolation.** `SharedArrayBuffer` plus a counting worker is a nanosecond timer, which makes Spectre practical, so browsers allow it only when `COOP: same-origin` and `COEP` prove the process holds nothing secret from other origins. It is what wasm threads and `Atomics.wait` need. It breaks popup sign-in (Clerk), and embeds without CORP headers (YouTube, B2 images, Stripe). In Capy the app is not isolated. The only COOP/COEP headers are in `bench/grading/scripts/browser.py` (threaded model inference). The Office runtime's separate origin is a security sandbox, a different thing.
- **Native code in wasm.** No syscalls; no blocking on the main thread (needs Asyncify, JSPI, or a worker with `Atomics.wait`); no `fork`/`exec`/signals; no JIT (JVM, .NET, LuaJIT fall back to interpreters); no inline assembly, only 128-bit SIMD; memory capped at 4 GB in wasm32 and never shrinks; roughly 1.2 to 2 times slower than native.
- **Shim.** A thin layer that pretends to be the API the code expects, built on what exists (Emscripten's POSIX `open()` on an in-memory FS or OPFS; jco's WASI shims). It cannot create what is missing underneath: a TCP socket shim tunnels through a WebSocket relay.
- **Possible today:** client-side Python notebooks, SQLite on OPFS, small models with WebGPU, Node toolchains in WebContainers, WordPress Playground, ffmpeg.wasm, TeX compile, Capy's Rust/wasm Office engines, WebVM. **Hard:** direct database connections, `git clone` from GitHub, native Node addons, Python `subprocess`/`multiprocessing`, real Docker, listening on a port, background work after the tab closes, large memory on iOS, JIT runtimes at native speed.

## Goroutines, iframes, policy versus engine gaps

> how does go coroutines work and how it relates to stack switching, there is a ts-rust port from ts-go which had this file https://github.com/pingdotgg/ts-rust/blob/main/crates/ts_goport/src/gostd/runtime.rs that seems interesting
> shared-everything threads -> this requires cross origin isolation right? and on mechanism of cross origin isolation, can it be inside an iframe? does the COOP/COEP require the parent frame to carry the same policy? meaning if I do something like embed youtube videos on the main app page it wont work?
> what does direct sockets for normal pages mean? doesnt this relate directly to browser support/limitation? same with native wasi and jspi
> shrinking memory -> is the memory here meaning the context/resources around the things running the wasms?
> and on jspi, wont a shim handle the sync vs async using stuff like opfs? something like https://github.com/vercel-labs/just-bash
> given the ports being done, whats the challenge in porting the different native add ons into rust
> for websocket and ports, these do really seem like browser support/safety concerns

- **Goroutines are stack switching.** Go's scheduler runs many goroutines on few OS threads; each goroutine has a small growable stack, and parking one means saving a stack pointer and program counter and jumping to another stack. Wasm cannot touch its own stack, so Go's wasm target rewrites every function to unwind into Go's own stack in linear memory and rewind on resume (bigger, slower; Binaryen's Asyncify does the same for C and Rust). Rust's `async fn` is a stackless coroutine compiled into a state machine, so it needs no runtime switching. The wasm stack switching proposal (WasmFX: `cont.new`, `resume`, `suspend`, `switch`) would let Go map goroutines to engine-managed stacks; as of mid-2026 it is Phase 3, behind `--experimental-wasm-wasmfx` in V8, and a stub in SpiderMonkey.
- **ts-rust's `runtime.rs`** only computes `GOMAXPROCS` (env var, CPU mask, cgroup quota) and returns 1 on wasm. Its porting guide maps `go f()` to a FIFO queue on the dispatch thread or to `std::thread::spawn`, and replaces the GC with arenas, `Arc`/`Rc` and explicit release. That works because tsgo uses goroutines for parallelism, not for concurrency, so the port removed the need for a scheduler rather than solving it.
- **Isolation and iframes.** Shared-everything threads will need the same isolation as wasm threads. With classic COOP/COEP an iframe cannot be isolated on its own: the top page needs COOP and COEP, every frame on the path needs COEP, and a cross-origin iframe needs `allow="cross-origin-isolated"`. So YouTube embeds on an isolated app page break (Chrome's `<iframe credentialless>` loads them signed out). Chrome 137 (May 2025) shipped Document-Isolation-Policy: a per-document header that isolates one iframe with no parent requirements, at the cost of a separate process. **Open item:** `openwiki/frontend/office-files.md` says threaded wasm could be enabled on the Office runtime origin "without isolating the SPA"; that holds only with DIP, so in Chrome only.
- **Engine gaps versus policy.** Stack switching, shared-everything threads, memory control and JSPI everywhere are engine work that will land. Direct Sockets exists but Chrome limits it to Isolated Web Apps on purpose; raw sockets, listening ports and reading responses without CORS are safety decisions that will not change for normal pages. Native WASI in browsers is the wrong layer (jco converts components to JS).
- **Shrinking memory** means the module's own linear memory. `memory.grow` only grows; the allocator inside reuses freed space, but the browser keeps the touched pages until the instance is dropped. Capy's per-file XLSX worker already frees memory the right way: closing the file ends the worker.
- **JSPI versus shims.** just-bash is bash reimplemented in TypeScript with an async API, so it never has the problem. The problem appears when compiling existing blocking code. OPFS has a synchronous access handle in dedicated workers, so a file shim can be truly synchronous (SQLite's `opfs-sahpool`). `fetch`, IndexedDB and messages have no sync form, so those need `Atomics.wait` with isolation, sync XHR in a worker, Asyncify, or JSPI. just-bash's `python3`, `sqlite3` and `js-exec` currently need Node; it runs without VM isolation.
- **Native addons.** The binding is small; the C library underneath is the work (sharp is libvips and codecs; canvas is Cairo and Pango; better-sqlite3 is SQLite). People recompile the C to wasm rather than rewrite it. OS-bound addons (node-pty, fsevents) have nothing to port to. Hand-written assembly is lost, synchronous APIs must become async in a worker, and rewrites change output bytes. napi-rs can build the same Rust crate natively and as `wasm32-wasip1-threads` (oxc, rolldown, swc, lightningcss). A compiler like tsgo is pure computation, the easiest case.

## Memory in wasm, IndexedDB, and the agent shell

> on the shrinking memory, so wasm never truly release its own memory and is just simulating it by faking that memory is released? is that how gc go wasm or other gc works inside of wasm?
> if I dont need to lets say run sqlite this exact library because im not trying to run an app that is using it, but rather I just need the functionality of e.g. storing data and retrieving as if I am in an actual sql database, could indexed db do that already without needed to use sqlite-wasm?
> for capy-notebook, there is one more idea in my mind: a simple linux/node environment for the agents inside of chat/generally in the app (dont want to run inside of our own servers, because of compute constraints). because most llm models are trained to run linux commands and excel in running them rather than custom toolings that we have right now e.g. for creating/editing files, imagine if you can just `cat` some strings into the files and we somehow map it to the yrs collab server. Another point is I see agents really like to run python scripts, either to count/wait/test something, which if we provide the same environment to the agents, they can get more work done

- **Wasm memory** has two layers: the browser gives the module pages, and the language's allocator manages them. Native allocators can return pages with `munmap`/`madvise`; wasm cannot. Go on wasm stays at its peak heap (its scavenger cannot return pages). WasmGC languages keep objects in the browser's GC heap, which does free them.
- **IndexedDB** is a transactional object store with indexes, range scans, compound indexes, cursors and counts. No joins, no combining two indexes in one query, no aggregation beyond count, no full-text search, slow per call (batch inside one transaction). Enough for caches, drafts and listings; SQLite-wasm on OPFS for relational queries, joins or search; PGlite for the server's own SQL dialect. Eviction matters more than the engine: call `navigator.storage.persist()`, and Safari deletes script-written storage after 7 days without interaction unless the site is installed.
- **First take on the agent shell.** Chat turns already end when the browser disconnects (`openwiki/agentic-retrieval.md`, "If the browser disconnects"), so client-side tools lose nothing. It needs client-executed tools (server waits for a posted result keyed by `toolCallId` and never trusts it for authorization or billing), containment against prompt injection (CORS does not stop a worker from sending data out, so no network, a separate-origin sandboxed iframe like the Office runtime, time and memory limits), and attention to device weight (Pyodide is about 10 MB or more; WebVM hundreds of MB). Free browser compute still means more model steps, and model calls are what cost money.

## Plate JSON and Office skills

> on rich plate documents, why need to export to markdown? the plate is just a json file though right? would the issue be that yrs collab on plate doesnt expect the json to be edited directly?
> for office files, actually im interested in codex approach, i think they have an office files skills that lets agents update and edit office files, is that open sourced?
> we dont have accepting AI preview on our forked version of better office, writes are instant

- The live note is a Yjs document (`@slate-yjs` stores the tree as nested `Y.XmlText`); `materials.content` JSON is a read projection. yrs accepts any update, but replacing the whole tree gives every item a new identity: concurrent typing lost, comment anchors orphaned, cursors jump, tombstones grow the document, undo becomes all-or-nothing. A minimal diff keyed by block id (`inspect_document` already shows ids) preserves identity. Plate JSON is several times more tokens than markdown and models break its structure; LaTeX inside JSON inside sed is escaping on three levels.
- **Codex Office skills.** `openai/skills` had curated `doc` (python-docx, render DOCX to PDF to PNG), `slides` (PptxGenJS, LibreOffice render, overflow and font checks, montage) and `spreadsheet` (openpyxl and pandas, formulas over hardcoded values, recalculate and render), each Apache-2.0. They were removed (commit `fdf90d65`, "Remove spreadsheets and slides skills", and "Remove curated doc skill"); the repo is deprecated in favour of `openai/plugins`, which does not carry them. The old versions remain in git history under Apache-2.0. All three are file-in, file-out, which suits generating new files and not editing a file someone has open.
- With no preview step, undo is the safety net: every agent write must produce an undo receipt, as `edit_document` does. Shell writes would have to go through the same server edit path (`/api/internal/documents/edit`), not straight to the collaboration server.

## Testing whether a shell helps

> so what plan do we have for capy, and how do we even begin to test whether bringing familiar linux like commands will help agents, how do we know if something like just bash is "good enough" when its mapped to typescript (memory/cpu usage). text files editing -> cat it sure, markdown json -> its verbose yes, but just like any other files, you do sed or cat or tail, and do a precise edit right? so question is does it gain edit quality with fewer rejections/understand the note file better, or is it actually worse. on office files render-and-check loop is something good to have, tho glm seems capable enough to one-shot pptx on current setups. to make the environment easier to work with for agents, we can make chapters presented as if its folders, files are just files, but then we need to actually tap into just bash code and integrate it natively into our app right? so we should shape our prompts and skills such that on the agent side they think they are working on a normal linux vm, and capy notebook skills are something like mcp skills/connectors

- **No fork needed.** just-bash 3.6.0 exports `IFileSystem` (`src/fs/interface.ts`: async `readFile`, `writeFile`, `appendFile`, `readdir`, `stat`, `rm`, `mv`, …); `MountableFs` mounts any implementation, and `defineCommand(name, async (args, ctx) => …)` adds commands. Built-ins include `grep`, `rg`, `sed`, `awk`, `jq`, `yq`, `find`, `diff` and more; `executionLimits` caps call depth, command count, output, file-system bytes and time.
- **Harness to reuse:** the 2026-10-09 edit lab (`bench/rag/reports/local/2026-10-intake-eval/edit-tools-comparison.md`): six scenarios with programmatic checks (`revert`, `quiz`, `merge`, `rewrite`, `split`, `learner`), outside-edit runs, a TypeScript engine holding materials as Y.Docs (`collaboration/scripts/edit-lab-engine.ts` in the `capy-edit-lab` worktree), and the driver. 90 GLM runs there showed failures came from argument shape and inexpressible edits; a file interface removes the first and adds sed escaping, silent content drops in heredoc rewrites, and over-broad regex.
- **Proposed then:** a Node sidecar with just-bash and a `CapyFs` over the lab engine, one commit per `bash` call (diff against the version the agent read, applied through `applyMaterialCommands`, validation failures as stderr), honest framing as "a sandboxed Linux-like shell with no network" rather than a pretend VM, server tools kept native, and three note formats compared (`note.md`, one file per block, Plate JSON). Device cost would be measured by replaying recorded commands in Node and in headless Chromium with 4× CPU throttling, Python measured separately.

## Narrowing

> fine i do actually think the note edit is better presented as a connector/skill more than anything, which means that notes shouldnt be presented as a file, only text sources can right?
> treating notes and parsed pdf being read as if its a local md file can potentially confuse agents when they write (do we not have office files writing skills? except the deck one, but the deck example still applies, if we present the ability to read deck files as md files, they might not know that the render-review loop or capture_page tool can even work on those.
> second is that the search_workspace tool exists for rag searches, and does just bash do grep? how does the agent know when to use which
> hmm i guess much of the shell values gone unless someone wants to build an app inside of capynotebook with bunch of codes inside of it

- **Notes, parsed PDFs, Office files and decks stay out of the shell.** Besides the write confusion, reads through the shell skip the citation machinery: `search_workspace` and `read_document` declare `retention: cited_passages`, and the write guard only lets the agent cite excerpts it has read. A `cat` produces neither.
- **Office writing today:** no dedicated skill; Office edits go through `edit_document` under the `editing` skill (paragraph, shape and cell target ids). `write_slide` runs ppt-master's structural checker, and `capture_page` renders only source pages a shown passage cites. So nothing lets the agent see its own output: that is the real gap, independent of the shell.
- **grep versus search:** just-bash has `grep` and `rg`. `search_workspace` finds meaning across every indexed source and returns cited passages; grep finds exact strings (a variable, a CSV value, a LaTeX macro) in the shell's files only and cites nothing. Cursor offers both and says in the tool descriptions which to use when. A Capy rule would be: answer from sources through the citing tools; use the shell to work on text files and compute.
- **What would be left:** text sources (`.py`, `.csv`, `.tsv`, `.json`, `.yaml`, `.tex`) as writable files (the file is the `Y.Text`, so a line diff maps exactly, written through `edit_document`'s plain-text target), a scratch directory, and Python. If Python turns out to be most of the value, a plain `run_python` tool (Pyodide in a sandboxed worker) is lighter than just-bash.

## If this is revisited

1. **Trigger:** users keep multi-file code projects in Capy, or chat logs show agents failing at counting and checking that Python would do.
2. **Scope:** text sources plus scratch plus Python. Never notes, parsed sources, Office files or decks.
3. **Experiment:** two arms in the playground (current tools versus current tools plus `bash`), text-source editing and computation scenarios plus a regression subset of the edit lab. Measure pass rate, collateral damage, tokens per turn, tool choice between grep and search, uncited claims, and shell compatibility (exit 127, unsupported flags).
4. **Device cost:** replay recorded commands in Node and in headless Chromium at 4× CPU throttle; Python cold and warm start separately.
5. **Containment:** separate-origin sandboxed iframe with a worker, CSP `connect-src 'none'`, no auth tokens, time and memory limits, worker killed after each turn; writes only through the server edit path with undo receipts.
6. **Check first:** whether an uploaded `.md` source is stored as plain text or converted into a note.

Sources consulted: [ts-rust](https://github.com/pingdotgg/ts-rust) (`runtime.rs`, `PORTING.md`), [just-bash](https://github.com/vercel-labs/just-bash), [Document Isolation Policy](https://developer.chrome.com/blog/document-isolation-policy), [WebAssembly stack switching](https://github.com/WebAssembly/stack-switching), [Asyncify and JSPI in WordPress Playground](https://developer.wordpress.org/playground/developers/architecture/wasm-asyncify/), [openai/skills](https://github.com/openai/skills), [openai/plugins](https://github.com/openai/plugins).
