"""Decks in the playground: production's pipeline.retrieval.deck, pointed at a
local ppt-master.

The app runs ppt-master from the retrieval image (pipeline/Dockerfile). Here
the same pinned commit is checked out into the ignored local/ppt-master on
first use, without icons, sounds and image-model comparison sheets (its
attribution guard refuses a partial copy, so the skill is never vendored
piecemeal), and its scripts run under uv with deck.PPT_MASTER_DEPS. DECKS.md
covers the playground's measurements and adding a style; openwiki/decks.md
describes the app.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from common import REPO

from pipeline.retrieval import deck as production
from pipeline.retrieval.deck import (  # noqa: F401  (the playground's names)
    complete,
    create,
    created_text,
    figure_pages,
    outline_text,
    save,
    write,
)

PPT_MASTER_DIR = REPO / "lab/playground/local/ppt-master"
# tools.DECK_TOOLS; importing tools here would read pipeline.config before the
# playground has set the target's environment.
NAMES = frozenset({"create_deck", "write_slide"})

production.SKILL = PPT_MASTER_DIR / "skills/ppt-master"
production.PYTHON = [
    "uv",
    "--native-tls",
    "run",
    "--quiet",
    "--no-project",
    *(part for dep in production.PPT_MASTER_DEPS for part in ("--with", dep)),
    "python",
]


def ensure_ppt_master() -> Path:
    """The pinned skill checkout, cloned on first use."""
    if production.available():
        return production.SKILL
    PPT_MASTER_DIR.parent.mkdir(parents=True, exist_ok=True)
    git = ["git", "-C", str(PPT_MASTER_DIR)]
    subprocess.run(
        [
            "git",
            "clone",
            "--quiet",
            "--filter=blob:none",
            "--no-checkout",
            production.PPT_MASTER_REPO,
            str(PPT_MASTER_DIR),
        ],
        check=True,
    )
    subprocess.run(
        [
            *git,
            "sparse-checkout",
            "set",
            "--no-cone",
            "skills/ppt-master",
            "!skills/ppt-master/templates/icons/",
            "!skills/ppt-master/templates/sounds/",
            "!skills/ppt-master/references/ai-image-comparison/",
        ],
        check=True,
    )
    subprocess.run(
        [*git, "checkout", "--quiet", production.PPT_MASTER_COMMIT], check=True
    )
    return production.SKILL
