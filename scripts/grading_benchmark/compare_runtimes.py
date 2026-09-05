"""Compare complete native and browser runs on identical case hashes."""

import argparse
import hashlib
import json
from pathlib import Path

from analyse import describe, load_complete, paired, primary
from benchmark import read_cases


def compare(native_cases, browser_cases, native_runs, browser_runs):
    native_cases = {case["id"]: case for case in native_cases}
    for case in browser_cases:
        original = native_cases.get(case["id"])
        if original is None or original["case_sha256"] != case["case_sha256"]:
            raise ValueError(f"Browser case is not an identical native case: {case['id']}")
    if native_runs.keys() != browser_runs.keys():
        raise ValueError("Both runtimes must contain the same requested models")
    output = {"method": "Browser minus native accuracy on identical case IDs and hashes. "
              "Primary excludes reference anchors and pre-identified ambiguous labels. "
              "Paired source-family bootstrap: 1,000 draws, seed 20260905; exploratory intervals. "
              "Explicit decoding settings and recorded original model hashes must match; "
              "the complete prompt source, including system instructions, must have the same hash. "
              "batching, runtime versions and unspecified sampling defaults may differ. "
              "Native concurrent request times are not isolated interactive latency.", "models": {}}
    for model in native_runs:
        native = [native_runs[model][case["id"]] for case in browser_cases]
        browser = [browser_runs[model][case["id"]] for case in browser_cases]
        native_config, browser_config = native[0]["config"], browser[0]["config"]
        if (not native_config["runtime"].startswith("llama.cpp-")
                or not browser_config["runtime"].startswith("wllama-")):
            raise ValueError(f"Unexpected native/browser runtime for {model}")
        controls = lambda config: {key: value for key, value in config["settings"].items() if key != "parallel"}
        if controls(native_config) != controls(browser_config):
            raise ValueError(f"Explicit decoding settings differ for {model}")
        if native_config["model_source"]["sha256"] != browser_config["model_source"]["sha256"]:
            raise ValueError(f"Recorded original model hashes differ for {model}")
        if (not native_config.get("prompt_sha256")
                or native_config["prompt_sha256"] != browser_config.get("prompt_sha256")):
            raise ValueError(f"Prompt-source hashes differ or are missing for {model}")
        entry = {"native_config": native_config, "browser_config": browser_config,
                 "native_batch": native[0]["batch"], "browser_batch": browser[0]["batch"],
                 "native_complete_cases": len(native_runs[model]), "shared_cases": len(browser), "groups": {}}
        selectors = {"all": lambda row: True, "primary": primary}
        selectors.update({f"primary_language/{language}": lambda row, language=language: primary(row) and row["language"] == language
                          for language in sorted({row["language"] for row in browser})})
        selectors.update({f"primary_domain/{domain}": lambda row, domain=domain: primary(row) and row["domain"] == domain
                          for domain in sorted({row["domain"] for row in browser})})
        for name, select in selectors.items():
            left, right = [row for row in browser if select(row)], [row for row in native if select(row)]
            entry["groups"][name] = {"browser": describe(left), "native": describe(right),
                                     "browser_minus_native": paired(left, right, lambda row: row["case_id"])}
        output["models"][model] = entry
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-dataset", type=Path, required=True)
    parser.add_argument("--browser-dataset", type=Path, required=True)
    parser.add_argument("--native-input", type=Path, required=True)
    parser.add_argument("--browser-input", type=Path, required=True)
    parser.add_argument("--models", nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    native_cases, browser_cases = read_cases(args.native_dataset), read_cases(args.browser_dataset)
    output = compare(native_cases, browser_cases,
                     load_complete([args.native_input], native_cases, args.models),
                     load_complete([args.browser_input], browser_cases, args.models))
    output["inputs"] = {}
    for path in (args.native_dataset, args.browser_dataset, args.native_input, args.browser_input, Path(__file__)):
        with path.open("rb") as source:
            sha = hashlib.file_digest(source, "sha256").hexdigest()
        output["inputs"][str(path)] = sha
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {args.output}")


if __name__ == "__main__":
    main()
