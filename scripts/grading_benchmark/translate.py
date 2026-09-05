"""Draft local translations for Codex review; never add unreviewed drafts to the corpus."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import time

from benchmark import DATA, digest, read_results, request_json

LANGUAGES = {"es": "Spanish", "fr": "French", "ja": "Japanese", "ko": "Korean",
             "zh-Hans": "Simplified Chinese", "zh-Hant": "Traditional Chinese as used in Taiwan"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--languages", nargs="+", choices=LANGUAGES, required=True)
    parser.add_argument("--domains", nargs="+", required=True)
    parser.add_argument("--parallel", type=int, default=2)
    parser.add_argument("--url", default="http://127.0.0.1:18893")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--log-name", default="responses.jsonl")
    args = parser.parse_args()
    seed_dir = Path(__file__).with_name("seeds")
    output = DATA / "translation-drafts"
    output.mkdir(parents=True, exist_ok=True)
    jobs = []
    for language in args.languages:
        for domain in args.domains:
            rows = json.loads((seed_dir / f"{domain}.en.json").read_text(encoding="utf-8"))
            for start in range(0, len(rows), 5):
                jobs.append((language, domain, start, rows[start:start + 5]))
    if args.limit:
        jobs = jobs[:args.limit]
    raw_path = output / args.log_name
    previous = {r["key"]: r for r in read_results(raw_path, repair_tail=True) if r.get("accepted_shape")}

    def translate(job):
        language, domain, start, rows = job
        key = digest({"language": language, "domain": domain, "start": start, "rows": rows,
                      "translator": "qwen3.5-9b-q4", "prompt_version": 3})
        if key in previous:
            return previous[key], False
        system = (f"Translate every natural-language string in the supplied JSON into {LANGUAGES[language]}. "
                  "Return only a JSON array with the same rows and five strings per row. "
                  "Columns are question, required point A, required point B, correct paraphrase, deliberately incorrect answer. "
                  "Preserve their separate meanings exactly. Do not add missing information to short answers. "
                  "Do not correct the deliberately false last column. Preserve numbers, formulas, units, names, and code. "
                  "Keep the correct paraphrase a natural alternative wording rather than copying the criteria. "
                  "Use fluent school-level language and the requested writing system. "
                  "Keep mathematical expressions exactly as written, using plain text rather than adding LaTeX. "
                  "Preserve numerator/denominator order, negations, comparisons, and cause-and-effect directions. "
                  "Do not use markdown fences. No explanations outside JSON.")
        body = {"messages": [{"role": "system", "content": system},
                             {"role": "user", "content": json.dumps(rows, ensure_ascii=False)}],
                "max_tokens": 4096, "temperature": 0, "seed": 20260905,
                "chat_template_kwargs": {"enable_thinking": False}, "cache_prompt": False,
                "response_format": {"type": "json_schema", "json_schema": {"name": "translations", "strict": True,
                    "schema": {"type": "array", "minItems": len(rows), "maxItems": len(rows),
                               "items": {"type": "array", "minItems": 5, "maxItems": 5,
                                         "items": {"type": "string"}}}}}}
        began = time.perf_counter()
        record = {"key": key, "language": language, "domain": domain, "start": start,
                  "source_rows": rows, "translator": "qwen3.5-9b-q4", "review_status": "unreviewed"}
        try:
            response = request_json(args.url + "/v1/chat/completions", body, timeout=600)
            raw = response["choices"][0]["message"].get("content") or ""
            record.update(raw=raw, response=response)
            parsed = json.loads(raw[raw.find("["):raw.rfind("]") + 1])
            valid = isinstance(parsed, list) and len(parsed) == len(rows) and all(
                isinstance(row, list) and len(row) == 5 and all(isinstance(s, str) and s.strip() for s in row)
                for row in parsed)
            record.update(accepted_shape=valid, translated_rows=parsed if valid else None)
        except (OSError, ValueError, KeyError, IndexError) as error:
            record.update(accepted_shape=False, error=str(error))
        record["seconds"] = time.perf_counter() - began
        return record, True

    collected = []
    with raw_path.open("a", encoding="utf-8") as out, ThreadPoolExecutor(max_workers=args.parallel) as pool:
        for i, (record, is_new) in enumerate(pool.map(translate, jobs), 1):
            if is_new:
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                out.flush()
            collected.append(record)
            print(f"{i}/{len(jobs)} {record['domain']}/{record['language']} rows {record['start'] + 1}-{record['start'] + 5}: shape={record['accepted_shape']}", flush=True)
            language, domain = record["language"], record["domain"]
            pieces = sorted((r for r in collected if r["language"] == language and r["domain"] == domain), key=lambda r: r["start"])
            if len(pieces) != 10 or not all(r["accepted_shape"] for r in pieces):
                continue
            rows = [row for piece in pieces for row in piece["translated_rows"]]
            path = output / f"{domain}.{language}.json"
            path.write_text("[\n" + ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in rows) + "\n]\n", encoding="utf-8")
    print("Drafts remain outside the benchmark seeds until reviewed.", flush=True)


if __name__ == "__main__":
    main()
