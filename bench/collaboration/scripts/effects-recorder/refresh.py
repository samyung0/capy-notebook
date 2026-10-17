"""Recomputes the derived fields of existing recordings after ootext.py or the
index format changes: expected.effects (text diff of the editor's exports),
and in index.json textEffects and visibleKinds.

  python refresh.py <recordings dir>
"""

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import ootext  # noqa: E402

root = pathlib.Path(sys.argv[1])
index_file = root / "index.json"
index = json.loads(index_file.read_text(encoding="utf8"))


def kinds(manifest):
    """What a correct effect list must say, by kind: text from the export diff,
    the rest (image, formatting/visual) from today's engine effects."""
    found = set()
    if manifest["expected"]["effects"]:
        found.add("text")
    engine = manifest.get("check", {}).get("engineEffects")
    if isinstance(engine, list):
        for effect in engine:
            found.add({"visual": "formatting"}.get(effect["kind"], effect["kind"]))
    return sorted(found) or ["none"]


for entry in index:
    case = root / entry["caseId"]
    manifest_file = case / "manifest.json"
    if not manifest_file.exists():
        continue
    manifest = json.loads(manifest_file.read_text(encoding="utf8"))
    baseline = (case / manifest["client"]["baselineExport"]).resolve()
    server = manifest.get("check", {}).get("serverExport")
    first = manifest["peers"][0]["peer"]
    export = case / server if isinstance(server, str) else case / manifest["client"]["exports"][first]
    effects = ootext.diff(ootext.stories(str(baseline)), ootext.stories(str(export)))
    manifest["expected"]["effects"] = effects
    manifest["expected"]["kinds"] = kinds(manifest)
    manifest_file.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    check = manifest.get("check", {})
    if "streamClean" not in check and "clients" in check:
        check["streamClean"] = (
            check["unheld"] == 0 and not check["refused"] and check["pendingStructs"] == 0 and check["pendingDeletes"] == 0
            and all(c["sameStateVectorAndDeleteSet"] and not c["rootsDiffering"] for c in check["clients"].values())
        )
        check["exportsClean"] = all(t.get("same") for t in check["textMatchesClient"].values())
        manifest_file.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf8")
    if entry["status"] == "check-failed" and check.get("streamClean"):
        entry["status"] = "ok-export-gap"
    entry["textEffects"] = len(effects)
    entry["visibleKinds"] = manifest["expected"]["kinds"]

index_file.write_text(json.dumps(index, indent=2) + "\n", encoding="utf8")
print(f"refreshed {len(index)} recordings")
