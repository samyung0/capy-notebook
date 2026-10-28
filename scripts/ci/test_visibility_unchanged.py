"""agent-visibility.yml's nightly skip (visibility-unchanged.sh): the lane
skips only when every change since its last green run is under the ignore
list (review F1)."""

import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("visibility-unchanged.sh")


class NightlySkipTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.git("init", "-q")
        self.commit({"server/main.go": "a", "openwiki/a.md": "a"})

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@t", *args],
            cwd=self.repo,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def commit(self, files: dict[str, str]) -> str:
        """Commits `files` and returns the commit before it."""
        before = self.git("rev-parse", "HEAD") if self.has_head() else ""
        for name, text in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "change")
        return before

    def has_head(self) -> bool:
        return self.ok(["git", "rev-parse", "-q", "--verify", "HEAD"])

    def unchanged(self, since: str) -> bool:
        return self.ok(["bash", str(SCRIPT), since])

    def ok(self, command: list[str]) -> bool:
        done = subprocess.run(command, cwd=self.repo, capture_output=True, check=False)
        return done.returncode == 0

    def test_only_ignored_paths_skip_the_lane(self):
        since = self.commit(
            {
                "openwiki/a.md": "b",
                "human/test-catalog.md": "b",
                "bench/rag/x.py": "b",
                "lab/playground/y.py": "b",
                "ops/src/z.ts": "b",
                "workers/site/w.ts": "b",
                "AGENTS.md": "b",
            }
        )
        self.assertTrue(self.unchanged(since))

    def test_any_other_change_runs_the_lane(self):
        for path in (
            "server/internal/store/source_proxy.go",
            "collaboration-rs/Cargo.lock",
            "pipeline/tests/test_agent.py",
            "pipeline/pipeline/prompts/deck_styles/style.md",
            "e2e/fixtures/seed.sql",
            "src/features/notes/markdown.ts",
            "uv.lock",
        ):
            with self.subTest(path=path):
                self.assertFalse(self.unchanged(self.commit({path: path})))

    def test_an_unknown_last_green_commit_runs_the_lane(self):
        self.assertFalse(self.unchanged("0" * 40))


if __name__ == "__main__":
    unittest.main()
