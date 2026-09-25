"""Probe: does models.caption_image reach a provider without job pins (chat path)?

No network: we patch elitellm.complete to record any call and fail the probe.
"""

import asyncio
import sys

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")

from pipeline import registry
from pipeline.retrieval import models

called = []


async def fake_complete(*args, **kwargs):  # would be the paid provider call
    called.append((args, kwargs))
    raise AssertionError("provider was reached")


models.elitellm.complete = fake_complete


async def main():
    assert registry.current_job_pins() is None
    try:
        await models.caption_image(
            "data:image/png;base64,AAAA", "prompt", best_effort=False
        )
    except registry.RegistryError as exc:
        print("RegistryError before any provider call:", exc)
    except Exception as exc:  # noqa: BLE001
        print("other error:", type(exc).__name__, exc)
    print("provider calls:", len(called))


asyncio.run(main())
