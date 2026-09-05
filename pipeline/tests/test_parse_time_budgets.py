from pipeline.config import cfg
from pipeline.jobs import policy_for


def test_parse_time_budgets_leave_room_for_job_finalization() -> None:
    parse = policy_for("parse")
    ingest = policy_for("ingest")

    assert (
        cfg.parse_slice_timeout
        < cfg.parser_timeout
        < cfg.parser_slot_ttl
        < parse.timeout_s
    )
    assert parse.timeout_s - cfg.parser_slot_ttl >= 600
    assert ingest.timeout_s == cfg.ingest_timeout
    assert cfg.caption_cache_ttl_days > 0
