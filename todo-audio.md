# Audio: uploaded recordings and voice input

The working file for bringing audio back after ElevenLabs was removed
(b8cd32ead, 2026-10-13): uploaded audio sources are transcribed and indexed
again, and the chat box gets voice input. Cross-workspace search and new
agent tools are parked until this lands (Epo 2026-10-23).

Measurements: `bench/stt/reports/2026-10-20-stt-clips.md` (20 hosted models,
Cantonese, Mandarin and English clips, Alibaba options, throughput, Beijing
vs Singapore from the UAT hosts). Current behaviour once built:
`openwiki/agentic-retrieval.md` (ingest), `openwiki/observability-metering.md`
(credits). Ownership: ingest and the Go/pipeline source code are the Editor
session's (`COORDINATION.md`); pushes go through it.

## Decisions (Epo, 2026-10-23)

Record each in `human/` when the code lands.

- **Provider:** Alibaba Model Studio, **Singapore** workspace
  (`ap-southeast-1`). Beijing was slow and failed Filetrans tasks from the EU
  hosts. `ALIBABA_MODELSTUDIO_KEY` / `ALIBABA_MODELSTUDIO_URL`; the key is
  restricted to the models below.
- **Uploaded audio:** `qwen-audio-3.1-asr-flash-filetrans` (async, file link).
  `keep_dialect: true` (Cantonese stays as spoken), speaker labels on
  (`diarization_enabled`), workspace context sent with the task.
- **Voice input:** `qwen-audio-3.1-asr-flash` (sync), `keep_dialect: true`,
  workspace context. Not the `-message` model (it ignored every option and
  needs a WebSocket).
