"""Memory of the Office picture rule on one converted file, as the import
worker's _prepare runs it, inside a container with the coordinator's limit."""
import json, sys, time
from pathlib import Path
from pipeline.config import cfg
from pipeline.ingest import decode, image_check, images

def peak():
    return int(Path("/sys/fs/cgroup/memory.peak").read_text()) >> 20

path = Path(sys.argv[1])
row = {"file": path.name, "after_imports_mib": peak()}
data = path.read_bytes()
row["bytes"] = len(data)
started = time.monotonic()
package, removed = images.compress_office(
    data,
    lambda picture: decode.office_picture(picture, image_max_bytes=2 << 20, max_pixels=cfg.image_max_pixels),
    time.monotonic() + 600,
)
stored = package if package is not None else data
image_check.check_office(stored, 2 << 20)
row.update(seconds=round(time.monotonic() - started, 1), removed=removed, rewritten=package is not None, stored_bytes=len(stored), peak_mib=peak())
print(json.dumps(row))
