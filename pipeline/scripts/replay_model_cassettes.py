"""Replay all certified agentic-loop cassettes without source writes."""

from pipeline.model_replay_cert import replay_certified_models

if __name__ == "__main__":
    raise SystemExit(replay_certified_models())
