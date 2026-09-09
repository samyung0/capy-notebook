"""Isolated OCR consensus and selective formula-recognition benchmarks."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.metadata
import json
import re
import time
from collections import defaultdict
from dataclasses import asdict
from difflib import SequenceMatcher
from pathlib import Path


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def consensus_words(native: str, transcriptions: list[str]) -> tuple[str, list[dict]]:
    """Require exact word agreement across independent engines and both scales."""
    if len(transcriptions) != 4:
        raise ValueError("exactly two engines at two scales are required")
    tokens = list(re.finditer(r"\w+", native))
    keys = [match[0].lower() for match in tokens]
    proposals = []
    for text in transcriptions:
        words = re.findall(r"\w+", text)
        aligned = SequenceMatcher(
            None, keys, [w.lower() for w in words], autojunk=False
        )
        proposals.append(
            {
                a: words[b]
                for tag, a, ae, b, be in aligned.get_opcodes()
                if tag == "replace" and ae - a == be - b == 1
            }
        )
    changes = []
    for index, word in proposals[0].items():
        if all(p.get(index, "").lower() == word.lower() for p in proposals[1:]):
            changes.append(
                {
                    "start": tokens[index].start(),
                    "end": tokens[index].end(),
                    "before": tokens[index][0],
                    "after": word,
                }
            )
    for change in reversed(changes):
        native = native[: change["start"]] + change["after"] + native[change["end"] :]
    return native, changes


def recover_formulas(
    blocks: list[dict], pdf: Path, records: list[dict]
) -> tuple[list[dict], list[dict]]:
    """Replay detected 144-dpi crop agreement; preserve source paragraphs."""
    import pymupdf
    from experiment_odl_ocr_disagreement import gutter, source_facts

    repaired, decisions = copy.deepcopy(blocks), []
    pairs = defaultdict(dict)
    pdf_sha256 = sha(pdf)
    for result in records:
        job = result["job"]
        if job.get("source_pdf_sha256") != pdf_sha256:
            raise ValueError("formula crops are not bound to this source PDF")
        if job.get("dpi") == 144 and job.get("padding") in {0, 3}:
            pairs[job["base_id"]][job["padding"]] = result
    with pymupdf.open(pdf) as document:
        for identity, pair in pairs.items():
            decision = {"id": identity}
            if set(pair) != {0, 3} or re.sub(r"\s+", "", pair[0]["text"]) != re.sub(
                r"\s+", "", pair[3]["text"]
            ):
                decisions.append({**decision, "status": "crop_disagreement"})
                continue
            job = pair[0]["job"]
            page = document[job["page_idx"]]
            if not source_facts(page)["eligible"] or page.rotation:
                decisions.append({**decision, "status": "source_ineligible"})
                continue
            if any(b.get("_formula_recovery_id") == identity for b in repaired):
                decisions.append({**decision, "status": "already_recovered"})
                continue
            box = pymupdf.Rect(job["bbox"])
            words = [
                w
                for w in page.get_text("words")
                if box.contains(pymupdf.Point((w[0] + w[2]) / 2, (w[1] + w[3]) / 2))
            ]
            source_text = " ".join(w[4] for w in words)
            # Existing prose is retained even if layout labels it a formula.
            if re.search(r"\b[A-Za-z]{4,}\b", source_text):
                decisions.append(
                    {
                        **decision,
                        "status": "native_prose_protected",
                        "native": source_text,
                    }
                )
                continue
            latex = pair[0]["text"].strip().strip("$")
            replacement = f"${latex}$"
            matches = []
            if source_text.strip():
                needle = r"\s*".join(
                    re.escape(c) for c in source_text if not c.isspace()
                )
                for index, block in enumerate(repaired):
                    if (
                        block.get("page_idx") == job["page_idx"]
                        and block.get("type") == "text"
                    ):
                        match = re.search(needle, block["text"])
                        if match:
                            matches.append((index, match))
                if len(matches) != 1:
                    decisions.append(
                        {
                            **decision,
                            "status": "native_alignment_ambiguous",
                            "native": source_text,
                        }
                    )
                    continue
                index, match = matches[0]
                block = repaired[index]
                if len(block.get("bbox", [])) != 4:
                    decisions.append({**decision, "status": "native_alignment_no_bbox"})
                    continue
                block["text"] = (
                    block["text"][: match.start()]
                    + replacement
                    + block["text"][match.end() :]
                )
                # Restored fractions may extend beyond the old damaged OCR box.
                prior = block["bbox"]
                block["bbox"] = [
                    min(prior[0], box.x0 / page.rect.width * 1000),
                    min(prior[1], box.y0 / page.rect.height * 1000),
                    max(prior[2], box.x1 / page.rect.width * 1000),
                    max(prior[3], box.y1 / page.rect.height * 1000),
                ]
                block["_formula_recovery_id"] = identity
                status = "replaced_source_aligned_formula"
            else:
                scaled = [
                    box.x0 / page.rect.width * 1000,
                    box.y0 / page.rect.height * 1000,
                    box.x1 / page.rect.width * 1000,
                    box.y1 / page.rect.height * 1000,
                ]
                center = (scaled[0] + scaled[2]) / 2
                cut = gutter(
                    [b for b in repaired if b.get("page_idx") == job["page_idx"]]
                )
                # Keep equation numbers and definitions after the formula in its column.
                following = [
                    index
                    for index, block in enumerate(repaired)
                    if block.get("page_idx") == job["page_idx"]
                    and block.get("type") == "text"
                    and len(block.get("bbox", [])) == 4
                    and (
                        ((block["bbox"][0] + block["bbox"][2]) / 2 < cut)
                        == (center < cut)
                        if cut is not None
                        else block["bbox"][0] <= center <= block["bbox"][2]
                    )
                    and block["bbox"][1] >= scaled[1]
                ]
                if not following:
                    decisions.append({**decision, "status": "missing_insertion_anchor"})
                    continue
                index = following[0]
                repaired.insert(
                    index,
                    {
                        "type": "text",
                        "page_idx": job["page_idx"],
                        "bbox": scaled,
                        "text": replacement,
                        "_formula_recovery_id": identity,
                    },
                )
                status = "inserted_missing_formula"
            decisions.append(
                {
                    **decision,
                    "status": status,
                    "native": source_text,
                    "latex": latex,
                    "page_idx": job["page_idx"],
                    "bbox": job["bbox"],
                }
            )
    return repaired, decisions


def prepare(args) -> None:
    import pymupdf

    args.output.mkdir(parents=True, exist_ok=False)
    checks = read(args.checks)
    assert sha(args.pdf) == checks["source_pdf_sha256"]
    blocks = read(args.native)
    jobs = []
    with pymupdf.open(args.pdf) as document:
        specs = [
            {
                "id": item["id"],
                "page_idx": item["page_idx"],
                "bbox": item["bbox"],
                "kind": "formula",
            }
            for item in checks["formulas"]
        ]
        for index in checks["prose_blocks"]:
            block = blocks[index]
            page = document[block["page_idx"]]
            box = block["bbox"]
            specs.append(
                {
                    "id": f"block-{index}",
                    "page_idx": block["page_idx"],
                    "bbox": [
                        box[0] * page.rect.width / 1000,
                        box[1] * page.rect.height / 1000,
                        box[2] * page.rect.width / 1000,
                        box[3] * page.rect.height / 1000,
                    ],
                    "kind": "prose",
                    "block_index": index,
                    "native": block["text"],
                }
            )
        for spec in specs:
            page = document[spec["page_idx"]]
            clip = (pymupdf.Rect(spec["bbox"]) + (-3, -3, 3, 3)) & page.rect
            for dpi in [144, 288]:
                identity = f"{spec['id']}-{dpi}"
                image = args.output / f"{identity}.png"
                page.get_pixmap(dpi=dpi, clip=clip).save(image)
                jobs.append(
                    {
                        **spec,
                        "id": identity,
                        "base_id": spec["id"],
                        "dpi": dpi,
                        "clip": list(clip),
                        "image": image.name,
                        "image_sha256": sha(image),
                    }
                )
    save(args.output / "jobs.json", jobs)
    save(
        args.output / "provenance.json",
        {
            "started_unix": time.time(),
            "script_sha256": sha(Path(__file__)),
            "checks_sha256": sha(args.checks),
            "pdf_sha256": sha(args.pdf),
            "native_sha256": sha(args.native),
            "oracle_formula_crops": True,
        },
    )
    print(f"Prepared {len(jobs)} source crops", flush=True)


def recognize(args) -> None:
    import numpy as np
    from PIL import Image

    args.output.mkdir(parents=True, exist_ok=False)
    jobs = [
        job
        for job in read(args.root / "jobs.json")
        if job["kind"]
        == ("formula" if args.engine in {"formula", "codeformula"} else "prose")
    ]
    started = time.perf_counter()
    model_files = []
    if args.engine == "rapid":
        from rapidocr import RapidOCR

        paths = {
            "Det": args.models / "PP-OCRv6_det_small.onnx",
            "Rec": args.models / "PP-OCRv6_rec_small.onnx",
            "Cls": args.models / "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
        }
        model_files = list(paths.values())
        reader = RapidOCR(
            params={
                **{f"{key}.model_path": str(p) for key, p in paths.items()},
                "EngineConfig.onnxruntime.intra_op_num_threads": 8,
                "EngineConfig.onnxruntime.use_cuda": False,
                "Global.text_score": 0.5,
            }
        )
    elif args.engine == "easy":
        import easyocr
        import torch

        torch.set_num_threads(8)
        reader = easyocr.Reader(
            ["en"],
            gpu=False,
            model_storage_directory=str(args.models),
            download_enabled=False,
            verbose=False,
        )
        model_files = [
            args.models / "english_g2.pth",
            args.models / "craft_mlt_25k.pth",
        ]
    elif args.engine == "formula":
        import torch
        from mineru.model.mfr.pp_formulanet_plus_m.predict_formula import (
            FormulaRecognizer,
        )

        torch.set_num_threads(8)
        reader = FormulaRecognizer(str(args.models), device="cpu")
        model_files = sorted(args.models.glob("*"))
    else:
        import torch
        from docling.datamodel.accelerator_options import AcceleratorOptions
        from docling.models.stages.code_formula.code_formula_model import (
            CodeFormulaModel,
            CodeFormulaModelOptions,
        )

        torch.set_num_threads(8)
        reader = CodeFormulaModel(
            True,
            args.models.parent,
            CodeFormulaModelOptions(do_code_enrichment=False),
            AcceleratorOptions(device="cpu", num_threads=8),
        )
        model_files = sorted(args.models.glob("*"))
    load_seconds = time.perf_counter() - started
    save(
        args.output / "run.json",
        {
            "engine": args.engine,
            "load_seconds": load_seconds,
            "script_sha256": sha(Path(__file__)),
            "jobs_sha256": sha(args.root / "jobs.json"),
            "models": {str(p): sha(p) for p in model_files if p.is_file()},
            "versions": {
                name: importlib.metadata.version(name)
                for name in (
                    {
                        "rapid": ["rapidocr", "onnxruntime"],
                        "easy": ["easyocr", "torch"],
                        "formula": ["mineru", "torch"],
                        "codeformula": ["docling", "transformers", "torch"],
                    }[args.engine]
                )
            },
        },
    )
    records = []
    for job in jobs:
        path = args.root / job["image"]
        assert sha(path) == job["image_sha256"]
        image = Image.open(path).convert("RGB")
        array = np.asarray(image)
        start = time.perf_counter()
        if args.engine == "rapid":
            output = reader(array)
            lines = (
                []
                if output.boxes is None
                else [
                    {"text": text, "score": float(score), "bbox": box.tolist()}
                    for text, score, box in zip(
                        output.txts, output.scores, output.boxes
                    )
                ]
            )
        elif args.engine == "easy":
            lines = [
                {"bbox": np.asarray(box).tolist(), "text": text, "score": float(score)}
                for box, text, score in reader.readtext(array, paragraph=False)
            ]
        elif args.engine == "formula":
            output = reader.predict(
                [
                    {
                        "label": "display_formula",
                        "bbox": [0, 0, image.width, image.height],
                    }
                ],
                array,
                batch_size=1,
            )
            lines = [{"text": item["latex"], "bbox": item["bbox"]} for item in output]
        else:
            import torch

            inputs = reader._processor(
                text=[reader._get_prompt("formula")],
                images=[image],
                return_tensors="pt",
            ).to("cpu")
            with torch.inference_mode():
                ids = reader._model.generate(
                    **inputs, max_new_tokens=256, do_sample=False, use_cache=True
                )
            outputs = reader._post_process(
                reader._processor.batch_decode(
                    ids[:, inputs.input_ids.shape[1] :], skip_special_tokens=False
                )
            )
            lines = [
                {
                    "text": outputs[0],
                    "generated_tokens": ids.shape[1] - inputs.input_ids.shape[1],
                    "limit": 256,
                }
            ]
        result = {
            "job": job,
            "seconds": time.perf_counter() - start,
            "lines": lines,
            "text": "\n".join(line["text"] for line in lines),
        }
        save(args.output / f"{job['id']}.json", result)
        records.append({"id": job["id"], "seconds": result["seconds"]})
        print(json.dumps(records[-1]), flush=True)
    save(
        args.output / "complete.json",
        {
            "load_seconds": load_seconds,
            "wall_seconds": time.perf_counter() - started,
            "inference_seconds": sum(r["seconds"] for r in records),
            "records": records,
        },
    )


def detect(args) -> None:
    import numpy as np
    import pymupdf
    import torch
    from experiment_odl_ocr_disagreement import source_facts
    from mineru.model.layout.pp_doclayoutv2 import PPDocLayoutV2LayoutModel

    args.output.mkdir(parents=True, exist_ok=False)
    torch.set_num_threads(8)
    started = time.perf_counter()
    reader = PPDocLayoutV2LayoutModel(str(args.models), device="cpu")
    load_seconds = time.perf_counter() - started
    jobs, audit, pages = [], [], []
    for source in read(args.sources):
        pdf = Path(source["pdf"])
        assert sha(pdf) == source["sha256"]
        with pymupdf.open(pdf) as document:
            for index, page in enumerate(document):
                facts = source_facts(page)
                identity = f"{source['id']}-p{index + 1}"
                audit.append({"id": identity, **facts})
                if not facts["eligible"]:
                    continue
                pix = page.get_pixmap(dpi=144)
                array = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                    pix.height, pix.width, pix.n
                )
                call = time.perf_counter()
                layout = reader.predict(array)
                seconds = time.perf_counter() - call
                save(args.output / f"{identity}-layout.json", layout)
                formulas = [b for b in layout if b["label"] == "display_formula"]
                pages.append(
                    {"id": identity, "seconds": seconds, "formulas": len(formulas)}
                )
                for position, item in enumerate(formulas):
                    for padding in [0, 3]:
                        box = pymupdf.Rect([v / 2 for v in item["bbox"]])
                        clip = (
                            box + (-padding, -padding, padding, padding)
                        ) & page.rect
                        crop_id = f"{identity}-f{position}-pad{padding}"
                        path = args.output / f"{crop_id}.png"
                        page.get_pixmap(dpi=144, clip=clip).save(path)
                        jobs.append(
                            {
                                "id": crop_id,
                                "base_id": f"{identity}-f{position}",
                                "kind": "formula",
                                "case": source["id"],
                                "source_pdf_sha256": source["sha256"],
                                "page_idx": index,
                                "bbox": list(box),
                                "clip": list(clip),
                                "padding": padding,
                                "dpi": 144,
                                "image": path.name,
                                "image_sha256": sha(path),
                                "detection": item,
                            }
                        )
                print(json.dumps(pages[-1]), flush=True)
    save(args.output / "jobs.json", jobs)
    save(args.output / "audit.json", audit)
    save(
        args.output / "complete.json",
        {
            "load_seconds": load_seconds,
            "wall_seconds": time.perf_counter() - started,
            "pages": pages,
            "jobs": len(jobs),
            "source_manifest_sha256": sha(args.sources),
            "script_sha256": sha(Path(__file__)),
            "oracle_formula_crops": False,
        },
    )


def canonical_formula(text: str) -> str:
    text = re.sub(r"\s+", "", text).strip("$.,")
    text = text.replace(r"\left", "").replace(r"\right", "")
    text = re.sub(r"(?<=\d),(?=\d{3}(?:\D|$))", "", text)
    return re.sub(r"\{([A-Za-z0-9])\}", r"\1", text)


def replay(args) -> None:
    import pymupdf
    from experiment_odl_ocr_disagreement import (
        block_text,
        fragment_match,
        normalized,
        recover_hidden_ocr_order,
        source_facts,
    )
    from structured_recovery import chunk_content_list

    args.output.mkdir(parents=True, exist_ok=False)
    original = read(args.native)
    checks = read(args.root / "frozen-checks.json")
    assert sha(args.pdf) == checks["source_pdf_sha256"]
    with pymupdf.open(args.pdf) as document:
        eligible = {
            i for i, page in enumerate(document) if source_facts(page)["eligible"]
        }
    baseline, _ = recover_hidden_ocr_order(original, eligible)
    consensus = copy.deepcopy(original)
    substitutions = []
    for index in checks["prose_blocks"]:
        texts = [
            read(args.root / f"{engine}-r1" / f"block-{index}-{dpi}.json")["text"]
            for engine in ["rapid", "easy"]
            for dpi in [144, 288]
        ]
        consensus[index]["text"], changes = consensus_words(
            original[index]["text"], texts
        )
        substitutions.append({"block": index, "changes": changes})
    consensus, _ = recover_hidden_ocr_order(consensus, eligible)
    records = [
        read(p) for p in sorted((args.root / "formula-detected").glob("nist*.json"))
    ]
    sources = {
        entry["id"]: entry["sha256"]
        for entry in read(args.root / "detection-sources.json")
    }
    for record in records:
        record["job"]["source_pdf_sha256"] = sources[record["job"]["case"]]
    candidate, decisions = recover_formulas(consensus, args.pdf, records)
    assert recover_formulas(candidate, args.pdf, records)[0] == candidate
    save(args.output / "decisions.json", decisions)
    save(args.output / "consensus.json", substitutions)
    scores = []
    for arm, blocks in [
        ("baseline", baseline),
        ("consensus", consensus),
        ("selective-mineru-formula", candidate),
    ]:
        chunks = chunk_content_list(blocks)
        save(args.output / arm / "content_list.json", blocks)
        save(
            args.output / arm / "chunks.json",
            [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks],
        )
        fragments = []
        for fragment in checks["prose_fragments"]:
            source_page = fragment["page"]
            page_index = [1, 3, 4, 5, 9].index(source_page)
            text = "\n".join(
                block_text(b) for b in blocks if b.get("page_idx") == page_index
            )
            fragments.append(
                {
                    "id": fragment["id"],
                    **fragment_match(fragment["text"], text),
                    "exact_chunk_indices": [
                        i
                        for i, c in enumerate(chunks)
                        if normalized(fragment["text"]) in normalized(c.text)
                    ],
                }
            )
        formulas = []
        for formula in checks["formulas"]:
            expected = canonical_formula(formula["latex"])
            matching = [
                i for i, c in enumerate(chunks) if expected in canonical_formula(c.text)
            ]
            formulas.append(
                {
                    "id": formula["id"],
                    "exact_complete_formula": bool(matching),
                    "chunk_indices": matching,
                }
            )
        scores.append(
            {
                "arm": arm,
                "chunks": len(chunks),
                "fragments": fragments,
                "formulas": formulas,
            }
        )
    save(
        args.output / "summary.json",
        {
            "arms": scores,
            "idempotent": True,
            "checks_sha256": sha(args.root / "frozen-checks.json"),
            "script_sha256": sha(Path(__file__)),
            "native_sha256": sha(args.native),
            "detection_manifest_sha256": sha(args.root / "detection-sources.json"),
        },
    )
    print(
        json.dumps(
            [
                {
                    "arm": s["arm"],
                    "chunks": s["chunks"],
                    "formulas": sum(f["exact_complete_formula"] for f in s["formulas"]),
                }
                for s in scores
            ]
        ),
        flush=True,
    )


def replay_full(args) -> None:
    from experiment_odl_native_tables import chunk_native_bounded
    from experiment_odl_ocr_disagreement import block_text, fragment_match, normalized

    args.output.mkdir(parents=True, exist_ok=False)
    protocol = read(args.root / "full-sweep-protocol.json")
    checks = read(args.root / "full-formula-checks.json")
    records = [
        read(p) for p in sorted((args.root / "formula-full335").glob("nist*.json"))
    ]
    summary = []
    started = time.perf_counter()
    for source in protocol["entries"]:
        pdf, native, stored_chunks = (
            Path(source[key]) for key in ["source_pdf", "content_list", "chunks"]
        )
        if (
            sha(pdf) != source["source_pdf_sha256"]
            or sha(native) != source["content_sha256"]
            or sha(stored_chunks) != source["chunks_sha256"]
        ):
            raise ValueError(f"frozen source changed: {source['id']}")
        original, stored = read(native), read(stored_chunks)
        selected = [r for r in records if r["job"]["case"] == source["id"]]
        start = time.perf_counter()
        candidate, decisions = recover_formulas(original, pdf, selected)
        seconds = time.perf_counter() - start
        assert recover_formulas(candidate, pdf, selected)[0] == candidate
        _, baseline, _ = chunk_native_bounded(original)
        _, chunks, _ = chunk_native_bounded(candidate)

        def encode(values):
            return [{**asdict(c), "indexed_text": c.indexed_text()} for c in values]

        assert encode(baseline) == stored
        encoded = encode(chunks)
        target = args.output / source["id"]
        save(target / "content_list.json", candidate)
        save(target / "chunks.json", encoded)
        save(target / "decisions.json", decisions)
        row = {
            "id": source["id"],
            "content_exact": candidate == original,
            "chunks_exact": encoded == stored,
            "baseline_chunks": len(stored),
            "candidate_chunks": len(chunks),
            "recovery_seconds": seconds,
            "source_pdf_sha256": sha(pdf),
            "content_input_sha256": sha(native),
            "decisions": decisions,
            "idempotent": True,
        }
        if source["id"] == "nist-accelerometers":
            row["formulas"] = []
            for formula in checks["formulas"]:
                expected = canonical_formula(formula["latex"])
                hits = [
                    i
                    for i, c in enumerate(chunks)
                    if c.page_start <= formula["page_idx"] + 1 <= c.page_end
                    and expected in canonical_formula(c.text).replace("&", "")
                ]
                row["formulas"].append(
                    {
                        "id": formula["id"],
                        "source_page": formula["page_idx"] + 1,
                        "exact_complete_formula": bool(hits),
                        "chunk_indices": hits,
                    }
                )
            row["prose_checks"] = []
            for fragment in read(args.root / "frozen-checks.json")["prose_fragments"]:
                page = fragment["page"] - 1
                before = "\n".join(
                    block_text(b) for b in original if b.get("page_idx") == page
                )
                after = "\n".join(
                    block_text(b) for b in candidate if b.get("page_idx") == page
                )
                row["prose_checks"].append(
                    {
                        "id": fragment["id"],
                        "before": fragment_match(fragment["text"], before),
                        "after": fragment_match(fragment["text"], after),
                        "exact_indexed_chunks": [
                            i
                            for i, c in enumerate(chunks)
                            if normalized(fragment["text"])
                            in normalized(c.indexed_text())
                        ],
                    }
                )
        summary.append(row)
        print(
            json.dumps(
                {
                    "id": source["id"],
                    "changed": candidate != original,
                    "chunks": len(chunks),
                }
            ),
            flush=True,
        )
    save(
        args.output / "summary.json",
        {
            "entries": summary,
            "replay_wall_seconds_including_chunking_io": time.perf_counter() - started,
            "script_sha256": sha(Path(__file__)),
            "full_sweep_protocol_sha256": sha(args.root / "full-sweep-protocol.json"),
            "source_checks_sha256": sha(args.root / "full-formula-checks.json"),
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="mode", required=True)
    prep = subs.add_parser("prepare")
    for name in ["pdf", "native", "checks", "output"]:
        prep.add_argument(f"--{name}", type=Path, required=True)
    rec = subs.add_parser("recognize")
    for name in ["root", "models", "output"]:
        rec.add_argument(f"--{name}", type=Path, required=True)
    rec.add_argument(
        "--engine", choices=["rapid", "easy", "formula", "codeformula"], required=True
    )
    det = subs.add_parser("detect")
    for name in ["sources", "models", "output"]:
        det.add_argument(f"--{name}", type=Path, required=True)
    rep = subs.add_parser("replay")
    for name in ["root", "pdf", "native", "output"]:
        rep.add_argument(f"--{name}", type=Path, required=True)
    full = subs.add_parser("replay-full")
    for name in ["root", "output"]:
        full.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    {
        "prepare": prepare,
        "recognize": recognize,
        "detect": detect,
        "replay": replay,
        "replay-full": replay_full,
    }[args.mode](args)


if __name__ == "__main__":
    main()
