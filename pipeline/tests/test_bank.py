"""Question-bank search: SQL filters, ranking by meaning, and vectors reused
until a question's text changes."""

from __future__ import annotations

from pipeline.retrieval import bank


def _question(qid: str, text: str) -> dict:
    content = {
        "id": qid,
        "stem": [],
        "parts": [{"blocks": [{"type": "text", "text": text}], "marks": 2}],
    }
    return {
        "id": qid,
        "content": content,
        "question_types": [],
        "sources": [],
        "topic_id": "t",
        "topic": "Circle geometry",
        "subject": "Maths",
        "exam": "hkdse",
    }


class _Pool:
    def __init__(self, rows):
        self.rows, self.queries = rows, []

    def connection(self):
        pool = self

        class _Conn:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def execute(self, sql, params=()):
                pool.queries.append((sql, list(params)))

                class _Cur:
                    async def fetchall(self):
                        return pool.rows

                return _Cur()

        return _Conn()


async def test_search_filters_ranks_by_meaning_and_reuses_vectors(monkeypatch):
    rows = [
        _question("q_tangent", "tangent lengths"),
        _question("q_mean", "mean of data"),
    ]
    fake = _Pool(rows)
    embedded: list[str] = []

    async def _pool():
        return fake

    async def _spec():
        return object()

    async def _embed(texts, *, spec):
        embedded.extend(texts)
        return [[1.0, 0.0] if "tangent" in t else [0.0, 1.0] for t in texts]

    monkeypatch.setattr(bank, "pool", _pool)
    monkeypatch.setattr(bank, "_embedding_spec", _spec)
    monkeypatch.setattr(bank.models, "embed", _embed)
    monkeypatch.setattr(bank.models, "format_query", lambda query, spec: query)
    bank._vectors.clear()

    hits = await bank.search("tangent from a point", exam="hkdse", types=["x"])

    assert [h["id"] for h in hits] == ["q_tangent", "q_mean"]
    sql, params = fake.queries[0]
    assert "e.id = %s" in sql and "q.question_types && %s" in sql
    assert params == ["hkdse", ["x"]]
    assert "q_tangent" in bank.card(hits[0]) and "1 part, 2 marks" in bank.card(hits[0])

    embedded.clear()
    await bank.search("mean")
    assert embedded == ["mean"], "unchanged questions keep their vectors"
    rows[1]["content"]["parts"][0]["blocks"][0]["text"] = "median of data"
    embedded.clear()
    await bank.search("mean")
    assert embedded == ["median of data", "mean"], (
        "an edited question is embedded again"
    )
