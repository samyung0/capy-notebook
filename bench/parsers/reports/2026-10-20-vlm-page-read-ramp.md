# VLM page reads: capacity ramp of DeepSeek V4.1 Flash 1017 on DeepInfra

2026-10-21. DRAFT, numbers pending.

## Setup (page reads)

- **Where**: inside the UAT ingest worker container on the ingest host, with
  that container's code, catalog, prompt, routing and OpenRouter key:
  `vlm_ramp.py feed` on the host pipes the driver and the page renders into
  `docker exec -i <worker> python -c …`; nothing is written in the
  container. The driver builds every body with the client's own
  `openrouter_request` from the catalog's captioning default
  (`deepseek/deepseek-v4.1-flash-1017` v1, params empty, so temperature 0.3),
  the v19 `VLM_PAGE_PROMPT` as the system message, the render as a JPEG data
  URL, `max_tokens` 2,000, reasoning off and the DeepInfra pin with
  fallbacks off; the HTTP timeout is the ingest provider timeout (120 s).
- **Pages**: real renders from the parser's `render_jpeg` (grey JPEG, long
  edge 1,280 px, quality 80): four CC-licensed books from the parser budget
  fixtures made image-only at 150 dpi (`stress_parser.py corpus`) and parsed
  by the v19 parser, so every page went through the production render path.
  Biology (textbook, figures), open logic (mathematics), a legal citation
  guide (prose) and a waterworks maths workbook (worked calculations); each
  read uses a page no other read used, so no answer comes from a provider
  prompt cache. Every level has the same book mix (40 pages of each book),
  plus 2-3 of the 13 hand-labelled lecture-slide pages of the routing study.
- **Recall**: for book pages, up to eight four-word phrases taken from evenly
  spaced lines of the source page's own text layer (words of two letters or
  more, lines of six words or more); for the slide pages, the routing study's
  hand-copied key phrases. Both texts are compared as lower-case letters and
  digits only. The text layer misses some symbols and ligatures, so book recall
  is a floor: it compares levels, not models.
- **Levels**: 5, 10, 20, 40 and 60 calls in flight (a closed loop: each lane
  sends its next page when its call returns), 160-163 reads each, no retries,
  a level stops early past 20 % 429s after 30 answers.
- **Retry replay** (`burst`): the worker's read of a burst of pages, with the
  production policy: up to three attempts in a 120 s budget (a 429, 503 or 529
  waits Retry-After or 0.5 s doubling with jitter; any other failure, an empty
  answer or one cut at 2,000 tokens waits 0.25 s doubling; 400, 401, 403, 404
  and 422 end the read), one gate slot per attempt, ten pages at once per job,
  and a job whose read stays busy is cancelled and re-pended once after 2 s,
  when a page still busy is left unread.

## Routing facts

- `provider.order: ["DeepInfra"]` covers DeepInfra's eligible endpoints for
  the slug, but its service tiers are opt-in (by `service_tier` or the
  tier-suffixed slug), so reads go to the standard endpoint `deepinfra/fp8`
  ($0.098 in, $0.294 out per million tokens). Its flex tier is cheaper
  ($0.0784/$0.2352) and its priority tier dearer ($0.147/$0.441).
- OpenRouter puts no cap of its own on paid models: a 429 is the provider's,
  from OpenRouter's own DeepInfra capacity, which every OpenRouter customer of
  that endpoint shares. More keys or accounts add no capacity. A ramp is a
  sample of that shared pool at one time of day.
- An API key cannot show whether two keys share an account: the account
  totals (`/api/v1/credits`) need a management key, and `/api/v1/key`
  describes only the key.

## Reading the tables

- **Latency** is the client's wall time per call, connection included, for
  usable answers (a 200 with text that did not stop at the 2,000-token cap).
- **Reads a minute** are usable answers over the level's wall time, from the
  first call to the last answer, so a slow last call counts.
- **Tokens** are the provider's completion tokens; tokens a second are per
  call (completion tokens over latency) and show whether DeepInfra slows each
  stream as more run at once.
- **Spend** is the sum of OpenRouter's `usage.cost` per call.
