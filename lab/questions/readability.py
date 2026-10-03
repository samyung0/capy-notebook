"""Reading-passage difficulty against real IELTS Academic passages.

Run with wordfreq available:
  uv run --no-project --with wordfreq python lab/questions/readability.py check passage.txt
  uv run --no-project --with wordfreq python lab/questions/readability.py calibrate book.txt...

`check` prints a passage's profile and fails when it is harder than the band
below. `calibrate` profiles the READING PASSAGE sections of the private
Cambridge book texts under data/question-bank/references/ to rebuild the band.
"""

import json
import re
import statistics
import sys
from pathlib import Path

from wordfreq import zipf_frequency

# Uncommon: below Zipf 3, about once per million words ("foment" is 2.4,
# "satirical" 3.4). Proper nouns and numbers are not counted.
RARE_ZIPF = 3.0
LONG_SENTENCE = 35

# Upper edge of Cambridge IELTS 19 and 20 Academic (24 passages, 2026-10-03):
# the 75th percentile of each measure, so a passage sits among the harder real
# ones at most, never above them.
BAND = {
    "mean_sentence_words": 22.5,
    "long_sentence_share": 0.15,
    "rare_word_share": 0.025,
}
# Their medians, which a writer aims for: 19.6 words, 0.08 and 0.0225.

WORD = re.compile(r"[A-Za-z][A-Za-z'’-]*")
SENTENCE_END = re.compile(r"(?<=[.!?])[\"”’)]?\s+(?=[\"“‘(]?[A-Z0-9])")


def profile(text):
    sentences = [
        s
        for paragraph in re.split(r"\n\s*\n", text)
        for s in SENTENCE_END.split(" ".join(paragraph.split()))
        if WORD.search(s)
    ]
    lengths = [len(WORD.findall(s)) for s in sentences]
    rare = {}
    total = 0
    for sentence in sentences:
        for i, word in enumerate(WORD.findall(sentence)):
            total += 1
            # A capital after the first word is a name, not vocabulary.
            if i > 0 and word[0].isupper():
                continue
            key = re.sub(r"['’]s$", "", word.lower()).strip("'’-")
            if zipf_frequency(key, "en") < RARE_ZIPF:
                rare[key] = rare.get(key, 0) + 1
    return {
        "words": total,
        "sentences": len(sentences),
        "mean_sentence_words": round(statistics.mean(lengths), 1),
        "long_sentence_share": round(
            sum(n > LONG_SENTENCE for n in lengths) / len(lengths), 3
        ),
        "rare_word_share": round(sum(rare.values()) / total, 3),
        "rare_words": sorted(rare, key=lambda w: zipf_frequency(w, "en")),
        "long_sentences": [s for s, n in zip(sentences, lengths) if n > LONG_SENTENCE],
    }


BOILERPLATE = re.compile(
    r"^(PAGE \d+|CAMBRIDGE|Cambridge University Press.*|978-.*|\d+|©.*|https?://.*|Test \d+|"
    r"You should spend about.*|Passage \d below\.?|Reading Passage \d below\.?)\s*$"
)


def cambridge_passages(text):
    """Each READING PASSAGE section up to its first Questions heading."""
    passages = []
    for part in re.split(r"^READING PASSAGE \d\s*$", text, flags=re.MULTILINE)[1:]:
        body = re.split(r"^Questions \d", part, maxsplit=1, flags=re.MULTILINE)[0]
        lines = [
            line for line in body.splitlines() if not BOILERPLATE.match(line.strip())
        ]
        passages.append("\n".join(lines))
    return passages


def main():
    command, *paths = sys.argv[1:]
    if command == "check":
        result = profile(Path(paths[0]).read_text(encoding="utf-8"))
        over = {k: result[k] for k, limit in BAND.items() if result[k] > limit}
        print(json.dumps({**result, "band": BAND, "over": over}, indent=1))
        sys.exit(1 if over else 0)
    if command == "calibrate":
        profiles = [
            profile(p)
            for path in paths
            for p in cambridge_passages(Path(path).read_text(encoding="utf-8"))
        ]
        summary = {
            key: {
                "median": statistics.median(p[key] for p in profiles),
                "p75": statistics.quantiles([p[key] for p in profiles], n=4)[2],
                "max": max(p[key] for p in profiles),
            }
            for key in BAND
        }
        rows = [
            {k: p[k] for k in ("words", *BAND)} | {"rare_words": p["rare_words"][:12]}
            for p in profiles
        ]
        print(
            json.dumps(
                {"passages": len(profiles), "summary": summary, "each": rows}, indent=1
            )
        )
        return
    sys.exit("usage: readability.py check FILE | calibrate BOOK.txt...")


if __name__ == "__main__":
    main()
