"""Diagnostic oracle: can current search retrieve each failed turn's next hop?

Identifiers come from the labelled source chain, never an agent answer. This
does not count as agent success; it distinguishes availability from navigation.
"""

import asyncio
import json
from pathlib import Path

from run_agent import supports

from pipeline import registry
from pipeline.config import cfg
from pipeline.retrieval import search, store


async def main():
    root = Path("/lab")
    assert cfg.gateway_url == "http://127.0.0.1:8082"
    records = json.loads((root / "corpus/records.json").read_text())
    questions = {
        q["id"]: q for q in json.loads((root / "corpus/questions.json").read_text())
    }
    runs = [
        json.loads(line)
        for line in (root / "development-baseline.jsonl").read_text().splitlines()
    ]
    ws = json.loads((root / "corpus/workspaces.json").read_text())["complete"]["id"]
    registry.registry.start()
    result = []
    for r in runs:
        if r["category"] != "bridge" or r["score"]["answer_values_present"]:
            continue
        record = records[int(r["id"].split("-")[1])]
        for hop, query in [
            (1, record["accession"] + " assay"),
            (2, record["assay"] + " incubation"),
        ]:
            hits = await search.search(workspace_id=ws, query=query)
            expected = questions[r["id"]]["evidence_groups"][hop]
            found = [
                i
                for i, p in enumerate(hits, 1)
                if any(
                    supports({"file_name": p.file_name, "text": p.text}, e)
                    for e in expected
                )
            ]
            entry = {
                "question_id": r["id"],
                "hop": hop,
                "oracle_query": query,
                "expected_ranks": found,
                "hits": [
                    {
                        "file": p.file_name,
                        "index": p.chunk_idx,
                        "vec_rank": p.vec_rank,
                        "lex_rank": p.lex_rank,
                    }
                    for p in hits
                ],
            }
            result.append(entry)
            print(r["id"], query, found, flush=True)
    (root / "oracle-bridge-probes.json").write_text(json.dumps(result, indent=2))
    await store.close_pool()


if __name__ == "__main__":
    asyncio.run(main())
