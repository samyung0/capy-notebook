# Capy Qwen review pack

This ZIP is self-contained. Unzip it before running the examples. It contains
the draft Qwen review prompt, proposed fixed Sol assignment, eleven sample
cases, two source-page images, expected findings, and a Python runner.
No API credentials are included. No Qwen calls have been run by Codex.

Start with these files:

- `bench/rag/fixtures/knowledge-review-v1/system-prompt.txt`: exact Qwen prompt.
- `bench/rag/reports/2026-09-21-qwen-review-proposal.md`: prompt rationale, fixed
  Sol assignment and proposed scheduler addition.
- `bench/rag/fixtures/knowledge-review-v1/README.md`: case descriptions and
  source attribution.
- `bench/rag/fixtures/knowledge-review-v1/cases/01-claims.json`: first sample.
- `bench/rag/fixtures/knowledge-review-v1/expected-findings.json`: human answer
  guide. Do not include it in a model request.

## Run without the Capy repository

Python 3.10 or newer is required. From the unzipped directory containing this
file, install the three small dependencies in your preferred Python environment:

```sh
python -m pip install -r requirements.txt
```

Prepare a request without an API key or network request:

```sh
python bench/rag/scripts/knowledge_review_samples.py --case 03-pages --output runs/03-dry --dry-run
```

Open `runs/03-dry/request.json` to inspect the exact request, including the
encoded image. For a live call, create a local `.env` file using your Alibaba
Model Studio key and the matching workspace/region's compatible API base URL:

```dotenv
ALIBABA_API_KEY=YOUR_KEY
ALIBABA_BASE_URL=YOUR_WORKSPACE_COMPATIBLE_API_BASE_URL
```

Then send one case:

```sh
python bench/rag/scripts/knowledge_review_samples.py --case 03-pages --output runs/03-live --env-file .env --send
```

Each output directory must be new. Swap `03-pages` for another case ID from the
case index. This makes one request with the settings in
`bench/rag/fixtures/knowledge-review-v1/request-settings.json` and saves the
request, receipt and response. It never retries, switches models, publishes
books or writes to a library database. Read `review.json` when schema validation
passes, then compare it against the expected findings and the source images.
The settings are a draft and Max access for the existing workspace is unverified.

To use your own client, supply `system-prompt.txt` and `response-schema.json`
as instructions, then the selected case JSON and its actual listed image files.
A path or capture receipt alone is not visual evidence.

## What was checked locally

All eleven requests were built without credentials or network access. Three
focused tests cover image integrity and answer-key exclusion, the dry-run
boundary, and complete per-target review coverage. The page images were
visually inspected. These checks validate the pack and runner, not Qwen quality.

The scheduler remains paused. Applying the proposed fixed Sol prompt and
running the Qwen quality trial are waiting for the developer's prompt review.
