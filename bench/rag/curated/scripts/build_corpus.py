"""Build fictional course documents and independently recorded evidence labels.

Usage: python build_corpus.py /path/to/output
Generated source files belong on the lab VM, never in the application index.
reportlab is needed only to make the two parser fixtures.
"""

from __future__ import annotations

import hashlib
import json
import random
import sys
from pathlib import Path

SEED = 20260905
ADJECTIVES = [
    "amber-veined",
    "silver-rimmed",
    "copper-speckled",
    "ivory-striped",
    "violet-tipped",
    "crimson-dotted",
    "slate-edged",
    "golden-curled",
]
SHAPES = ["seedling", "frond", "rosette", "shoot"]
SITES = [
    "East Fen",
    "Willow Reach",
    "North Quarry",
    "Reed Basin",
    "Fern Hollow",
    "Cedar Bank",
    "West Mere",
    "Moss Terrace",
]
NAMES = [
    "Velorin",
    "Nadrex",
    "Isolene",
    "Pamiro",
    "Calvex",
    "Dorulin",
    "Esmarin",
    "Fenvate",
    "Galorin",
    "Helvex",
    "Istrane",
    "Jomarin",
]


def build(root: Path) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import (
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    source = root / "sources"
    source.mkdir(parents=True, exist_ok=True)
    rng = random.Random(SEED)
    accessions = rng.sample(range(110, 990), 32)
    assays = rng.sample(range(110, 990), 32)
    temps = rng.sample(range(14, 78), 32)
    waits = rng.sample(range(19, 150), 32)
    batches = rng.sample(range(110, 990), 32)
    records = []
    for i in range(32):
        records.append(
            {
                "i": i,
                "description": f"{ADJECTIVES[i % 8]} {SHAPES[i // 8]}",
                "site": SITES[(i * 3) % 8],
                "accession": f"CT-{accessions[i]}",
                "assay": f"AX-{assays[i]}",
                "temp": temps[i],
                "wait": waits[i],
                "reagent": NAMES[i % len(NAMES)],
                "batch": f"BX-{batches[i]}",
                "reading": round(1.13 + i * 0.17, 2),
                "quantity": 11 + i * 3,
            }
        )

    docs: dict[str, list[str]] = {}

    def add(filename: str, text: str) -> None:
        docs.setdefault(filename, []).append(text)

    intro = (
        "This is a fictional field-methods course, Riverton Autumn 2026. "
        "The names, identifiers and measurements are invented for a teaching exercise. "
        "Values describe this exercise only. Documents cover different stages of the work; "
        "an observation, an accession, and an assay are different identifiers."
    )
    for i, r in enumerate(records):
        field = f"field-notes-{i // 8 + 1}.md"
        register = f"accession-register-{i % 2 + 1}.md"
        protocol = f"assay-manual-{i % 4 + 1}.md"
        fquote = (
            f"The {r['description']} at {r['site']} was catalogued as {r['accession']}."
        )
        rquote = f"Accession {r['accession']} is assigned to assay {r['assay']}."
        pquote = f"Assay {r['assay']} uses {r['reagent']} at {r['temp']} degrees Celsius for {r['wait']} minutes."
        r.update(
            field=field,
            register=register,
            protocol=protocol,
            fquote=fquote,
            rquote=rquote,
            pquote=pquote,
        )
        add(
            field,
            f"## Observation {i + 1}: {r['site']}\n\n{fquote}\n\n"
            "The notebook description is a visual label, not a taxonomic diagnosis. "
            "The team inspected both leaf surfaces and photographed the sample beside a scale. "
            "They recorded the nearest path before taking the specimen to the field station. "
            "Sampling happened after the morning dew had dispersed. The color remained visible "
            "when the specimen was moved into shade, so the observer ruled out glare as the source "
            "of the appearance. Soil crumbs were retained separately from the visible tissue. "
            "A second observer checked that the accession on the envelope agreed with the notebook. "
            "The envelope contains the station copy of the observation. It does not contain an assay "
            "instruction, and the collecting team did not choose reagents in the field. Laboratory "
            "assignment happens when the accession is entered in the teaching collection register. "
            "The observation remains valid if a later methods class changes a measurement procedure. "
            "Students should keep these observations separate from conclusions about mechanisms.",
        )
        add(
            register,
            f"## {r['accession']}\n\n{rquote}\n\n"
            "This assignment was made by the course curator after the specimen envelope was checked. "
            "The register is a cross-reference between the teaching collection and the methods bench. "
            "It records assignment rather than the result of the assay. The accession stays with the "
            "physical sample, while the assay identifier selects a procedure. Repeated measurements "
            "of this accession retain the same assignment unless a dated curator correction says "
            "otherwise. The register does not prescribe a temperature or an incubation time. "
            "Those details are stated in the current assay manual. Students copying records should "
            "preserve every character of an identifier, including the prefix and the three digits.",
        )
        add(
            protocol,
            f"## Procedure {r['assay']}\n\n{pquote}\n\n"
            "Prepare the teaching reagent in a clean labelled vessel and check the timer before "
            "starting. The duration begins when the vessel has reached the specified temperature. "
            "Record the instrument reading only after the incubation has finished. A clear starting "
            "point matters because time spent warming the vessel would otherwise become an unrecorded "
            "part of the measurement. Use an unused vessel for the blank and take its reading during "
            "the same session. If a vessel is disturbed, describe that observation in the notebook "
            "rather than silently treating it as an ordinary replicate. The course uses these "
            "procedures to teach traceability, not to classify specimens from their color alone. "
            "The instrument response is a course-specific scale. Comparing two responses is valid "
            "only when the blank, timing convention and reporting units are the same. The assay code "
            "identifies the procedure even when different field groups use different visual names.",
        )
        add(
            "shipping-register.md",
            f"## Dispatch {r['accession']}\n\n"
            f"The shipping label for {r['accession']} is {r['batch']}. "
            f"This dispatch contains {r['quantity']} sealed packets. "
            "Dispatch labels track envelopes between classrooms. They are independent of the assay "
            "assignment and do not encode an incubation setting. A packet count is a count of sealed "
            "envelopes, not a count of tissue fragments or successful instrument readings. "
            "The receiving assistant records the label before opening the outer transport bag. "
            "An unreadable label is recorded as a handling exception and is checked against the "
            "sending class notebook. Counts from separate dispatches must not be pooled as replicates.",
        )
        # Same assay name, plausible wrong answer, explicit historical scope.
        add(
            "archive-autumn-2024.md",
            f"## Historical procedure {r['assay']}\n\n"
            f"In the retired Autumn 2024 handout, assay {r['assay']} ran at "
            f"{r['temp'] + 11} degrees Celsius for {r['wait'] + 17} minutes. "
            "This historical handout is retained for comparison with current teaching practice. "
            "It was withdrawn before the Autumn 2026 course. Do not treat a historical parameter as "
            "a current recommendation. The retired procedure used a different timer convention and "
            "instrument response scale. A measurement from that archive cannot be merged with a "
            "current observation without accounting for the changed procedure. This handout contains "
            "no accession-to-assay assignments for the current collection.",
        )

    add(
        "course-brief.md",
        "# Riverton field methods\n\n" + intro + "\n\n"
        "The current course is Autumn 2026. Use the current assay manuals for incubation settings. "
        "The archive labelled Autumn 2024 is useful for historical comparisons only. Field notes "
        "describe specimens. The accession registers assign procedures. Shipping and instrument "
        "registers track separate activities. A field observation is not enough to select a procedure "
        "when its accession-to-assay assignment is missing. Do not infer missing assignments from "
        "the order of entries, the numeric part of a label, color, or similarity between samples. "
        "The teaching labels were assigned independently of these properties.\n\n"
        "Two specimens may have similar visual descriptions and different assignments. Students "
        "must preserve the identifying detail supplied in a question. If a question leaves out that "
        "detail, report the ambiguity. The calibration sheet reports measurements in arbitrary "
        "instrument units. The demonstration board reports display settings, which are not "
        "incubation temperatures. None of the documents provides DNA sequences or living species "
        "identifications for the invented collection.",
    )

    # Topic-rich distractors have identifiers, numbers, and overlap with natural questions.
    for k in range(4):
        for i in range(24):
            n = k * 24 + i
            add(
                f"seminar-notes-{k + 1}.md",
                f"## Seminar exercise {n + 1}\n\n"
                f"Group {n + 1} discussed incubation temperature, waiting time, accession labels, "
                "reagent selection, and the difference between a specimen and a procedure. "
                f"Their hypothetical practice timer was set to {23 + n} minutes and their display "
                f"board showed {18 + n % 35} degrees Celsius. These are classroom demonstration "
                "settings. They are not settings for any accession in the field collection. "
                "The group first reconstructed a chain of custody from the observation book to "
                "the teaching collection and then to an instrument. Several students initially "
                "copied a number from a nearby example because it looked plausible. Comparing the "
                "labels showed why that shortcut was invalid: quantities belonging to different "
                "activities can use the same unit without measuring the same thing. A timer setting "
                "for a display exercise is not an incubation instruction. A shipping count is not "
                "a count of successful trials. The seminar ended by comparing direct observation "
                "with interpretation and asking which claims could be checked against a source. "
                "Students were encouraged to explain missing information rather than invent a "
                "numerical answer. The worksheet itself contains no procedure assignments.",
            )

    translations = [
        (0, "琥珀色叶脉的幼苗", "zh"),
        (9, "銀色の縁を持つ葉", "ja"),
        (18, "rosette mouchetée de cuivre", "fr"),
        (27, "brote con rayas marfil", "es"),
    ]
    for index, alias, lang in translations:
        r = records[index]
        quote = f"{alias} = {r['description']} at {r['site']}."
        add(
            f"field-glossary-{lang}.md",
            f"# Field vocabulary {lang}\n\n{quote}\n\n"
            "This bilingual vocabulary card identifies the visual description used by a visiting "
            "class. The translation does not change the specimen's accession. Use the field notes "
            "to locate the accession, then the current collection register to locate its procedure. "
            "This card contains vocabulary only and gives no laboratory settings.",
        )
        r.update(alias=alias, glossary=f"field-glossary-{lang}.md", gquote=quote)

    for name, sections in docs.items():
        title = (
            ""
            if name == "course-brief.md"
            else f"# {name.removesuffix('.md').replace('-', ' ').title()}\n\n{intro}\n\n"
        )
        (source / name).write_text(
            title + "\n\n".join(sections) + "\n", encoding="utf-8"
        )

    # Keep simple tables on two PDF pages so parser column association is testable.
    styles = getSampleStyleSheet()
    for half in range(2):
        path = source / f"instrument-log-{half + 1}.pdf"
        story = [
            Paragraph(f"Riverton instrument log {half + 1}", styles["Title"]),
            Paragraph(
                "Autumn 2026. Fictional teaching measurements. Values are arbitrary instrument units, not temperatures or packet counts.",
                styles["BodyText"],
            ),
            Spacer(1, 18),
        ]
        data = [["Assay", "Response units", "Calibration tag"]]
        for r in records[half * 16 : (half + 1) * 16]:
            data.append([r["assay"], f"{r['reading']:.2f}", f"CAL-{r['i'] + 201}"])
        table = Table(data, colWidths=[130, 155, 140], repeatRows=1)
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#143b39")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("FONTSIZE", (0, 0), (-1, -1), 11),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
                    ("TOPPADDING", (0, 0), (-1, -1), 10),
                    ("GRID", (0, 0), (-1, -1), 0.3, colors.grey),
                ]
            )
        )
        story.extend(
            [
                table,
                Spacer(1, 18),
                Paragraph(
                    "The calibration tag identifies the instrument check associated with that row. Read each response with the assay in the same row. Assays from other rows are separate measurements.",
                    styles["BodyText"],
                ),
            ]
        )
        SimpleDocTemplate(str(path), pagesize=A4, topMargin=38, bottomMargin=38).build(
            story
        )

    def evidence(r: dict, hop: str) -> dict:
        return {
            "file": r[
                {"f": "field", "r": "register", "p": "protocol", "g": "glossary"}[hop]
            ],
            "quote": r[hop + "quote"],
        }

    questions = []

    def question(
        qid: str,
        category: str,
        q: str,
        answer: str,
        groups: list,
        patterns: list,
        split: str = "development",
        workspace: str = "complete",
    ) -> None:
        questions.append(
            {
                "id": qid,
                "category": category,
                "split": split,
                "workspace": workspace,
                "q": q + " Answer concisely and cite the evidence.",
                "answer": answer,
                "evidence_groups": groups,
                "answer_patterns": patterns,
            }
        )

    for i in range(16):
        r = records[i]
        question(
            f"bridge-{i:02d}",
            "bridge",
            f"For the current course, what incubation temperature and waiting time apply to the {r['description']} collected at {r['site']}?",
            f"{r['temp']} degrees Celsius for {r['wait']} minutes, via {r['accession']} and {r['assay']}.",
            [[evidence(r, h)] for h in "frp"],
            [str(r["temp"]), str(r["wait"])],
            "holdout" if i >= 12 else "development",
        )
    for i in range(16, 24):
        r = records[i]
        question(
            f"lookup-{i}",
            "lookup",
            f"What reagent and incubation settings does the current {r['assay']} procedure use?",
            r["pquote"],
            [[evidence(r, "p")]],
            [r["reagent"], str(r["temp"]), str(r["wait"])],
            "holdout" if i >= 22 else "development",
        )
    for a, b in [(0, 5), (7, 11), (16, 20), (24, 31)]:
        x, y = records[a], records[b]
        question(
            f"compare-{a:02d}",
            "comparison",
            f"Which needs longer incubation in the current course: the {x['description']} at {x['site']} or the {y['description']} at {y['site']}? Give both times.",
            f"{x['description']}: {x['wait']} minutes; {y['description']}: {y['wait']} minutes.",
            [[evidence(r, h)] for r in [x, y] for h in "frp"],
            [str(x["wait"]), str(y["wait"])],
            "holdout" if a == 24 else "development",
        )
    for i, alias, lang in translations:
        r = records[i]
        prompts = {
            "zh": f"当前课程中，{alias}需要在多少摄氏度下孵育多长时间？",
            "ja": f"現在の授業では、{alias}を何度で何分間インキュベートしますか？",
            "fr": f"Pour le cours actuel, à quelle température et pendant combien de temps faut-il incuber la {alias} ?",
            "es": f"En el curso actual, ¿a qué temperatura y durante cuánto tiempo se incuba el {alias}?",
        }
        question(
            "crosslang-" + lang,
            "cross_language",
            prompts[lang],
            r["pquote"],
            [[evidence(r, h)] for h in "gfrp"],
            [str(r["temp"]), str(r["wait"])],
            "holdout" if lang == "es" else "development",
        )
    for i in [3, 10, 21, 29]:
        r = records[i]
        question(
            f"table-{i:02d}",
            "table",
            f"What response reading and calibration tag were recorded for the assay assigned to the {r['description']} at {r['site']}?",
            f"{r['reading']:.2f} units; CAL-{i + 201}.",
            [[evidence(r, h)] for h in "fr"]
            + [
                [
                    {
                        "file": f"instrument-log-{i // 16 + 1}.pdf",
                        "contains": [
                            r["assay"],
                            f"{r['reading']:.2f}",
                            f"CAL-{i + 201}",
                        ],
                    }
                ]
            ],
            [f"{r['reading']:.2f}", f"CAL-{i + 201}"],
            "holdout" if i == 29 else "development",
        )
    for i in [2, 13, 23, 30]:
        r = records[i]
        historical = f"In the retired Autumn 2024 handout, assay {r['assay']} ran at {r['temp'] + 11} degrees Celsius for {r['wait'] + 17} minutes."
        question(
            f"version-{i:02d}",
            "version",
            f"For {r['assay']}, how did the incubation temperature change between Autumn 2024 and the current course?",
            f"From {r['temp'] + 11} to {r['temp']} degrees Celsius.",
            [
                [{"file": "archive-autumn-2024.md", "quote": historical}],
                [evidence(r, "p")],
            ],
            [str(r["temp"] + 11), str(r["temp"])],
            "holdout" if i == 30 else "development",
        )
    for i in [0, 5, 12, 15]:
        r = records[i]
        question(
            f"missing-{i:02d}",
            "missing_bridge",
            f"For the current course, what incubation temperature and waiting time apply to the {r['description']} collected at {r['site']}?",
            f"Cannot determine: the accession {r['accession']} has no assay assignment in the supplied documents.",
            [[evidence(r, "f")]],
            [],
            "holdout" if i >= 12 else "development",
            "missing_bridge",
        )
    for i, prompt in enumerate(
        [
            "What DNA sequence was measured for the amber-veined seedling?",
            "What was the measured pH of the solvent used for AX-104?",
            "Which living species does accession CT-103 belong to?",
            "What is the official correction to the current AX-102 waiting time?",
        ]
    ):
        question(
            f"absent-{i}",
            "unanswerable",
            prompt,
            "The supplied documents do not establish an answer.",
            [],
            [],
            "holdout" if i == 3 else "development",
        )
    assert len(questions) == 48
    assert len({r["assay"] for r in records}) == 32
    assert all(r["assay"] not in q["q"] for r, q in zip(records[:16], questions[:16]))
    # All quotation labels must refer to literal source text before ingestion.
    for q in questions:
        for group in q["evidence_groups"]:
            for e in group:
                assert (source / e["file"]).exists()
                if "quote" in e:
                    assert e["quote"] in (source / e["file"]).read_text()
    manifest = {
        "seed": SEED,
        "nature": "entirely fictional controlled course corpus",
        "sources": [
            {
                "file": p.name,
                "bytes": p.stat().st_size,
                "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
            }
            for p in sorted(source.iterdir())
        ],
        "omitted_from_missing_bridge": [
            "accession-register-1.md",
            "accession-register-2.md",
        ],
    }
    (root / "questions.json").write_text(
        json.dumps(questions, ensure_ascii=False, indent=2) + "\n"
    )
    (root / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    (root / "records.json").write_text(
        json.dumps(records, ensure_ascii=False, indent=2) + "\n"
    )
    print(
        f"Built {len(manifest['sources'])} documents and {len(questions)} questions at {root}"
    )


if __name__ == "__main__":
    build(Path(sys.argv[1]))
