"""Build source-grounded chat cases before observing either model condition."""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

from fetch_data import digest, stable_key, write_json

# Curated for answerable, stable source text before any retrieval/agent run.
# Retrieval's 40 questions per language retain the original unfiltered qrels.
NATIVE = [
    (
        "en",
        "2839",
        "A microscopic organism; single-celled or a colony.",
        {"24078038#0": "microscopic", "20377#0": "microscopic organism"},
    ),
    (
        "en",
        "600",
        "1517, with Martin Luther's Ninety-five Theses.",
        {"3460247#23": "1517", "18785835#4": "1517", "6488945#5": "31 October 1517"},
    ),
    (
        "de",
        "1147888#0",
        "United States, mainly Wyoming; also Montana and Idaho.",
        {"67990#0": "Bundesstaat Wyoming", "67990#12": "US-Bundesstaat Wyoming"},
    ),
    (
        "de",
        "3163303#0",
        "Sacramento.",
        {
            "3810822#0": "Hauptstadt des Staates ist Sacramento",
            "132366#0": "Hauptstadt des US-Bundesstaates Kalifornien",
            "335455#0": "Sacramento, die Hauptstadt Kaliforniens",
            "256716#0": "Sacramento, die Hauptstadt Kaliforniens",
        },
    ),
    (
        "es",
        "7684628#0",
        "The festival of lights and the Hindu new year; lights, sweets and celebrations.",
        {"8168#0": "festival de las luces", "8168#1": "entrada del año nuevo hindú"},
    ),
    (
        "es",
        "313181#0",
        "A late dinner and light lunch left a long gap; aristocrats took tea and a snack around five, and the custom spread.",
        {"555146#4": "esto dejaba muchas horas entre algunas comidas"},
    ),
    (
        "fr",
        "6556824#0",
        "Strategic routes and navigable Orontes; Seleucid capital and center of Hellenistic culture.",
        {
            "40949#5": "capitale du royaume séleucide",
            "40964#8": "capitale du royaume séleucide",
        },
    ),
    (
        "fr",
        "11892575#0",
        "A stellar explosion with a brief enormous rise in brightness, associated with a star's end of life.",
        {
            "17381#0": "gigantesque explosion",
            "17381#3": "supernova thermonucléaire",
            "505395#10": "explosions d’étoiles",
            "9835672#11": "explosion cataclysmique d'une étoile",
        },
    ),
    (
        "ja",
        "2529",
        "Around the second century CE. A precise year is not given in the supplied source.",
        {
            "2603321#5": "2世紀ころ漢の支配を脱して独立したチャム人によって建国されたチャンパ王国"
        },
    ),
    (
        "ja",
        "4278",
        "1937. The supplied source does not give month/day.",
        {"3424657#0": "1937年"},
    ),
    (
        "ko",
        "1078",
        "Yes. One ampere is one coulomb per second, symbol A.",
        {
            "819#1": "1 초 당 1 쿨롱",
            "819#3": "1 초에 1 쿨롱",
            "809#9": "1초 동안 1쿨롱",
        },
    ),
    (
        "ko",
        "755",
        "Sofia.",
        {
            "19801#0": "불가리아의 수도",
            "1794854#0": "불가리아의 수도인 소피아",
            "9445#0": "수도는 소피아",
            "9445#3": "수도는 소피아",
            "747914#0": "소피아(불가리아의 수도)",
            "747555#0": "소피아(불가리아의 수도)",
            "982681#0": "소피아(불가리아의 수도)",
            "747109#0": "소피아(불가리아의 수도)",
            "746535#0": "소피아(불가리아의 수도)",
            "747579#0": "소피아(불가리아의 수도)",
        },
    ),
    (
        "zh",
        "674078#0",
        "1878, originally Newton Heath; renamed Manchester United in 1902.",
        {"115813#2": "1878", "175429#2": "1878", "175429#1": "1878"},
    ),
    (
        "zh",
        "509765#0",
        "DNA and proteins, especially histones. Structural descriptions of chromatids and centromere are also source-supported.",
        {
            "104392#1": "去氧核糖核酸和5种被称为组蛋白的蛋白质",
            "104392#6": "去氧核糖核酸-组蛋白",
        },
    ),
]
PAIRS = [
    ("en", "de"),
    ("en", "es"),
    ("en", "zh"),
    ("de", "en"),
    ("es", "en"),
    ("zh", "en"),
    ("de", "es"),
    ("zh", "de"),
]


