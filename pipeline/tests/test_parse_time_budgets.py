from pipeline.config import cfg
from pipeline.jobs import policy_for


def test_parse_time_budgets_leave_room_for_upload_and_job_finalization() -> None:
    ingest = policy_for("ingest")

    assert cfg.parser_timeout < cfg.parser_slot_ttl < ingest.timeout_s
    assert cfg.parser_timeout < cfg.parser_presign_ttl < ingest.timeout_s
    assert ingest.timeout_s - cfg.parser_presign_ttl >= 600
