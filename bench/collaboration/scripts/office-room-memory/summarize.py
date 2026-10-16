#!/usr/bin/env python3
"""Markdown tables from office-room-memory JSON records.

usage: summarize.py <record.json>...  (run from the repository root, where the
records' file paths resolve)
"""

import json
import re
import sys
import zipfile
from pathlib import Path


def mib(n):
    return f"{n / 1048576:.2f}"


def kib(n):
    return f"{n / 1024:.0f}"


def sizes(path):
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        xml = sum(i.file_size for i in infos if i.filename.endswith((".xml", ".rels")))
        return xml, sum(i.file_size for i in infos)


def table(record):
    name = Path(record["file"]).name
    xml, unzipped = sizes(record["file"])
    first = record["checkpoints"][0]["room"]
    out = [
        f"### {name}",
        "",
        f"File {kib(record['fileBytes'])} KiB, XML parts {kib(xml)} KiB unzipped"
        f" ({kib(unzipped)} KiB with media); seed state {kib(record['seedBytes'])} KiB"
        f" ({record['seedMs']:.0f} ms to seed); {first['structs']['live']:,} live structs at the seed.",
        "",
        "| stage | room held MiB | blocks | structs live/deleted/GC | state KiB | whole encode ms | wire KiB | log rows / KiB | stored after fold KiB | fold ms | reloaded MiB | reloaded structs live/deleted/GC |"
        + (" replica MiB |" if record["format"] == "xlsx" else ""),
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
        + (" --- |" if record["format"] == "xlsx" else ""),
    ]
    for c in record["checkpoints"]:
        room, after, fold = c["room"], c["afterFold"], c["fold"]
        s, r = room["structs"], after["structs"]
        stage = "seed" if c["edits"] == 0 else f"{c['edits']:,} edits"
        row = [
            stage,
            mib(room["heldBytes"]),
            f"{room['heldBlocks']:,}",
            f"{s['live']:,}/{s['deleted']:,}/{s['gc']:,}",
            kib(room["stateBytes"]),
            f"{room['encodeMs']:.1f}",
            kib(c["wireBytes"]),
            f"{c['logBeforeFold']['rows']} / {kib(c['logBeforeFold']['bytes'])}",
            kib(fold["storedBytes"]) if fold else "–",
            f"{fold['ms']:.0f}" if fold else "–",
            mib(after["heldBytes"]),
            f"{r['live']:,}/{r['deleted']:,}/{r['gc']:,}",
        ]
        if record["format"] == "xlsx":
            row.append(mib(c["xlsxReplica"]["replicaBytes"]))
        out.append("| " + " | ".join(row) + " |")
    last = record["checkpoints"][-1]
    out += [
        "",
        f"Saves: {last['saves']['count']}, whole-state encode median {last['saves']['encodeMsMedian']:.1f} ms,"
        f" max {last['saves']['encodeMsMax']:.1f} ms; delta row median {last['saves']['rowMsMedian']:.1f} ms;"
        f" folds during the run {len(record['inRunFolds'])}; edits took {last['editMs'] / 1000:.1f} s"
        f" ({record['attempts']:,} attempts). Drop check: counted {record['dropCheck']['countedBytes']:,} B,"
        f" freed {record['dropCheck']['freedBytes']:,} B.",
        "",
        "| edit kind | done | refused | wire B per edit | room held B per edit |",
        "| --- | --- | --- | --- | --- |",
    ]
    for kind, k in record["kinds"].items():
        done = max(k["done"], 1)
        out.append(
            f"| {kind} | {k['done']:,} | {k['refused']:,} | {k['wireBytes'] / done:,.0f} | {k['roomHeldBytes'] / done:,.0f} |"
        )
    refusals = {}
    for kind, k in record["kinds"].items():
        for message, count in k["refusals"].items():
            key = f"{kind}: {re.sub(r'[0-9]+', 'N', message)}"
            refusals[key] = refusals.get(key, 0) + count
    if refusals:
        out += ["", "Refused: " + "; ".join(f"{key} ({n})" for key, n in refusals.items()) + "."]
    if record["format"] == "xlsx":
        rep = last["xlsxReplica"]
        out += [
            "",
            f"Replica at {last['edits']:,} edits: miss {rep['missMs']:.0f} ms, hit {rep['hitMs']:.0f} ms,"
            f" held {mib(rep['replicaBytes'])} MiB (the pool's estimate {mib(rep['estimatedBytes'])} MiB).",
        ]
    return "\n".join(out)


if __name__ == "__main__":
    for path in sys.argv[1:]:
        print(table(json.loads(Path(path).read_text())))
        print()
