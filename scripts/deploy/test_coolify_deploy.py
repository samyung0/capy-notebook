#!/usr/bin/env python3
"""The Coolify deploy script against a stubbed curl."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("coolify-deploy.sh").resolve()
TOKEN = "7|coolify-test-token"
REVISION = "c" * 40
# Records each call's arguments and stdin, then answers the PATCH, the deploy
# and the status poll in turn.
CURL = f"""#!/usr/bin/env bash
n=$(( $(cat "$STUB/calls") + 1 )); echo "$n" > "$STUB/calls"
printf '%s\\n' "$@" > "$STUB/args$n"
cat > "$STUB/stdin$n"
case "$*" in
  *PATCH*) echo '{{}}' ;;
  *"/deploy "*|*/deploy) echo '{{"deployments":[{{"resource_uuid":"app","deployment_uuid":"dep"}}]}}' ;;
  *) echo '{{"status":"finished","commit":"{REVISION}"}}' ;;
esac
"""


class CoolifyDeployTest(unittest.TestCase):
    def test_the_token_reaches_curl_on_stdin_never_in_its_arguments(self):
        """(security regression: ops hygiene, the Coolify token in curl's argv)"""
        with tempfile.TemporaryDirectory(prefix="capy-coolify-test-") as temp:
            stub = Path(temp)
            (stub / "curl").write_text(CURL, newline="\n")
            (stub / "curl").chmod(0o755)
            (stub / "calls").write_text("0")
            result = subprocess.run(
                # Not System32's WSL bash on Windows.
                [shutil.which("bash"), str(SCRIPT)],
                env={
                    **os.environ,
                    "PATH": f"{stub}{os.pathsep}{os.environ['PATH']}",
                    "STUB": str(stub),
                    "COOLIFY_API_URL": "https://coolify.example.test/api/v1",
                    "COOLIFY_API_TOKEN": TOKEN,
                    "COOLIFY_RESOURCE_UUID": "app",
                    "DEPLOY_REVISION": REVISION,
                    "COOLIFY_POLL_INTERVAL_SECONDS": "1",
                    "GITHUB_OUTPUT": "",
                },
                stdin=subprocess.DEVNULL,
                capture_output=True,
                check=False,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = int((stub / "calls").read_text())
            self.assertEqual(calls, 3)
            for n in range(1, calls + 1):
                self.assertNotIn(TOKEN, (stub / f"args{n}").read_text())
                self.assertEqual(
                    (stub / f"stdin{n}").read_text(),
                    f'header = "Authorization: Bearer {TOKEN}"\n',
                )


if __name__ == "__main__":
    unittest.main()
