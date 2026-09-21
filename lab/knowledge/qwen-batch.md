# Optional Qwen book-review batches

Sol completes its initial book work and emits self-contained text packets.
`qwen_batch.py` sends selected packets to Qwen3.8-Max when the developer chooses.
Another person or agent can assess the saved responses later. Nothing here
updates book tags, publishes books, starts Sol, or waits for a review verdict
before initial processing can finish.

Run commands from the repository root. The existing ignored `.env.local` must
contain `ALIBABA_API_KEY` and `ALIBABA_BASE_URL`; the single-request test uses
the same credentials. Never put the key in a command argument or batch directory.
Environment variables override the selected env file.

## Prepare, submit and collect

Prepare one batch with explicitly selected saved packets:

```sh
uv run python lab/knowledge/qwen_batch.py prepare --packets path/to/book-a.packet.json path/to/book-b.packet.json --run data/knowledge-base/qwen-reviews/first --thinking
```

Choose `--thinking` or `--no-thinking` explicitly. Both use strict JSON Schema
and omit `max_tokens`, `max_completion_tokens` and `thinking_budget`. Preparation
is offline and reads no credentials. It copies full packets, prompt, settings
and schema, then writes the exact request JSONL and a hash manifest. The example
uses thinking, which handled the large saved Sol packet better in the comparison;
the non-thinking fixture settings remain unchanged.

Submit that frozen input once:

```sh
uv run python lab/knowledge/qwen_batch.py submit --run data/knowledge-base/qwen-reviews/first --env-file .env.local
```

Poll immediately, then every ten minutes until the job finishes:

```sh
uv run python lab/knowledge/qwen_batch.py poll --run data/knowledge-base/qwen-reviews/first --env-file .env.local --watch
```

Without `--watch`, `poll` makes one check and collects results if terminal.
`Ctrl+C` stops local polling; the remote job keeps running. Repeat the same
`poll --watch` command to resume. A network interruption or HTTP 429/5xx during
read-only polling waits until the next ten-minute check. Permanent provider
rejection or invalid local state stops for the operator to inspect. Submission
writes are never retried by this polling loop.

The watch process must keep running on an awake computer. On Windows, it can run
in the background with logs, using the repository's virtual environment:

```powershell
$reviewRun = (Resolve-Path 'data/knowledge-base/qwen-reviews/first').Path
$reviewPython = (Resolve-Path '.venv/Scripts/python.exe').Path
$reviewProcess = Start-Process -FilePath $reviewPython -ArgumentList '-X utf8 lab/knowledge/qwen_batch.py poll --run data/knowledge-base/qwen-reviews/first --env-file .env.local --watch' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -PassThru -RedirectStandardOutput "$reviewRun/watch.log" -RedirectStandardError "$reviewRun/watch-error.log"
$reviewProcess.Id | Set-Content "$reviewRun/watch.pid"
```

This local process is separate from the paused `kb` scheduler. To stop it,
verify the process recorded in `watch.pid` is still this poller, then stop that
process. After a forceful termination, inspect `review-command.lock` and
`command.lock` and remove only locks belonging to a process that has exited
before resuming. Normal `Ctrl+C` releases locks automatically.

## Saved results

| File | Contents |
| --- | --- |
| `manifest.json`, `packets/`, `prompt/`, `input.jsonl` | Immutable inputs, selected thinking mode and hashes. Original Sol files can change later. |
| `state.json` | Input/file/batch IDs, bound provider endpoint and latest state. |
| `batch.json`, `poll.json` | Last complete provider job response, including batch errors, and last check time. |
| `output.jsonl`, `errors.jsonl` | Original downloads, including partial output from failed, expired or cancelled jobs. |
| `responses/<custom_id>/response.json` | Raw per-packet response, including reasoning content and usage when supplied. |
| `responses/<custom_id>/review.json` | Parsed review when JSON is available, even when a contract check warns. |
| `responses/<custom_id>/receipt.json` | Packet identity, transport outcome and schema/coverage/quote warnings. |
| `summary.json` | Every selected packet, missing/failed outcomes and response IDs. Adjudication starts as `pending`. |

Results match by `custom_id`, never file order. Schema, assigned scope, coverage
and exact source quotes are checked against the frozen packet/schema. These
checks do not decide whether advice is correct. A no-op suggestion such as
changing an already non-teaching excerpt remains for the assessor to dismiss.
Warnings leave raw and parseable responses available.

Exit 0 means the command succeeded or the job is still running; it does not
approve findings. Terminal jobs with missing, failed or truncated provider
output exit 1 after saving available results. Contract warnings and content
findings do not fail collection. Repeating `poll` after collection rebuilds
the summary locally without credentials or another provider request. Keep
assessor decisions in a separate file so recollection cannot overwrite them.

## Submission recovery and limits

The shared durable client records upload and creation state before network
writes. Repeating `submit` reuses a saved batch ID. After an uncertain write,
it searches for an unambiguous existing file/job rather than blindly
resubmitting. Upload recovery can leave state `prepared` with a saved file ID;
another explicit `submit` creates the job using that file. Ambiguous matches
stop for operator reconciliation. Failed inference is never automatically
resubmitted, and there is no synchronous-model fallback.

Use a new directory to intentionally send a new review. Changing frozen inputs
in place is refused. The endpoint becomes bound on the first network command,
preventing later polls from targeting a different regional/workspace endpoint.

The [Alibaba batch guide](https://help.aliyun.com/en/model-studio/batch-inference)
lists Qwen3.8-Max for Beijing batch inference. It requires one model and thinking
mode per file, at most 50,000 requests, 500 MB per file, 1 MB per line and a 256K
context limit for this model. Preparation checks file/line sizes; it does not
estimate Qwen tokens. Oversized packets need smaller explicit Sol scopes while
preserving required linked context. Source text is never silently truncated.
These are provider input limits, not caller output-token caps.

The client requests the documented `24h` completion window. Jobs can take hours;
the watcher imposes no short overall timeout. The
[Batch API reference](https://help.aliyun.com/en/model-studio/batch-interfaces-compatible-with-openai)
describes the upload, creation, status and result-download endpoints used by
the shared client. Keep downloaded files; provider retention is limited.
