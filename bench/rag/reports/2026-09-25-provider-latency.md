# DeepInfra vs Alibaba latency and timeouts, 25 September 2026

Measured from the developer PC (Japan) to find out why local work keeps timing
out on DeepInfra. Runner: [`provider_latency.py`](../scripts/provider_latency.py);
raw samples in the ignored `data/provider-latency/samples.jsonl`.

## Why local runs time out

The immediate cause is in our code, not DeepInfra's worst case. `_interactive()`
in `pipeline/pipeline/elitellm/client.py` and `retrieval/models.py` treats any
call without an ingest accounting state as interactive. Lab tools such as
`knowledge_base_pilot.py` never open one, so every 32-chunk embedding batch gets
the 15 s interactive whole-call bound (`CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S`),
and `embed()` retries only busy answers, so a timeout ends the run. Production
ingest gets 120 s and four attempts. The playground already raises the bound to
60 s (`lab/playground/scripts/common.py`); the knowledge builder does not.

The builder's own history fits this. `data/knowledge-base/logs/*/index.log`
records 32 `Pilot failed: TimeoutError` exits across 10 books, all during
embedding, several within 16 s of starting and clustered in runs of failures
minutes apart. The 7,184 successful batches in `embedding-usage.jsonl` have
p50 1.6 s, p99 9.6 s and a maximum of 15.6 s: the distribution is cut at the
bound because slower batches failed and were never logged.

## Live comparison

30 minutes, 146 interleaved cycles, then four rounds of eight concurrent
requests per target. No retries; 60 s backstop. Real library chunks and frozen
library queries. Batch sizes are each provider's relevant maximum: DeepInfra 64
(`CAPY_EMBEDDING_BATCH`), Alibaba 20. Embedding: DeepInfra
`Qwen/Qwen3-Embedding-4B` vs Alibaba Singapore `qwen3.7-text-embedding`
(native route). Rerank, 20 documents: DeepInfra `Qwen/Qwen3-Reranker-4B` vs
`qwen3-rerank` in Beijing and Singapore.

| Workload | Target | p50 ms | p95 ms | p99 ms | max ms |
| --- | --- | ---: | ---: | ---: | ---: |
| Query embed | DeepInfra | 537 | 3,336 | 5,771 | 6,034 |
| Query embed | Alibaba SG | 352 | 880 | 949 | 1,026 |
| Batch embed | DeepInfra, 64 chunks | 2,706 | 5,245 | 9,439 | 10,688 |
| Batch embed | Alibaba SG, 20 chunks | 1,316 | 1,897 | 2,009 | 2,021 |
| Batch embed, 8 concurrent | DeepInfra, 64 chunks | 7,411 | 11,343 | 13,149 | 13,149 |
| Batch embed, 8 concurrent | Alibaba SG, 20 chunks | 2,255 | 3,142 | 3,307 | 3,307 |
| Rerank 20 | DeepInfra 4B | 996 | 4,050 | 5,656 | 10,985 |
| Rerank 20 | Alibaba SG | 452 | 931 | 1,036 | 1,063 |
| Rerank 20 | Alibaba BJ | 871 | 2,008 | 2,397 | 2,770 |
| Rerank 20, 8 concurrent | DeepInfra 4B | 1,812 | 3,587 | 3,795 | 3,795 |
| Rerank 20, 8 concurrent | Alibaba SG | 1,121 | 1,387 | 1,485 | 1,485 |

All 1,182 requests succeeded; none exceeded 15 s. This window did not catch one
of the historical failure episodes, so it measures the ordinary tail only.

- DeepInfra's tail is server-side. Bare TCP connects stayed at p99 132 ms, and
  slow calls spent their time waiting for the first response byte, mostly on
  reused connections. Slow calls cluster: every query embed from minute 14.6 to
  18.0 took more than three times the median, and reranks slowed together
  around minutes 13 and 24 to 29. That matches the builder's clustered failures.
- Under eight concurrent 64-chunk batches, DeepInfra's p99 reached 13.1 s,
  close to the 15 s bound, in a window with no incident.
- Throughput per chunk is similar under concurrency (about 69 chunks/s
  DeepInfra, 72 Alibaba), but Alibaba's 1M tokens-per-minute account cap is about
  46 chunks/s at 360 tokens a chunk, so sustained Alibaba ingest would throttle.
- Alibaba Beijing closed the connection after almost every request (139 of 146
  opened a new one), paying about 450 ms of connect and TLS each time from here.
  Singapore reused connections more often.

## Reading

Raising the builder's bound (or giving lab embedding the ingest timeout and
attempts) removes the observed failures without changing vendor. On latency
alone Alibaba Singapore is faster and much steadier from this machine; the
embedding comparison in [qwen37](../qwen37/reports/2026-09-25-qwen37-embedding.md)
still argues against switching embedders. For the reranker, this run's
DeepInfra 20-document p95 of 4.1 s misses the 1.5 s bar that the
[rerank report](../rerank/reports/2026-09-25-library-rerank.md) measured at
1.2 s in a calmer window; Alibaba Singapore met it at 0.93 s. Both are
dev-PC numbers; production runs on the ingest host, which needs its own check.

About $0.40 of provider usage (DeepInfra's inference endpoint does not report
rerank tokens here).