def main(root):
    corpus = root / "corpus"
    (corpus / "sources").mkdir(parents=True, exist_ok=True)
    sources, uploads, questions = {}, {}, []
    miracl = json.loads((root / "miracl.json").read_text())["datasets"]

    def source(title, text, provenance):
        identity = hashlib.sha256((title + "\n" + text).encode()).hexdigest()[:12]
        filename = "source-" + identity + ".md"
        payload = ("# " + title + "\n\n" + text + "\n").encode()
        (corpus / "sources" / filename).write_bytes(payload)
        sources[filename] = {
            "title": title,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "provenance": provenance,
        }
        return filename

    def question(qid, category, language, workspace, query, answer, groups, **extra):
        questions.append(
            {
                "id": qid,
                "category": category,
                "language": language,
                "workspace": workspace,
                "q": query,
                "answer": answer,
                "evidence_groups": groups,
                "answer_patterns": [],
                "split": "holdout",
                **extra,
            }
        )

    for language, qid, answer, anchors in NATIVE:
        dataset = miracl["miracl-" + language]
        q = next(q for q in dataset["questions"] if q["id"] == qid)
        group = []
        for docid, quote in anchors.items():
            doc = dataset["documents"][docid]
            assert q["qrels"][docid] > 0 and quote in doc["text"], (
                language,
                qid,
                docid,
            )
            group.append(
                {"file": doc["title"] + ".md", "quote": quote, "source_docid": docid}
            )
        question(
            "native-" + language + "-" + qid,
            "native",
            language,
            "miracl-" + language,
            q["q"],
            answer,
            [group],
            source="miracl",
            source_id=qid,
            source_language=language,
        )

    hotpot = sorted(
        json.loads((root / "hotpot.json").read_text()),
        key=lambda r: stable_key("hotpot:" + r["_id"]),
    )[:8]
    hotpot_files = {}
    for row in hotpot:
        files = {
            title: source(
                title,
                "".join(sentences),
                {"dataset": "hotpotqa", "id": row["_id"], "title": title},
            )
            for title, sentences in row["context"]
        }
        hotpot_files[row["_id"]] = files
        groups = []
        for title, sentences in row["context"]:
            facts = [
                sentences[i].strip() for t, i in row["supporting_facts"] if t == title
            ]
            if facts:
                groups.append([{"file": files[title], "contains": facts}])
        assert len(groups) == 2
        answer = row["answer"]
        if row["_id"] == "5a8c2bb4554299240d9c20ac":
            answer = "Aligarh Muslim University, described in the source as a central university of India. The dataset's generic gold answer is not the institution's name."
        question(
            "hotpot-" + row["_id"],
            "multihop",
            "en",
            "hotpot",
            row["question"],
            answer,
            groups,
            source="hotpotqa",
            source_id=row["_id"],
            source_language="en",
            original_gold=row["answer"],
            subtype=row["type"],
        )
        uploads.setdefault("hotpot", set()).update(files.values())

    with zipfile.ZipFile(root / "raw/MLQA_V1.zip") as archive:
        for number, (context_lang, question_lang) in enumerate(PAIRS):
            name = f"MLQA_V1/test/test-context-{context_lang}-question-{question_lang}.json"
            data = json.loads(archive.read(name))["data"]
            flat = [
                {**q, "title": d["title"], "context": p["context"]}
                for d in data
                for p in d["paragraphs"]
                for q in p["qas"]
            ]
            rows = sorted(
                flat,
                key=lambda r: stable_key(
                    f"mlqa:{context_lang}:{question_lang}:" + r["id"]
                ),
            )
            row = rows[0]
            assert all(
                row["context"][a["answer_start"] : a["answer_start"] + len(a["text"])]
                == a["text"]
                for a in row["answers"]
            )
            # The original task provides the paragraph. Add only its title so a
            # context-dependent question remains identifiable in a notebook.
            query = "[" + row["title"] + "] " + row["question"]
            filename = source(
                row["title"],
                row["context"],
                {"dataset": "mlqa", "id": row["id"], "context_language": context_lang},
            )
            workspace = "mlqa-" + str(number)
            uploads[workspace] = {filename}
            peers = [
                r
                for r in rows
                if r["title"] == row["title"] and r["context"] != row["context"]
            ]
            randoms = [r for r in rows if r["title"] != row["title"]]
            seen = {row["context"]}
            for pool, limit in ((peers, 3), (randoms, 2)):
                added = 0
                for candidate in pool:
                    if candidate["context"] in seen:
                        continue
                    seen.add(candidate["context"])
                    uploads[workspace].add(
                        source(
                            candidate["title"],
                            candidate["context"],
                            {
                                "dataset": "mlqa",
                                "id": candidate["id"],
                                "context_language": context_lang,
                            },
                        )
                    )
                    added += 1
                    if added == limit:
                        break
            question(
                "cross-" + str(number),
                "cross_language",
                question_lang,
                workspace,
                query,
                " / ".join(a["text"] for a in row["answers"]),
                [[{"file": filename, "quote": a["text"]} for a in row["answers"]]],
                source="mlqa",
                source_id=row["id"],
                source_language=context_lang,
                original_question=row["question"],
            )

    # Remove a necessary document, retaining realistic neighboring sources.
    missing = [
        ("hotpot-" + hotpot[0]["_id"], hotpot_files[hotpot[0]["_id"]]["Dealey Plaza"]),
        (
            "hotpot-" + hotpot[6]["_id"],
            hotpot_files[hotpot[6]["_id"]]["Jekyll &amp; Hyde (musical)"],
        ),
    ]
    missing += [("cross-" + str(i), None) for i in (0, 2, 4, 7)]
    for number, (base_id, omitted) in enumerate(missing):
        base = next(q for q in questions if q["id"] == base_id)
        omitted = omitted or base["evidence_groups"][0][0]["file"]
        workspace = "missing-" + str(number)
        if base["source"] == "hotpotqa":
            complete = set(hotpot_files[base["source_id"]].values())
        else:
            complete = uploads[base["workspace"]]
        uploads[workspace] = complete - {omitted}
        assert omitted not in uploads[workspace] and uploads[workspace]
        question(
            workspace,
            "missing_source",
            base["language"],
            workspace,
            base["q"],
            "The provided sources do not establish the answer. Acknowledge insufficient evidence; do not present outside knowledge as sourced.",
            [],
            source=base["source"],
            source_id=base["source_id"],
            source_language=base["source_language"],
            paired_case=base_id,
            omitted_file=omitted,
            complete_answer=base["answer"],
        )

    assert len(questions) == 36 and len({q["id"] for q in questions}) == 36
    write_json(corpus / "questions.json", questions)
    write_json(
        corpus / "manifest.json",
        {
            "sources": sources,
            "upload_workspaces": {k: sorted(v) for k, v in uploads.items()},
            "native_workspace_mode": "reuse separately indexed MIRACL pools",
            "selection": "native cases selected by source answerability before model calls; MLQA and Hotpot selected by fixed SHA order",
            "source_sha256": {
                n: digest(root / n)
                for n in ("miracl.json", "hotpot.json", "raw/MLQA_V1.zip")
            },
        },
    )
    print(
        len(questions),
        "questions",
        len(sources),
        "unique uploaded sources",
        sum(map(len, uploads.values())),
        "logical uploads",
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    main(parser.parse_args().root)
