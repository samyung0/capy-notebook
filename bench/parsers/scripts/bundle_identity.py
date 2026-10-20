"""Compare two parse bundles of one document: bytes, pages and chunks.

Runs where the ``pipeline`` package imports (the pipeline image, no network):

    docker run --rm --network none -v "$PWD:/b:ro" IMAGE \\
      python /b/bundle_identity.py /b/old/bio.zip /b/new/bio.zip

Prints one JSON object: whether ``content_list.json`` is byte-identical, the
pages whose blocks differ and, for those, whether the newer bundle carries a
flattened figure (parser v17+) or a ``[formula]`` placeholder there (v18
quiet regions), and the chunk texts both bundles pack with the production
packer (``retrieval.packing.pack_blocks``): identical, only in either, and
the pages the differing chunks cover.
"""

from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from collections import Counter, defaultdict


def load(path: str) -> tuple[bytes, list[dict], dict, dict]:
    with zipfile.ZipFile(path) as archive:
        content = archive.read("content_list.json")
        refinement = json.loads(archive.read("refinement.json"))
        manifest = json.loads(archive.read("manifest.json"))
    return content, json.loads(content), refinement, manifest


def pages(blocks: list[dict]) -> dict[int, list[str]]:
    out: dict[int, list[str]] = defaultdict(list)
    for block in blocks:
        out[int(block.get("page_idx", -1))].append(json.dumps(block, sort_keys=True))
    return out


def main(old_path: str, new_path: str) -> None:
    from pipeline.retrieval.packing import pack_blocks

    old_raw, old, old_ref, old_manifest = load(old_path)
    new_raw, new, new_ref, new_manifest = load(new_path)
    old_pages, new_pages = pages(old), pages(new)
    differing = sorted(p for p in set(old_pages) | set(new_pages) if old_pages.get(p) != new_pages.get(p))
    flattened = {int(b.get("page_idx", -1)) for b in new if b.get("_source_role") == "flattened-figure"}
    formula = {int(b.get("page_idx", -1)) for b in new if "[formula]" in str(b.get("text") or "")}
    explained = [p for p in differing if p in flattened or p in formula]

    old_chunks = pack_blocks(old, frozenset(old_ref.get("furniture") or []))
    new_chunks = pack_blocks(new, frozenset(new_ref.get("furniture") or []))
    old_texts, new_texts = Counter(c.text for c in old_chunks), Counter(c.text for c in new_chunks)
    same = sum((old_texts & new_texts).values())
    changed_pages = set()
    for chunk in new_chunks:
        if new_texts[chunk.text] > old_texts.get(chunk.text, 0):
            changed_pages.update(range(chunk.page_start or 0, (chunk.page_end or chunk.page_start or 0) + 1))
    print(json.dumps({
        "old_version": old_manifest.get("parser_version"),
        "new_version": new_manifest.get("parser_version"),
        "content_identical": old_raw == new_raw,
        "content_sha256": [hashlib.sha256(old_raw).hexdigest()[:12], hashlib.sha256(new_raw).hexdigest()[:12]],
        "blocks": [len(old), len(new)],
        "furniture_identical": old_ref.get("furniture") == new_ref.get("furniture"),
        "pages_differing": len(differing),
        "pages_with_flattened_figure": len(flattened),
        "pages_with_formula_placeholder": len(formula),
        "differing_explained_by_flatten": len(explained),
        "differing_unexplained": [p for p in differing if p not in explained][:40],
        "chunks": [len(old_chunks), len(new_chunks)],
        "chunks_identical": same,
        "chunks_only_old": sum((old_texts - new_texts).values()),
        "chunks_only_new": sum((new_texts - old_texts).values()),
        "changed_chunk_pages": len(changed_pages),
        "changed_chunk_pages_flatten": len(changed_pages & (flattened | formula)),
        "changed_chunk_pages_near_flatten": len({p for p in changed_pages if {p - 1, p, p + 1} & (flattened | formula)}),
    }, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
