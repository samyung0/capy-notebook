#!/usr/bin/env python3
"""The app host's deploy command (app-host-deploy.sh) against a stubbed docker.
Security regression: it is root-capable through sudo, so it takes one command,
exactly three regular files, and never puts the registry token in an argument,
in Compose's way or in its output."""

import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("app-host-deploy.sh").resolve()
SHA = "c" * 40
OLD = "b" * 40
TOKEN = "ghs_job-token-never-printed"
PASSWORD = "postgres-password-never-printed"
REGISTRY = "ghcr.io/samyung0/"
IMAGES = [
    REGISTRY + name for name in ("capy-collaboration", "capy-pipeline", "capy-server")
]
APP_SERVICES = ["migrate", "server", "collaboration", "retrieval"]
DOCKER = r"""#!/usr/bin/env python3
import json, os, pathlib, sys
state_file = pathlib.Path(os.environ["CAPY_DOCKER_STATE"])
state = json.loads(state_file.read_text())
args = sys.argv[1:]
run = pathlib.Path(os.environ["CAPY_DEPLOY_RUN"])
state["calls"].append({
    "args": args,
    "docker_config": "DOCKER_CONFIG" in os.environ,
    "token_on_disk": any(run.glob("capy-deploy.*/files/ghcr-token")),
})
def save():
    state_file.write_text(json.dumps(state))
def exit(code=0):
    save(); sys.exit(code)
if args[0] == "login":
    state["login_password"] = sys.stdin.read()
    pathlib.Path(os.environ["DOCKER_CONFIG"], "config.json").write_text("{}")
    exit()
if args[0] == "compose":
    env = dict(line.split("=", 1) for line in pathlib.Path(args[args.index("--env-file") + 1]).read_text().splitlines())
    sha = env["RELEASE_SHA"].strip("'")
    command = args[args.index("--env-file") + 2:]
    if command[:2] == ["config", "--images"]:
        print("\n".join(state["config_images"]))
    elif command[0] == "pull":
        for image, revision in state["registry"].items():
            state["labels"][image + ":" + sha] = revision
            state["tags"].setdefault(image, []).append(sha)
    elif command[0] == "stop":
        state["containers"]["collaboration"]["state"] = "exited"
    elif command[0] == "up":
        if state.get("fail_up"):
            state["containers"]["server"] = {"state": "running", "health": "unhealthy", "code": 0, "revision": sha}
            exit(1)
        for service in state["services"]:
            done = service == "migrate"
            state["containers"][service] = {
                "state": "exited" if done else "running",
                "health": "-" if done else "healthy",
                "code": 0,
                "revision": sha,
            }
    exit()
if args[:2] == ["image", "inspect"]:
    if args[-1] not in state["labels"]:
        exit(1)
    print(state["labels"][args[-1]])
    exit()
if args[:2] == ["image", "ls"]:
    print("\n".join(state["tags"].get(args[-1], [])))
    exit()
if args[0] == "rmi":
    repository, tag = args[-1].rsplit(":", 1)
    state["tags"][repository].remove(tag)
    exit()
if args[0] == "ps":
    service = args[-1].removeprefix("label=com.docker.compose.service=")
    if service in state["containers"]:
        print("id-" + service)
    exit()
if args[0] == "inspect":
    service = args[-1].removeprefix("id-")
    c = state["containers"][service]
    print(service, c["state"], c["health"], c["code"], c["revision"])
    exit()
exit()
"""


def upload(files=None, extra=()):
    """A tar of the three files, as the deploy job sends it."""
    files = files or {}
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
        for info in extra:
            archive.addfile(info, io.BytesIO(b"x" * info.size))
    return buffer.getvalue()


def stack_files(sha=SHA):
    return {
        "compose.yml": b"services: {}\n",
        "stack.env": f"POSTGRES_PASSWORD='{PASSWORD}'\nRELEASE_SHA='{sha}'\n".encode(),
        "ghcr-token": f"capy-bot\n{TOKEN}\n".encode(),
    }


class AppHostDeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="capy-app-deploy-test-")
        base = Path(self.temp.name)
        self.root = base / "opt"
        self.run_dir = base / "run"
        self.root.mkdir()
        self.run_dir.mkdir()
        bin_dir = base / "bin"
        bin_dir.mkdir()
        (bin_dir / "docker").write_text(DOCKER)
        (bin_dir / "docker").chmod(0o700)
        self.state_file = base / "docker.json"
        self.write_state(
            {
                "calls": [],
                "services": APP_SERVICES,
                "config_images": [image + ":" + SHA for image in IMAGES]
                + ["pgvector/pgvector:0.8.7-pg16@sha256:" + "0" * 64],
                "registry": {image: SHA for image in IMAGES},
                "labels": {},
                "tags": {},
                "containers": {
                    service: {
                        "state": "exited" if service == "migrate" else "running",
                        "health": "-" if service == "migrate" else "healthy",
                        "code": 0,
                        "revision": OLD,
                    }
                    for service in APP_SERVICES
                },
            }
        )
        self.env = {
            **os.environ,
            "CAPY_DEPLOY_ROOT": str(self.root),
            "CAPY_DEPLOY_RUN": str(self.run_dir),
            "CAPY_DOCKER_STATE": str(self.state_file),
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
        }

    def tearDown(self):
        self.temp.cleanup()

    def write_state(self, state):
        self.state_file.write_text(json.dumps(state))

    def state(self):
        return json.loads(self.state_file.read_text())

    def deploy(self, data, command=f"deploy app {SHA}", status=0):
        result = subprocess.run(
            ["bash", str(SCRIPT)],
            input=data,
            env={**self.env, "SSH_ORIGINAL_COMMAND": command},
            capture_output=True,
            check=False,
            timeout=30,
        )
        output = (result.stdout + result.stderr).decode()
        self.assertEqual(result.returncode, status, output)
        for secret in (TOKEN, PASSWORD):
            self.assertNotIn(secret, output)
        return output

    def calls(self):
        return [call["args"] for call in self.state()["calls"]]

    def compose(self, command):
        """Index of the first `docker compose ... <command>` call."""
        for index, args in enumerate(self.calls()):
            if args[0] == "compose" and args[args.index("--env-file") + 2] == command:
                return index
        return None

    def test_refuses_any_command_but_one_deploy(self):
        for command in (
            "",
            "bash",
            "deploy",
            f"deploy web {SHA}",
            f"deploy app {SHA[:39]}",
            f"deploy app {SHA.upper()}",
            f"deploy app {SHA} extra",
            f"deploy  app {SHA}",
            f"deploy app {SHA};id",
            f"deploy app {SHA}\nid",
        ):
            with self.subTest(command=command):
                output = self.deploy(upload(stack_files()), command, status=2)
                self.assertIn("usage: deploy app|ops", output)
                self.assertEqual(self.calls(), [])
                self.assertEqual(list(self.root.iterdir()), [])

    def test_refuses_a_stack_env_rendered_for_another_revision(self):
        output = self.deploy(upload(stack_files(sha=OLD)), status=1)
        self.assertIn("stack.env is not rendered for", output)
        self.assertEqual(self.calls(), [])

    def test_unpacks_only_the_three_regular_files(self):
        link = tarfile.TarInfo("compose.yml")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        files = stack_files()
        without_compose = {k: v for k, v in files.items() if k != "compose.yml"}
        escape = tarfile.TarInfo("../escaped")
        escape.size = 1
        oversized = tarfile.TarInfo("padding")
        oversized.size = 1 << 20
        cases = {
            "a symlink": upload(without_compose, [link]),
            "a missing file": upload(without_compose),
            "an extra member": upload(files, [escape]),
            "a second copy": upload(files, [link]),
            "over 1 MiB": upload(files, [oversized]),
        }
        for name, data in cases.items():
            with self.subTest(name):
                self.write_state({**self.state(), "calls": []})
                self.deploy(data, status=1)
                self.assertEqual(self.calls(), [])
                self.assertFalse((self.run_dir.parent / "escaped").exists())
                self.assertEqual(list(self.run_dir.iterdir()), [])

    def test_deploys_collaboration_first_with_the_token_only_on_the_pull(self):
        output = self.deploy(upload(stack_files()))
        state = self.state()
        stop, up = self.compose("stop"), self.compose("up")
        self.assertEqual(self.calls()[stop][-1], "collaboration")
        # Collaboration flushes while the old gateway still serves.
        self.assertLess(stop, up)
        self.assertEqual(state["login_password"], TOKEN)
        pull = self.compose("pull")
        for index, call in enumerate(state["calls"]):
            self.assertNotIn(TOKEN, " ".join(call["args"]))
            # Only the login and the pull see the registry login, and nothing
            # after the pull finds the token on disk.
            login = call["args"][0] == "login"
            self.assertEqual(
                call["docker_config"], login or index == pull, call["args"]
            )
            if index > pull:
                self.assertFalse(call["token_on_disk"], call["args"])
        # The pull names the app services only: Postgres and Redis stay local.
        pull_args = self.calls()[pull]
        self.assertEqual(pull_args[pull_args.index("pull") + 2 :], APP_SERVICES)
        release = self.root / "app/releases" / SHA
        self.assertEqual(
            sorted(p.name for p in release.iterdir()), ["compose.yml", "stack.env"]
        )
        self.assertEqual((release / "stack.env").stat().st_mode & 0o777, 0o600)
        self.assertEqual(os.readlink(self.root / "app/current"), f"releases/{SHA}")
        self.assertIn(f"server running healthy 0 {SHA}", output)
        self.assertEqual(list(self.run_dir.iterdir()), [])

    def test_ops_deploys_without_stopping_anything_first(self):
        state = self.state()
        state.update(
            services=["ops"],
            config_images=[f"{REGISTRY}capy-ops:{SHA}"],
            registry={f"{REGISTRY}capy-ops": SHA},
            containers={
                "ops": {
                    "state": "running",
                    "health": "healthy",
                    "code": 0,
                    "revision": OLD,
                }
            },
        )
        self.write_state(state)
        self.deploy(upload(stack_files()), command=f"deploy ops {SHA}")
        self.assertIsNone(self.compose("stop"))
        self.assertEqual(self.calls()[self.compose("up")][2], "capy-ops")

    def test_a_mislabelled_image_fails_before_anything_stops(self):
        state = self.state()
        state["registry"][REGISTRY + "capy-collaboration"] = OLD
        self.write_state(state)
        output = self.deploy(upload(stack_files()), status=1)
        self.assertIn(f"capy-collaboration:{SHA} is labelled {OLD}", output)
        self.assertIsNone(self.compose("stop"))
        self.assertIsNone(self.compose("up"))

    def test_a_failed_start_names_the_services_and_keeps_no_release(self):
        state = self.state()
        state["fail_up"] = True
        self.write_state(state)
        output = self.deploy(upload(stack_files()), status=1)
        self.assertIn(f"server running unhealthy 0 {SHA}", output)
        self.assertIn("starting the app stack failed", output)
        self.assertFalse((self.root / "app/releases" / SHA).exists())

    def test_prune_keeps_the_newest_three_releases_and_their_tags(self):
        older = ["1" * 40, "2" * 40, "3" * 40, "4" * 40]
        releases = self.root / "app/releases"
        for age, sha in enumerate(reversed(older)):
            (releases / sha).mkdir(parents=True)
            os.utime(releases / sha, (1_000_000 - age, 1_000_000 - age))
        state = self.state()
        state["tags"] = {image: list(older) for image in IMAGES}
        self.write_state(state)
        self.deploy(upload(stack_files()))
        self.assertEqual(
            sorted(p.name for p in releases.iterdir()),
            sorted([SHA, older[-1], older[-2]]),
        )
        for tags in self.state()["tags"].values():
            self.assertEqual(sorted(tags), sorted([SHA, older[-1], older[-2]]))
        self.assertIn(["image", "prune", "-f"], self.calls())


if __name__ == "__main__":
    unittest.main()
