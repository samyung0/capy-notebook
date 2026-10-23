#!/usr/bin/env python3
"""The app host's deploy command (app-host-deploy.sh) against a stubbed docker.
Security regression: it is root-capable through sudo, so it takes one command,
exactly three regular files, only the compose file CI built the SHA with, only
CI's images by digest, and never puts the registry token in an argument, in
Compose's way or in its output."""

import hashlib
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
# One literal, digest-pinned image, as Postgres and Redis are.
PINNED = "pgvector/pgvector:0.8.7-pg16@sha256:" + "7" * 64
COMPOSE = f"services:\n  db:\n    image: {PINNED}\n".encode()
APP_IMAGES = {
    "CAPY_SERVER_IMAGE": "capy-server",
    "CAPY_COLLABORATION_IMAGE": "capy-collaboration",
    "CAPY_PIPELINE_IMAGE": "capy-pipeline",
}
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
local = state["local"]
def save():
    state_file.write_text(json.dumps(state))
def exit(code=0):
    save(); sys.exit(code)
def pull(ref):
    key = state["registry"].get(ref)
    if key is None:
        exit(1)
    image = local.setdefault(key, {**state["images"][key], "tags": []})
    if "@" not in ref:
        image["tags"].append(ref.rsplit(":", 1)[1])
def find(ref):
    for key, image in local.items():
        if ref == key or ref in [key.split("@")[0] + ":" + tag for tag in image["tags"]]:
            return key, image
    exit(1)
if args[0] == "login":
    state["login_password"] = sys.stdin.read()
    pathlib.Path(os.environ["DOCKER_CONFIG"], "config.json").write_text("{}")
    exit()
if args[0] == "pull":
    pull(args[-1])
    exit()
if args[0] == "compose":
    lines = pathlib.Path(args[args.index("--env-file") + 1]).read_text().splitlines()
    env = {key: value.strip("'") for key, value in (line.split("=", 1) for line in lines)}
    sha = env["RELEASE_SHA"]
    command = args[args.index("--env-file") + 2:]
    if command[:2] == ["config", "--images"]:
        compose = pathlib.Path(args[args.index("-f") + 1]).read_text().splitlines()
        literal = [line.split(":", 1)[1].strip() for line in compose if line.strip().startswith("image:") and "$" not in line]
        resolved = [value for key, value in env.items() if key.startswith("CAPY_") and key.endswith("_IMAGE")]
        # A test sets compose_images for what a Compose parser bug would resolve.
        print("\n".join(state.get("compose_images", resolved + literal)))
    elif command[0] == "pull":
        for key, value in env.items():
            if key.startswith("CAPY_") and key.endswith("_IMAGE"):
                pull(value)
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
    key, image = find(args[-1])
    fmt = args[args.index("--format") + 1]
    if "RepoDigests" in fmt:
        print(key)
    elif "compose.sha256" in fmt:
        print(image["compose"])
    else:
        print(image["revision"])
    exit()
if args[:2] == ["image", "ls"]:
    for key, image in local.items():
        if key.split("@")[0] == args[-1]:
            for tag in image["tags"] or ["<none>"]:
                print(tag, key.split("@")[1])
    exit()
if args[0] == "rmi":
    ref = args[-1]
    if "@" in ref:
        local.pop(ref, None)
    else:
        key, image = find(ref)
        image["tags"].remove(ref.rsplit(":", 1)[1])
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


def digest(repository, sha):
    return "sha256:" + hashlib.sha256(f"{repository}{sha}".encode()).hexdigest()


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


def stack_env(sha=SHA, images=APP_IMAGES, extra=""):
    lines = [f"POSTGRES_PASSWORD='{PASSWORD}'", f"RELEASE_SHA='{sha}'"]
    lines += [
        f"{variable}='{REGISTRY}{name}@{digest(REGISTRY + name, sha)}'"
        for variable, name in images.items()
    ]
    return ("\n".join(lines) + "\n" + extra).encode()


