"""Run the provider import queue consumer.

One process per replica claims ``import`` jobs only, so a slow Drive or
OneDrive download never occupies a parse or ingest slot.

Run: ``python -m pipeline.ingest.import_worker``
"""

from __future__ import annotations

from ..config import cfg
from . import worker


def main() -> None:
    if not cfg.gateway_url or not cfg.pipeline_secret:
        raise SystemExit("import worker needs GATEWAY_URL and PIPELINE_SECRET")
    worker.main(job_type="import")


if __name__ == "__main__":
    main()