- **Limits:** uploads at most **2 hours** (diarization's limit), rejected in
  the browser before upload and again on the server. Voice input at most
  **2 minutes** (well under the 4,000-character chat input).
- **Concurrency:** at most **12** Filetrans tasks in flight across the ingest
  workers; **one retry** for a failed task.
- **Timestamps:** kept, outside the searched text (see below).
- **Credits:** set by us, above the standard markup because capacity is
  capped. Rates below are a proposal awaiting Epo's numbers.

## Landing (Editor session, 2026-10-23)

- Built in `C:/WEB/capy-worktrees/audio` (branch `audio`), Part A then B.
  The Editor session reviews and pushes; agents never push.
- Migration: **0110** was reserved for audio, but the test database needs
  contiguous numbers, so the branch uses **0109** (as do the Editor's
  client-id binding and the billing session). Whichever lands later renumbers.
- The Office session's `capy/office-trace-progress` touches ChatTrace and the
  pipeline's chat relay: check it before editing ChatTrace or the chat
  stream code.
- Deploys wait for the UAT session's Coolify cutover. The ingest host serves
  prod, UAT and local, so the env changes are listed per environment.
- Live provider tests run from the machine whose calls they test (Filetrans
  from the ingest host, voice input from the app host), never from the
  developer PC; keys stay there. Unit tests use fake servers.
- Review checks: the presigned link is short-lived, read-only and for one
  object; the 2-hour and 2-minute caps are enforced on the server; the voice
  endpoint's auth, rate class and body-size limit; credits reserve/settle
  with no double charge on the retry; no transcript or audio in logs or
  Sentry. Commit messages and docs state rules only (public repo).
- Before landing: the frontend_check steps locally, then CI and Audit green.

## Provider facts (measured 2026-10-20..23)

- Accuracy: Mandarin podcast CER 1.4% (Flash) / 2.0-2.4% (Filetrans), Scribe
  v2 was 2.4%; Cantonese kept as spoken with `keep_dialect`; English
  word-perfect.
- `vocabulary` hotwords were ignored. Context (a text message before the
  audio: `input.messages` for Flash, `input.context` for Filetrans, at most 5)
  helps names: "Capy Notebook" came out right in some runs, "Capy No Book" in
  others.
- From the UAT hosts to Singapore: Flash 1.6-3.5 s for 7.5-30 s clips,
  Filetrans about 3-5 s for a short file and 13-19 s for 9 minutes.
- Rate limit: 429 `Throttling.RateQuota` from about 20 Flash requests in
  flight (both hosts together). Check the workspace quota before launch.
- Formats: Flash accepts Opus (`webm`, `ogg`), AAC (`m4a`, `mp4`, `aac`), MP3
  and WAV data URIs, so MediaRecorder output goes through unconverted. Sync
  input is capped near 5 minutes (7,168 tokens).
- Filetrans takes a URL (`file_urls`); the result is a JSON file at
  `output.results[].transcription_url` with `transcripts[].sentences[]`
  (`begin_time`/`end_time` ms, text, speaker when diarization is on).
- Price (Singapore list): $0.15 / $0.47 per 1M input/output tokens for both
  models, roughly $0.01-0.02 per audio hour.

## Credits (proposal)

One credit is $0.0005 of provider cost at the standard rate (2,000 credits
per provider dollar, users pay $1 per 1,000 credits), so the standard rate
would be about 20-35 credits per audio hour.

| Rate key | Proposed | Per hour | Why |
| --- | --- | --- | --- |
| `audio_transcription_second` (uploads) | 16,667 micros/s = **1 credit per minute** | 60 | 2-3x the standard markup for the capped capacity; a 2-hour lecture (120 credits) costs about what a 300-page PDF does at 0.4 credits a page; the old ElevenLabs rate was 900/hour |
| `voice_input_second` (chat) | 16,667 micros/s = **1 credit per minute** | 60 | same rate, own key so it can be tuned or made free; a full 2-minute dictation is 2 credits |

Charged on success from the measured duration (ceil seconds), nothing for a
failed or retried task. Rates live in `resource_credit_rates` and the ops
dashboard edits them; a migration seeds the first version.

## Timestamps without polluting search

`rag_chunks` already carries locations outside the searched text:
`page_start`/`page_end` and `regions` (jsonb, each entry naming its `space`).
Audio chunks use the same columns:

- `text` / `indexed_text` / `search`: the transcript sentences only, no
  times, no speaker labels, so lexical and vector search see speech and
  nothing else.
- `regions`: one entry per sentence, e.g.
  `{"start_ms": 61200, "end_ms": 64980, "speaker": 1, "space": "audio-ms"}`.
- `page_start`/`page_end` stay null.
- Chunking groups whole sentences and prefers to break at a speaker change or
  a long pause, so a chunk never splits a sentence's time range.
- The read tool and citations render times from `regions` at read time
  (`[12:30 · Speaker 2]`); the file view seeks the player to `start_ms`.

## Part A: uploaded audio (Filetrans)

Start from b8cd32ead's diff: it removed the route, cache, lock, duration cap,
billing and upload-dialog duration read. Restore what still fits; replace the
ElevenLabs client and capacity leases.

Pipeline (`pipeline/pipeline/ingest/`):
- [x] `plan.py`: `audio_transcription` route and formats back (mp3 wav m4a
      ogg flac aac webm mp4 mpeg mpga opus).
- [x] `source_text.py`: Filetrans client. Mint a presigned B2 read link for
      the source (TTL long enough for the task), submit with
      `keep_dialect`, `diarization_enabled`, `channel_id: [0]` and context
      (workspace title, file name), poll the task inside the attempt, read
      `transcription_url`. No waiting state is stored between attempts
      (revisits the 2026-09 "no polling" line, which assumed a sync provider).
- [x] Cache by source SHA (`derived-text/<sha>/qwen-audio-3.1-filetrans.json`,
      sentences with times and speakers) and the per-source lock, as before.
- [x] Concurrency: a 12-slot cap across workers (reuse the provider-capacity
      table without weighted units, or a plain count); a full cap is
      `CapacityWait`.
- [x] Errors: 429 and task `FAILED` retry once, then terminal; a bad link or
      unsupported file is terminal at once.
- [x] Duration: measured before submitting; over 2 hours is the
      `audio_duration_limit` index limit (restore the enum value).
- [x] Chunking from sentences into `text` + `regions` as above.
- [x] Settle `audio_transcription_second` on success (units back on
      `provider_calls`, `KindAudio` in Go).
- [x] Tests: plan route, client happy path and the retry-once rule against a
      fake server, chunk regions, settlement.

Server (Go):
- [x] `sourceupload/rules.go`: audio indexable again with the 2-hour limit in
      the upload policy.
- [x] Credits: `KindAudio` provider calls with second units, the rate key,
      `CreditsForAudioSeconds`.
- [x] Migration 0109 (0110 was reserved; renumber at landing if taken): rate rows, `files.index_limit` value, `provider_calls`
      units/unit.

Frontend:
- [x] Add-source dialog reads the duration in the browser and rejects over 2
      hours before upload, with a credit estimate.
- [x] Citation / file view: an audio citation seeks the player to its time.

Config and docs:
- [ ] `ALIBABA_MODELSTUDIO_KEY` / `_URL` in `deploy/env-manifest.json`, the
      ingest host env examples and the runbook; UAT gets a Singapore key.
- [x] `openwiki/agentic-retrieval.md` (audio route, regions), metering doc,
      test catalog, `human/` lines.

Review fixes (2026-10-24):
- [x] Duration: ffmpeg copies every packet to the null muxer under the
      decoder sandbox's policy (`decode.audio_seconds`), so a WebM with no
      duration and an MP4 with edited header boxes are measured; a CI test
      checks the probe runs sandboxed. CI installs ffmpeg for the pipeline
      job.
- [x] Billing: whole seconds of the measured length or the last sentence's
      end, whichever is later; speech ending past 2 hours is
      `audio_duration_limit`, uncharged and uncached.
- [x] Polling: a 408, 429, 5xx or lost answer on a poll keeps polling within
      the wall budget; any state but PENDING/RUNNING/SUCCEEDED/FAILED ends
      the poll as retryable; polls back off from 2 s to 10 s and log at
      DEBUG.
- [x] Result link: https only (http upgraded), on
      `dashscope-result-*.oss-*.aliyuncs.com`, no redirects.
- [x] Pipeline Sentry breadcrumbs keep request URLs without their query.
- [x] A task that may still run (timeout, cancel, lost submit answer) keeps
      its gate lease until the receipt window ends.
- [x] Config: `ALIBABA_MODELSTUDIO_URL` must end with `/compatible-mode/v1`
      (startup); unset settings fail before measuring; the link is signed
      after admission.
- [x] Browser length read: 5 s timeout with no length, `audio.load()` called.
- [x] `audio_transcription_second` seeded as version 2.
- [x] Docs: whole-sentence chunks can exceed the budget; a Retry after a lost
      cache and a later failure pays again.
- [x] `KindAudio`, `CreditsForAudioSeconds` and the `voice_input_second`
      row stay for Part B, which lands on this branch before main.
- [x] Unknown length (Epo 2026-10-24, "block"): a file whose length the
      browser cannot read (5 s, zero, or Infinity after seeking past the
      end) is refused with a toast naming it; the upload request requires
      `durationSeconds` for audio.

## Part B: voice input (Flash)

- [ ] Chat composer mic button: hold or toggle to record with MediaRecorder
      (Opus in Chrome/Firefox, AAC in Safari), a visible 2-minute countdown,
      stop at 2:00.
- [ ] Go endpoint (workspace-scoped, e.g.
      `POST /api/workspaces/{id}/transcriptions`): accepts the clip (size
      bound from 2 minutes of Opus/AAC), checks duration, reserves credits,
      calls Flash with `keep_dialect` and workspace context, settles
      `voice_input_second`, returns `{text}`. No retries; a 429 or provider
      error returns an error the composer shows inline, and the user records
      again.
- [ ] Per-user rate limit on the endpoint (the existing limiter).
- [ ] The text is inserted into the composer for editing; nothing is sent
      automatically. The audio is not stored.
- [ ] i18n strings (paraglide), mic permission denied state, 360 px layout.
- [ ] Tests: endpoint validation and settlement with a fake provider; the
      composer's record-insert flow in Vitest.

## Open

- Credit numbers (proposal above).
- Whether voice input works outside a workspace (no context to send).
- Workspace quota for Singapore before launch; ask Alibaba for more if the
  observed ~20 in flight holds.
- Filetrans gate size: 12 never binds with one job per ingest replica, and
  audio can hold every replica; a smaller gate or a separate audio worker
  (Epo). The gate is per environment database; whether the prod and UAT
  keys share one Alibaba workspace quota.
- A recording with no speech fails the file today; failed or ready and
  unindexed (Epo).
- Migration number: 0109 on the branch, renumbered at landing.
- Live checks from the ingest host: ffmpeg under the decoder sandbox in the
  deployed image, the result link's host shape and the `speaker_id` field
  on a real Singapore task.