def stack_files(sha=SHA, compose=COMPOSE, env=None):
    return {
        "compose.yml": compose,
        "stack.env": env if env is not None else stack_env(sha),
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
        state = {
            "calls": [],
            "services": APP_SERVICES,
            "registry": {},
            "images": {},
            "local": {},
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
        self.write_state(state)
        for name in APP_IMAGES.values():
            self.publish(name, SHA)
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

    def publish(self, name, sha, tag=None, revision=None, compose=COMPOSE):
        """CI's push of one image: its SHA tag, its digest and its labels."""
        state = self.state()
        repository = REGISTRY + name
        key = f"{repository}@{digest(repository, sha)}"
        state["images"][key] = {
            "revision": revision or sha,
            "compose": hashlib.sha256(compose).hexdigest(),
        }
        state["registry"][f"{repository}:{tag or sha}"] = key
        state["registry"][key] = key
        self.write_state(state)
        return key

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

    def compose(self, command=None):
        """Index of the first `docker compose ... <command>` call (any, if None)."""
        for index, args in enumerate(self.calls()):
            if args[0] == "compose" and command in (
                None,
                args[args.index("--env-file") + 2],
            ):
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
        output = self.deploy(upload(stack_files(env=stack_env(sha=OLD))), status=1)
        self.assertIn("stack.env is not rendered for", output)
        self.assertEqual(self.calls(), [])

    def test_refuses_compose_and_docker_settings_or_other_syntax_in_stack_env(self):
        """COMPOSE_FILE or DOCKER_HOST would replace what root runs."""
        for extra, message in (
            ("COMPOSE_FILE='/root/evil.yml'\n", "COMPOSE_* or DOCKER_*"),
            ("DOCKER_HOST='tcp://10.0.0.9:2375'\n", "COMPOSE_* or DOCKER_*"),
            ("export COMPOSE_PROFILES=evil\n", "not KEY='value'"),
        ):
            with self.subTest(extra=extra):
                output = self.deploy(
                    upload(stack_files(env=stack_env(extra=extra))), status=1
                )
                self.assertIn(message, output)
                self.assertEqual(self.calls(), [])

    def test_refuses_lines_compose_reads_as_another_assignment(self):
        """Security regression (review R1): Compose reads two assignments
        from `A='x' B='y'`, and `\\'` as an escaped quote that runs into the
        next line; either would set CAPY_SERVER_IMAGE where the line checks
        never look."""
        for extra in (
            "FOO='x' CAPY_SERVER_IMAGE='alpine:3'\n",
            "X='abc\\'\nY='CAPY_SERVER_IMAGE=alpine:3 #'\n",
        ):
            with self.subTest(extra=extra):
                output = self.deploy(
                    upload(stack_files(env=stack_env(extra=extra))), status=1
                )
                self.assertIn("not KEY='value'", output)
                self.assertEqual(self.calls(), [])

    def test_refuses_images_compose_resolves_other_than_the_verified_ones(self):
        """Security regression (review R1): Compose's own resolved view is
        judged too, so a parser difference cannot run another image."""
        verified = [
            f"{REGISTRY}{name}@{digest(REGISTRY + name, SHA)}"
            for name in APP_IMAGES.values()
        ]
        for images in (
            ["alpine:3", *verified[1:], PINNED],
            [*verified, PINNED, "alpine:3"],
            verified,
        ):
            with self.subTest(images=images):
                self.write_state(
                    {**self.state(), "calls": [], "compose_images": images}
                )
                output = self.deploy(upload(stack_files()), status=1)
                self.assertIn("Compose resolves other images", output)
                self.assertIsNone(self.compose("pull"))
                self.assertIsNone(self.compose("up"))

    def test_refuses_an_image_not_named_by_its_repository_and_digest(self):
        for value in (
            f"{REGISTRY}capy-server:{SHA}",
            f"alpine@{digest('alpine', SHA)}",
            f"{REGISTRY}capy-pipeline@{digest(REGISTRY + 'capy-pipeline', SHA)}",
        ):
            with self.subTest(value=value):
                env = stack_env().replace(
                    f"CAPY_SERVER_IMAGE='{REGISTRY}capy-server@{digest(REGISTRY + 'capy-server', SHA)}'".encode(),
                    f"CAPY_SERVER_IMAGE='{value}'".encode(),
                )
                output = self.deploy(upload(stack_files(env=env)), status=1)
                self.assertIn("CAPY_SERVER_IMAGE must be", output)
                self.assertEqual(self.calls(), [])

    def test_runs_only_the_compose_file_ci_built_the_sha_with(self):
        """Security regression (review H1): a compose.yml that is not the one
        whose hash CI put on the SHA's capy-server image (a privileged service,
        a host mount, another image) never reaches Compose."""
        hostile = (
            b"services:\n  server:\n    privileged: true\n    volumes: ['/:/host']\n"
        )
        output = self.deploy(upload(stack_files(compose=hostile)), status=1)
        self.assertIn("compose.yml is not the compose file CI built", output)
        self.assertIsNone(self.compose())
        # The anchor came by a name built from the SHA alone.
        self.assertIn(["pull", "--quiet", f"{REGISTRY}capy-server:{SHA}"], self.calls())

    def test_refuses_an_anchor_without_the_compose_label_or_for_another_sha(self):
        for revision, compose in ((None, b""), (OLD, COMPOSE)):
            with self.subTest(revision=revision):
                self.publish("capy-server", SHA, revision=revision, compose=compose)
                state = self.state()
                key = f"{REGISTRY}capy-server@{digest(REGISTRY + 'capy-server', SHA)}"
                if not compose:
                    state["images"][key]["compose"] = ""
                state["local"] = {}
                state["calls"] = []
                self.write_state(state)
                self.deploy(upload(stack_files()), status=1)
                self.assertIsNone(self.compose())

    def test_the_server_digest_must_be_the_anchor_tags_image(self):
        """Security regression (review M2): a tag pushed over after the images
        job recorded the digest is refused before any Compose call."""
        moved = self.publish("capy-server", OLD, revision=SHA)
        state = self.state()
        state["registry"][f"{REGISTRY}capy-server:{SHA}"] = moved
        self.write_state(state)
        output = self.deploy(upload(stack_files()), status=1)
        self.assertIn("is not the digest the deploy job recorded", output)
        self.assertIsNone(self.compose())

    def test_unpacks_only_the_three_regular_files(self):
        link = tarfile.TarInfo("compose.yml")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        hardlink = tarfile.TarInfo("compose.yml")
        hardlink.type = tarfile.LNKTYPE
        hardlink.linkname = "stack.env"
        files = stack_files()
        without_compose = {k: v for k, v in files.items() if k != "compose.yml"}
        escape = tarfile.TarInfo("../escaped")
        escape.size = 1
        cases = {
            "a symlink": upload(without_compose, [link]),
            "a hardlink": upload(without_compose, [hardlink]),
            "a missing file": upload(without_compose),
            "an extra member": upload(files, [escape]),
            "a second copy": upload(files, [link]),
            # Valid up to its end marker, so only the size check refuses it.
            "over 1 MiB": upload(files) + bytes(1 << 20),
            "a 1 MiB compose.yml": upload(stack_files(compose=b"#" * (1 << 20))),
        }
        for name, data in cases.items():
            with self.subTest(name):
                self.write_state({**self.state(), "calls": []})
                self.deploy(data, status=1)
                self.assertEqual(self.calls(), [])
                self.assertFalse((self.run_dir.parent / "escaped").exists())
                self.assertEqual(list(self.run_dir.iterdir()), [])

    def test_deploys_collaboration_first_with_the_token_only_on_the_pulls(self):
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
            # Only the login and the two pulls see the registry login, and
            # nothing after the Compose pull finds the token on disk.
            registry = call["args"][0] in ("login", "pull") or index == pull
            self.assertEqual(call["docker_config"], registry, call["args"])
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

    def test_ops_deploys_its_environments_image_without_stopping_anything(self):
        ops = {"CAPY_OPS_IMAGE": "capy-ops"}
        self.publish("capy-ops", SHA, tag=f"{SHA}-uat")
        state = self.state()
        state.update(
            services=["ops"],
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
        env = stack_env(images=ops, extra="SENTRY_ENVIRONMENT='uat'\n")
        self.deploy(upload(stack_files(env=env)), command=f"deploy ops {SHA}")
        self.assertIn(
            ["pull", "--quiet", f"{REGISTRY}capy-ops:{SHA}-uat"], self.calls()
        )
        self.assertIsNone(self.compose("stop"))
        self.assertEqual(self.calls()[self.compose("up")][2], "capy-ops")

    def test_a_mislabelled_image_fails_before_anything_stops(self):
        self.publish("capy-collaboration", SHA, revision=OLD)
        output = self.deploy(upload(stack_files()), status=1)
        self.assertIn(f"{REGISTRY}capy-collaboration is labelled {OLD}", output)
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

    def test_prune_keeps_the_newest_three_releases_and_their_images(self):
        older = ["1" * 40, "2" * 40, "3" * 40, "4" * 40]
        releases = self.root / "app/releases"
        state = self.state()
        for age, sha in enumerate(reversed(older)):
            (releases / sha).mkdir(parents=True)
            (releases / sha / "stack.env").write_bytes(stack_env(sha))
            os.utime(releases / sha, (1_000_000 - age, 1_000_000 - age))
            for name in APP_IMAGES.values():
                repository = REGISTRY + name
                tags = [sha] if name == "capy-server" else []
                state["local"][f"{repository}@{digest(repository, sha)}"] = {
                    "revision": sha,
                    "compose": "",
                    "tags": tags,
                }
        self.write_state(state)
        self.deploy(upload(stack_files()))
        kept = [SHA, older[-1], older[-2]]
        self.assertEqual(sorted(p.name for p in releases.iterdir()), sorted(kept))
        self.assertEqual(
            sorted(self.state()["local"]),
            sorted(
                f"{REGISTRY}{name}@{digest(REGISTRY + name, sha)}"
                for sha in kept
                for name in APP_IMAGES.values()
            ),
        )
        server_tags = [
            tag
            for key, image in self.state()["local"].items()
            if key.startswith(REGISTRY + "capy-server@")
            for tag in image["tags"]
        ]
        self.assertEqual(sorted(server_tags), sorted(kept))
        self.assertIn(["image", "prune", "-f"], self.calls())


if __name__ == "__main__":
    unittest.main()
