#!/usr/bin/env python3
"""The assets Worker's automatic rollback decision against a stubbed app host."""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("assets-rollback-check.sh").resolve()
WORKFLOW = SCRIPT.parents[2] / ".github/workflows/deploy-environment.yml"
OLD = "a" * 40
NEW = "b" * 40
# Read n answers with the file `read<n>` in $STUB, or fails as curl -f does.
CURL = """#!/usr/bin/env bash
n=$(( $(cat "$STUB/reads") + 1 )); echo "$n" > "$STUB/reads"
echo "${@: -1}" >> "$STUB/urls"
[[ -f "$STUB/read$n" ]] || exit 22
cat "$STUB/read$n"
"""
SLEEP = '#!/usr/bin/env bash\necho "$1" >> "$STUB/sleeps"\n'


class AssetsRollbackTest(unittest.TestCase):
    def decide(self, *answers):
        """Runs the check with the app host answering each read in turn (None
        fails); returns its exit code, the URLs read and the sleeps."""
        with tempfile.TemporaryDirectory(prefix="capy-rollback-test-") as temp:
            stub = Path(temp)
            for name, body in (("curl", CURL), ("sleep", SLEEP)):
                (stub / name).write_text(body, newline="\n")
                (stub / name).chmod(0o755)
            (stub / "reads").write_text("0")
            (stub / "sleeps").write_text("")
            for n, answer in enumerate(answers, 1):
                if answer is not None:
                    (stub / f"read{n}").write_text(answer)
            result = subprocess.run(
                # Not System32's WSL bash on Windows.
                [shutil.which("bash"), str(SCRIPT)],
                env={
                    **os.environ,
                    "PATH": f"{stub}{os.pathsep}{os.environ['PATH']}",
                    "STUB": str(stub),
                    "DEPLOYMENT_APP_URL": "https://app.example.test/",
                    "DEPLOY_REVISION": NEW,
                },
                capture_output=True,
                check=False,
                text=True,
            )
            return (
                result.returncode,
                (stub / "urls").read_text().split(),
                (stub / "sleeps").read_text().split(),
            )

    def test_rolls_back_when_every_successful_read_shows_the_old_revision(self):
        for answers in [(OLD, OLD, OLD), (None, f"{OLD}\n", "<!doctype html>")]:
            with self.subTest(answers=answers):
                code, urls, sleeps = self.decide(*answers)
                self.assertEqual(code, 0)
                self.assertEqual(urls, ["https://app.example.test/release.txt"] * 3)
                self.assertEqual(sleeps, ["15", "15"])

    def test_leaves_both_workers_when_a_read_shows_the_new_revision(self):
        for answers in [(NEW,), (OLD, None, NEW), (OLD, f"{NEW}\n")]:
            with self.subTest(answers=answers):
                code, urls, _ = self.decide(*answers)
                self.assertEqual(code, 1)
                # It stops at the read that showed it.
                self.assertEqual(len(urls), len(answers))

    def test_leaves_both_workers_when_no_read_succeeds(self):
        for answers in [(None, None, None), ("<!doctype html>", "", None)]:
            with self.subTest(answers=answers):
                code, urls, _ = self.decide(*answers)
                self.assertEqual(code, 1)
                self.assertEqual(len(urls), 3)

    def test_the_workflow_rolls_back_only_after_the_check(self):
        workflow = WORKFLOW.read_text()
        step = workflow.split("- name: Roll the SPA assets Worker back", 1)[1]
        step = step.split("- name:", 1)[0]
        self.assertLess(
            step.index("scripts/deploy/assets-rollback-check.sh"),
            re.search(r"wrangler@\S+ rollback", step).start(),
        )


if __name__ == "__main__":
    unittest.main()
