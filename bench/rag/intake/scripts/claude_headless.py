"""One structured call to Claude through the Claude Code CLI on the subscription.

Tools off, no MCP servers, no session persistence; ANTHROPIC_* variables are
removed so the login is used (as in bench/parsers/scripts/compare_claude_recovery.py).
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import time
from pathlib import Path

FLAGS = [
    "-p",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
]


def image_block(path: Path, media_type: str = "image/jpeg") -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": base64.b64encode(path.read_bytes()).decode()}}


def call(system: str, content: list[dict], schema: dict, *, model: str, effort: str, timeout: int = 900) -> dict:
    """Returns {"value", "error", "usage", "seconds"}; `value` is the structured output or None."""
    env = dict(os.environ)
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        env.pop(name, None)
    cmd = ["claude", *FLAGS, "--model", model, "--effort", effort, "--system-prompt", system, "--json-schema", json.dumps(schema)]
    event = {"type": "user", "message": {"role": "user", "content": content}}
    started = time.monotonic()
    proc = subprocess.run(cmd, input=json.dumps(event) + "\n", capture_output=True, text=True, encoding="utf-8", env=env, timeout=timeout)
    result = None
    for line in proc.stdout.splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "result":
            result = e
    value = (result or {}).get("structured_output")
    return {
        "value": value,
        "error": None if value is not None else {"returncode": proc.returncode, "stderr": proc.stderr[-800:], "result": (result or {}).get("result")},
        "usage": (result or {}).get("usage"),
        "seconds": round(time.monotonic() - started, 1),
        "model": model,
        "effort": effort,
    }
