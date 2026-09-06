"""Complete only uncached Perplexity batches after the recorded 429s."""

import asyncio

import run

original_cached = run.cached


async def serial_cached(*args, **kwargs):
    kwargs["concurrency"] = 1
    return await original_cached(*args, **kwargs)


run.cached = serial_cached
asyncio.run(run.index("pplx4"))
