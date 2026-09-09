"""Generated bindings shared with the Go API contract.

``agent_tools.json`` (the agent-tool contract) is loaded by
``pipeline.retrieval.contract``; regenerate everything here with
``pnpm gen:openapi``.
"""

from .limits import MATERIAL_TITLE_MAX
from .slot import Slot

__all__ = ["MATERIAL_TITLE_MAX", "Slot"]
