"""One model's line in a process (Epo 2026-11-04): every call past the gate
waits its turn, the shared line (Postgres, ``db.admit_line``) says whose turn
it is, and one pump asks it for all of the process's calls. The order itself
is the SQL's, tested in test_store_sql.py; this is the waiting."""

from __future__ import annotations

import asyncio

import pytest

from pipeline.retrieval import limits


class SharedLine:
    """Stands in for Postgres: records each round and grants the calls in
    ``turns`` that are waiting in this process."""

    def __init__(self) -> None:
        self.rounds: list[tuple[list[str], list[str], list[str]]] = []
        self.turns: set[str] = set()
        self.hold: asyncio.Event | None = None

    async def admit(self, store, waiting, gone) -> set[str]:
        self.rounds.append(([w.id for w in store], [w.id for w in waiting], gone))
        if self.hold is not None:
            await self.hold.wait()
        granted = self.turns & {w.id for w in waiting}
        self.turns -= granted
        return granted


@pytest.fixture
def shared(monkeypatch):
    # A long poll: only a call ending (``freed``) or leaving wakes the pump.
    monkeypatch.setattr(limits, "LINE_POLL_S", (5, 5))
    return SharedLine()


def _waiter(call_id: str) -> limits.LineWaiter:
    return limits.LineWaiter(call_id, f"cr_{call_id}", 60)


async def _drained(line: limits.ModelLine) -> None:
    pump = line._pump
    if pump is not None:
        await asyncio.wait_for(pump, timeout=1)


async def test_each_call_gets_the_turn_the_shared_line_grants(shared):
    line = limits.ModelLine(shared.admit)
    shared.turns = {"b"}
    first = asyncio.create_task(line.wait(_waiter("a"), 5, None))
    second = asyncio.create_task(line.wait(_waiter("b"), 5, None))
    assert await asyncio.wait_for(second, timeout=1) is True
    assert not first.done()
    # One round asks for both, storing both rows.
    assert shared.rounds[0] == (["a", "b"], ["a", "b"], [])
    shared.turns = {"a"}
    line.freed()  # a call on the model ended here: ask again at once
    assert await asyncio.wait_for(first, timeout=1) is True
    assert line.waiting == 0
    # A stored row is not sent again before its renewal is due.
    assert shared.rounds[1] == ([], ["a"], [])
    await _drained(line)


async def test_the_wait_ends_at_its_budget_and_its_row_goes(shared):
    line = limits.ModelLine(shared.admit)
    start = asyncio.get_running_loop().time()
    assert await line.wait(_waiter("a"), 0.05, None) is False
    assert asyncio.get_running_loop().time() - start >= 0.05
    await _drained(line)
    assert shared.rounds[-1] == ([], [], ["a"])
    assert line.waiting == 0


async def test_a_client_that_leaves_leaves_the_line(shared):
    line = limits.ModelLine(shared.admit)
    left = asyncio.Event()
    asyncio.get_running_loop().call_later(0.02, left.set)
    assert await asyncio.wait_for(line.wait(_waiter("a"), 5, left), 1) is False
    await _drained(line)
    assert shared.rounds[-1][2] == ["a"]


async def test_a_cancelled_call_leaves_the_line(shared):
    line = limits.ModelLine(shared.admit)
    waiting = asyncio.create_task(line.wait(_waiter("a"), 5, None))
    await asyncio.sleep(0.01)
    waiting.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiting
    await _drained(line)
    assert shared.rounds[-1][2] == ["a"]


async def test_a_turn_granted_as_the_call_left_is_given_back(shared):
    line = limits.ModelLine(shared.admit)
    shared.hold = asyncio.Event()
    shared.turns = {"a"}
    # The call gives up while the round that grants it is in flight.
    assert await line.wait(_waiter("a"), 0.02, None) is False
    shared.hold.set()
    await _drained(line)
    # Its lease (and row) go in the next round.
    assert shared.rounds[-1] == ([], [], ["a"])


async def test_rows_are_renewed_while_calls_wait(shared, monkeypatch):
    monkeypatch.setattr(limits, "LINE_POLL_S", (0.01, 0.01))
    monkeypatch.setattr(limits, "LINE_REFRESH_S", 0.05)
    line = limits.ModelLine(shared.admit)
    assert await line.wait(_waiter("a"), 0.2, None) is False
    await _drained(line)
    stored = [store for store, waiting, _gone in shared.rounds if waiting]
    assert stored[0] == ["a"]
    assert stored.count(["a"]) >= 2 and [] in stored


async def test_a_failed_round_is_asked_again(shared, monkeypatch):
    monkeypatch.setattr(limits, "LINE_POLL_S", (0.01, 0.01))
    calls = 0

    async def admit(store, waiting, gone):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("database away")
        return await shared.admit(store, waiting, gone)

    line = limits.ModelLine(admit)
    shared.turns = {"a"}
    assert await asyncio.wait_for(line.wait(_waiter("a"), 5, None), 1) is True
    # The row the failed round may not have stored is sent again.
    assert shared.rounds[0][0] == ["a"]
    await _drained(line)
