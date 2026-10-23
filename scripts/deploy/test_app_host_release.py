#!/usr/bin/env python3
"""The deploy job's side of an app-host release (app-host-release.sh) against
stubbed curl, sha256sum and ssh. Security regression (review M1/M2): SSH
trusts only the pinned host key and goes through the checksummed cloudflared,
and the host gets each image by a digest the job recorded."""

import io
import os
import re
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("app-host-release.sh").resolve()
PINNED = re.search(
    r"^CLOUDFLARED_SHA256=([0-9a-f]{64})$", SCRIPT.read_text(), re.MULTILINE
).group(1)
SHA = "c" * 40
DIGEST = "sha256:" + "d" * 64
CURL = """#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then printf 'not cloudflared' >"$2"; fi
  shift
done
"""
# Records what it was asked to check and passes; the mismatch test uses the
# real sha256sum instead.
SHA256SUM = """#!/bin/sh
printf '%s\\n' "$*" >"$CAPY_TEST_DIR/sha256sum.args"
cat >"$CAPY_TEST_DIR/sha256sum.stdin"
"""
SSH = """#!/bin/sh
printf '%s\\n' "$@" >"$CAPY_TEST_DIR/ssh.args"
cat >"$CAPY_TEST_DIR/upload.tar"
"""


class AppHostReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="capy-app-release-test-")
        self.dir = Path(self.temp.name)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        for name, body in {"curl": CURL, "ssh": SSH}.items():
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o700)
        self.ssh_dir = self.dir / "capy-ssh"
        self.env = {
            **os.environ,
            "CAPY_TEST_DIR": str(self.dir),
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "RUNNER_TEMP": str(self.dir),
            "APP_HOST_SSH_HOSTNAME": "ssh.example.test",
            "APP_HOST_KNOWN_HOSTS": "ssh.example.test ssh-ed25519 AAAAhost",
            "APP_HOST_SSH_PRIVATE_KEY": "private-key",
        }

    def tearDown(self):
        self.temp.cleanup()

    def release(self, *args, **env):
        return subprocess.run(
            [str(SCRIPT), *args],
            env={**self.env, **env},
            capture_output=True,
            text=True,
            check=False,
        )

    def configure(self):
        (self.bin / "sha256sum").write_text(SHA256SUM)
        (self.bin / "sha256sum").chmod(0o700)
        result = self.release("configure")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_configure_trusts_only_the_pinned_host_key_through_cloudflared(self):
        self.configure()
        self.assertIn("--check", (self.dir / "sha256sum.args").read_text())
        self.assertEqual(
            (self.dir / "sha256sum.stdin").read_text(),
            f"{PINNED}  {self.ssh_dir}/cloudflared\n",
        )
        config = (self.ssh_dir / "config").read_text().splitlines()
        for line in [
            "  HostName ssh.example.test",
            "  User capy-deploy",
            f"  IdentityFile {self.ssh_dir}/key",
            "  IdentitiesOnly yes",
            f"  UserKnownHostsFile {self.ssh_dir}/known_hosts",
            "  GlobalKnownHostsFile /dev/null",
            "  StrictHostKeyChecking yes",
            "  UpdateHostKeys no",
            "  BatchMode yes",
            f"  ProxyCommand {self.ssh_dir}/cloudflared access ssh --hostname %h",
        ]:
            self.assertIn(line, config)
        self.assertEqual(
            (self.ssh_dir / "known_hosts").read_text(),
            "ssh.example.test ssh-ed25519 AAAAhost\n",
        )

    def test_a_cloudflared_whose_checksum_differs_fails_configure(self):
        result = self.release("configure")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.ssh_dir / "config").exists())

    def deploy(self, images):
        self.configure()
        compose = self.dir / "compose.yml"
        compose.write_text("services: {}\n")
        env_file = self.dir / "app.env"
        env_file.write_text(f"RELEASE_SHA='{SHA}'\n")
        images_file = self.dir / "images"
        images_file.write_text(images)
        return self.release(
            "deploy",
            "app",
            str(compose),
            str(env_file),
            str(images_file),
            DEPLOY_REVISION=SHA,
            GHCR_TOKEN="job-token",
            GITHUB_ACTOR="capy-bot",
            TUNNEL_SERVICE_TOKEN_ID="id",
            TUNNEL_SERVICE_TOKEN_SECRET="secret",
        )

    def test_deploy_sends_the_recorded_digests_in_stack_env(self):
        image = f"ghcr.io/samyung0/capy-server@{DIGEST}"
        result = self.deploy(f"CAPY_SERVER_IMAGE={image}\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            (self.dir / "ssh.args").read_text().splitlines()[-2:],
            ["capy-app", f"deploy app {SHA}"],
        )
        upload = (self.dir / "upload.tar").read_bytes()
        with tarfile.open(fileobj=io.BytesIO(upload)) as archive:
            self.assertEqual(
                archive.getnames(), ["compose.yml", "stack.env", "ghcr-token"]
            )
            stack_env = archive.extractfile("stack.env").read().decode()
        self.assertEqual(
            stack_env, f"RELEASE_SHA='{SHA}'\nCAPY_SERVER_IMAGE='{image}'\n"
        )

    def test_deploy_refuses_an_image_that_is_not_a_digest(self):
        for images in [
            "CAPY_SERVER_IMAGE=ghcr.io/samyung0/capy-server:latest\n",
            f"CAPY_SERVER_IMAGE=ghcr.io/other/capy-server@{DIGEST}\n",
            f"CAPY_SERVER_IMAGE=ghcr.io/samyung0/capy-server@{DIGEST}'\n",
            "CAPY_SERVER_IMAGE=ghcr.io/samyung0/capy-server@\n",
        ]:
            with self.subTest(images=images):
                (self.dir / "ssh.args").unlink(missing_ok=True)
                result = self.deploy(images)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("not CAPY_*_IMAGE", result.stderr)
                self.assertFalse((self.dir / "ssh.args").exists())


if __name__ == "__main__":
    unittest.main()
