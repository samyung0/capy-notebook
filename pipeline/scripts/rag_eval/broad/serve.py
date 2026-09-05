"""Reuse the frozen comparison instrumentation with separate new output paths."""

import sys
from pathlib import Path

sys.path.insert(0, "/lab")
import lab_server
import uvicorn

lab_server.ROOT = Path("/lab/broad")
uvicorn.run("pipeline.retrieve.service:app", host="127.0.0.1", port=8002)
