#!/usr/bin/env python3
"""Exercise the remote release protocol without an SSH host or Docker daemon."""

import json
import os
import shlex
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

SCRIPT = Path(__file__).with_name("ingest-host-remote-release.sh").resolve()
PREVIOUS = "a" * 40
CANDIDATE = "b" * 40
MOCK = r"""#!/usr/bin/env python3
import json,os,pathlib,sys
base=pathlib.Path(os.environ['CAPY_INGEST_ROOT']);file=base/'mock.json';data=json.loads(file.read_text());args=sys.argv[1:];name=pathlib.Path(sys.argv[0]).name
def save():file.write_text(json.dumps(data))
if name=='flock':sys.exit(0)
if name=='cp':
 if os.environ.get('CAPY_FAIL_COMMIT') and args[-1].endswith('/previous'):sys.exit(1)
 os.execv('/bin/cp',['cp',*args])
if name=='git':
 if args[:2]==['status','--porcelain']:sys.exit(0)
 if args[:2]==['checkout','--detach']:data['head']=args[2];save()
 elif args[:2]==['rev-parse','HEAD']:print(data['head'])
 sys.exit(0)
if name!='docker':sys.exit(0)
data['calls'].append(args);save()
if args[0]=='ps':
 if data.get('local_running'):print('local-container')
 sys.exit(0)
if args[0]=='images':
 for tag in data.get('images',{}).get(args[1],[]):print(tag)
 sys.exit(0)
if args[0]=='rmi':
 image,tag=args[1].rsplit(':',1);data['images'][image].remove(tag);save();sys.exit(0)
if args[0]=='inspect':
 service=args[-1];fmt=args[2]
 if 'Labels' in fmt:print(data['running'][service])
 elif 'RestartCount' in fmt:print(data.get('restarts',0))
 elif 'ExitCode' in fmt:print(data.get('exit_code',0))
 elif 'Health' in fmt:print('healthy')
 else:print('true')
 sys.exit(0)
if args[0]=='compose':
 env_file=pathlib.Path(args[args.index('--env-file')+1])
 if data['head'] != os.environ['RELEASE_SHA']:
  print('Compose checkout and release differ',file=sys.stderr);sys.exit(1)
 if data['head']=='b'*40 and 'PARSER_BIND_ADDRESS=10.77.0.2' not in env_file.read_text():
  print('required variable PARSER_BIND_ADDRESS is missing',file=sys.stderr);sys.exit(1)
 if 'build' in args and os.environ.get('CAPY_FAIL_BUILD'):sys.exit(1)
 if 'stop' in args and os.environ.get('CAPY_FAIL_STOP'):sys.exit(1)
 if 'exec' in args:sys.exit(0)
 if 'ps' in args:
  if os.environ.get('CAPY_FAIL_COMPOSE_PS') and data['head']=='b'*40:sys.exit(1)
  service=args[-1]
  if service in data['running']:print(service)
 elif 'stop' in args:
  for service in args[args.index('stop')+1:]:data['running'].pop(service,None)
 elif 'up' in args:
  for service in args[args.index('up')+1:]:
   if not service.startswith('-'):data['running'][service]=os.environ['RELEASE_SHA']
 save()
"""


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="capy-release-test-")
        self.root = Path(self.temp.name)
        self.environment = "uat"
        self.repo = self.root / "app-nonprod"
        (self.repo / ".git").mkdir(parents=True)
        self.state = self.root / "releases/nonprod"
        (self.state / "active-config").mkdir(parents=True)
        (self.state / "active").write_text(PREVIOUS + "\n")
        (self.state / "active-config/nonprod.env").write_text("PARSER_TOKEN=previous\n")
        (self.state / "active-config/uat.queue.env").write_text(
            "DATABASE_URL=previous\n"
        )
        (self.state / "current").symlink_to(self.state / "active-config")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("git", "docker", "flock", "cp"):
            path = self.bin / name
            path.write_text(MOCK)
            path.chmod(0o700)
        self.consumers = [
            "worker-uat",
            "import-worker-uat",
            "parse-coordinator-uat",
            "host-sampler-uat",
        ]
        (self.root / "mock.json").write_text(
            json.dumps(
                {
                    "head": PREVIOUS,
                    "running": {
                        service: PREVIOUS for service in ["parser", *self.consumers]
                    },
                    "calls": [],
                }
            )
        )
        self.env = {
            **os.environ,
            "CAPY_INGEST_ROOT": str(self.root),
            "PATH": str(self.bin) + ":" + os.environ["PATH"],
        }

    def tearDown(self):
        self.temp.cleanup()

    def run_phase(self, phase, owner="run-1", success=True, backend=""):
        staging = ""
        if phase in ("prepare", "bootstrap-prepare"):
            staging = "/tmp/capy-release." + uuid.uuid4().hex
            Path(staging).mkdir(mode=0o700)
            Path(
                staging, "nonprod.env" if self.environment == "uat" else "prod.env"
            ).write_text("PARSER_TOKEN=candidate\nPARSER_BIND_ADDRESS=10.77.0.2\n")
            Path(staging, self.environment + ".queue.env").write_text(
                "DATABASE_URL=candidate\n"
            )
        try:
            result = subprocess.run(
                [
                    "bash",
                    str(SCRIPT),
                    phase,
                    CANDIDATE,
                    self.environment,
                    owner,
                    staging,
                    "",
                    backend,
                ],
                env=self.env,
                capture_output=True,
                check=False,
                text=True,
                timeout=15,
            )
            self.assertEqual(
                result.returncode == 0, success, result.stderr + result.stdout
            )
            return result
        finally:
            if staging:
                shutil.rmtree(staging, ignore_errors=True)

    def state_data(self):
        return json.loads((self.root / "mock.json").read_text())

    def test_prepare_blocks_other_owners_then_activates_all_consumers(self):
        self.run_phase("prepare")
        data = self.state_data()
        self.assertEqual(data["running"], {"parser": CANDIDATE})
        self.assertTrue((self.state / "pending").exists())
        self.assertTrue(
            all(
                "--profile" in call and "uat" in call
                for call in data["calls"]
                if call[0] == "compose"
            )
        )
        self.run_phase("activate", "another-run", False)
        self.run_phase("rollback-if-pending", "another-run", False)
        self.assertEqual(self.state_data()["running"], {"parser": CANDIDATE})
        self.run_phase("activate")
        self.assertEqual(
            self.state_data()["running"],
            {service: CANDIDATE for service in ["parser", *self.consumers]},
        )
        self.assertFalse((self.state / "pending").exists())
        self.assertEqual((self.state / "active").read_text().strip(), CANDIDATE)
        self.assertEqual(
            (self.state / "previous-config/uat.queue.env").read_text(),
            "DATABASE_URL=previous\n",
        )

    def test_activation_keeps_only_active_and_previous_images(self):
        stale = "c" * 40
        data = self.state_data()
        data["images"] = {
            "capy-ingest-nonprod-parser": [stale, PREVIOUS, CANDIDATE],
            "capy-ingest-nonprod-pipeline": [stale, PREVIOUS, CANDIDATE],
        }
        (self.root / "mock.json").write_text(json.dumps(data))
        self.run_phase("prepare")
        self.assertIn(stale, self.state_data()["images"]["capy-ingest-nonprod-parser"])
        self.run_phase("activate")
        self.assertEqual(
            self.state_data()["images"],
            {
                "capy-ingest-nonprod-parser": [PREVIOUS, CANDIDATE],
                "capy-ingest-nonprod-pipeline": [PREVIOUS, CANDIDATE],
            },
        )

    def test_rollback_restores_revision_and_configuration(self):
        self.run_phase("prepare")
        self.run_phase("rollback-if-pending")
        self.assertEqual(
            self.state_data()["running"],
            {service: PREVIOUS for service in ["parser", *self.consumers]},
        )
        self.assertEqual(
            (self.state / "current/nonprod.env").read_text(), "PARSER_TOKEN=previous\n"
        )
        self.assertEqual((self.state / "active").read_text().strip(), PREVIOUS)

    def test_crash_looping_parser_fails_the_wait_immediately(self):
        data = self.state_data()
        data["restarts"] = 3
        data["exit_code"] = 1
        (self.root / "mock.json").write_text(json.dumps(data))
        result = self.run_phase("prepare", success=False)
        self.assertIn("Parser restarted 3 times", result.stderr)
        self.assertIn("exit code 1", result.stderr)
        self.assertTrue((self.state / "pending").exists())

    def test_compose_query_failure_exits_without_polling(self):
        self.env["CAPY_FAIL_COMPOSE_PS"] = "1"
        result = self.run_phase("prepare", success=False)
        self.assertIn("Could not query the parser through Compose", result.stderr)
        self.assertNotIn("Waiting for", result.stdout)
        self.assertTrue((self.state / "pending").exists())

    def test_reclaim_resumes_before_old_consumers_were_stopped(self):
        self.env["CAPY_FAIL_STOP"] = "1"
        self.run_phase("prepare", success=False)
        self.assertEqual(
            self.state_data()["running"],
            {service: PREVIOUS for service in ["parser", *self.consumers]},
        )
        self.assertNotIn(
            "PARSER_BIND_ADDRESS", (self.state / "current/nonprod.env").read_text()
        )
        del self.env["CAPY_FAIL_STOP"]
        self.run_phase("reclaim", "run-2", backend=CANDIDATE)
        self.assertEqual(
            self.state_data()["running"],
            {service: CANDIDATE for service in ["parser", *self.consumers]},
        )
        self.assertEqual((self.state / "active").read_text().strip(), CANDIDATE)
        self.assertFalse((self.state / "pending").exists())
        self.assertNotIn(
            "PARSER_BIND_ADDRESS",
            (self.state / "previous-config/nonprod.env").read_text(),
        )

    def test_failed_build_restores_checkout_before_pending_exists(self):
        self.env["CAPY_FAIL_BUILD"] = "1"
        self.run_phase("prepare", success=False)
        self.assertEqual(self.state_data()["head"], PREVIOUS)
        self.assertFalse((self.state / "pending").exists())
        self.assertEqual(self.state_data()["running"]["parser"], PREVIOUS)

    def test_recovery_follows_verified_backend_revision(self):
        self.run_phase("prepare")
        self.run_phase("recover", backend="c" * 40, success=False)
        self.assertTrue((self.state / "pending").exists())
        self.run_phase("recover", backend=CANDIDATE)
        self.assertEqual(
            self.state_data()["running"],
            {service: CANDIDATE for service in ["parser", *self.consumers]},
        )

    def test_interrupted_activation_preserves_both_configs_for_rollback(self):
        self.run_phase("prepare")
        self.env["CAPY_FAIL_COMMIT"] = "1"
        self.run_phase("activate", success=False)
        self.assertTrue((self.state / "pending/previous-config/nonprod.env").exists())
        self.assertTrue((self.state / "pending/candidate-config/nonprod.env").exists())
        del self.env["CAPY_FAIL_COMMIT"]
        self.run_phase("recover", backend=PREVIOUS)
        self.assertEqual(
            self.state_data()["running"],
            {service: PREVIOUS for service in ["parser", *self.consumers]},
        )
        self.assertEqual(
            (self.state / "current/nonprod.env").read_text(), "PARSER_TOKEN=previous\n"
        )

    def test_production_uses_its_own_stack_and_all_consumers(self):
        self.environment = "production"
        self.repo.rename(self.root / "app")
        self.state.rename(self.root / "releases/production")
        self.state = self.root / "releases/production"
        (self.state / "current").unlink()
        (self.state / "current").symlink_to(self.state / "active-config")
        (self.state / "active-config/nonprod.env").rename(
            self.state / "active-config/prod.env"
        )
        (self.state / "active-config/uat.queue.env").rename(
            self.state / "active-config/production.queue.env"
        )
        self.consumers = [service.removesuffix("-uat") for service in self.consumers]
        data = self.state_data()
        data["running"] = {service: PREVIOUS for service in ["parser", *self.consumers]}
        (self.root / "mock.json").write_text(json.dumps(data))
        self.run_phase("prepare")
        self.run_phase("activate")
        data = self.state_data()
        self.assertEqual(
            data["running"],
            {service: CANDIDATE for service in ["parser", *self.consumers]},
        )
        for call in data["calls"]:
            if call[0] == "compose":
                self.assertIn("capy-ingest", call)
                self.assertNotIn("--profile", call)

    def clear_active(self):
        (self.state / "active").unlink()
        (self.state / "current").unlink()
        data = self.state_data()
        data["running"] = {}
        (self.root / "mock.json").write_text(json.dumps(data))

    def test_bootstrap_commits_only_after_activation(self):
        self.clear_active()
        self.run_phase("bootstrap-prepare")
        self.assertFalse((self.state / "active").exists())
        self.assertEqual(self.state_data()["running"], {"parser": CANDIDATE})
        self.run_phase("activate")
        self.assertEqual((self.state / "active").read_text().strip(), CANDIDATE)
        self.assertEqual(
            self.state_data()["running"],
            {service: CANDIDATE for service in ["parser", *self.consumers]},
        )

    def test_bootstrap_rollback_preserves_configuration_evidence(self):
        self.clear_active()
        self.run_phase("bootstrap-prepare")
        self.run_phase("rollback-if-pending")
        self.assertFalse((self.state / "active").exists())
        self.assertEqual(self.state_data()["running"], {})
        self.assertTrue(
            (
                self.state / "failed-bootstrap-run-1/candidate-config/uat.queue.env"
            ).exists()
        )
        self.assertFalse((self.state / "pending").exists())

    def test_reclaim_settles_a_finished_runs_release_under_its_owner(self):
        self.run_phase("prepare")
        # A normal release still needs the live backend revision.
        self.run_phase("reclaim", "run-2", success=False)
        self.assertTrue((self.state / "pending").exists())
        self.run_phase("reclaim", "run-2", backend=PREVIOUS)
        self.assertEqual(
            self.state_data()["running"],
            {service: PREVIOUS for service in ["parser", *self.consumers]},
        )
        self.assertFalse((self.state / "pending").exists())
        self.run_phase("prepare", "run-3")
        self.run_phase("reclaim", "run-4", backend=CANDIDATE)
        self.assertEqual((self.state / "active").read_text().strip(), CANDIDATE)
        self.assertEqual(
            self.state_data()["running"],
            {service: CANDIDATE for service in ["parser", *self.consumers]},
        )

    def test_reclaim_rolls_back_a_bootstrap_without_a_backend(self):
        self.clear_active()
        self.run_phase("bootstrap-prepare")
        result = self.run_phase("reclaim", "run-2")
        self.assertIn("from run run-1", result.stdout)
        self.assertEqual(self.state_data()["running"], {})
        self.assertFalse((self.state / "active").exists())
        self.assertFalse((self.state / "pending").exists())
        self.assertTrue((self.state / "failed-bootstrap-run-1").is_dir())
        result = self.run_phase("reclaim", "run-2")
        self.assertIn("No pending ingest release", result.stdout)

    def test_uat_refuses_local_consumers_without_mutating_them(self):
        data = self.state_data()
        data["local_running"] = True
        (self.root / "mock.json").write_text(json.dumps(data))
        result = self.run_phase("prepare", success=False)
        self.assertIn("stop local-profile consumers", result.stderr)
        self.assertEqual(self.state_data()["running"], data["running"])
        self.assertFalse((self.state / "pending").exists())


class WrapperTest(unittest.TestCase):
    """The wrapper hands the phase arguments to ssh, which sends them as one
    string for the remote shell to re-split. Empty values must keep their slot."""

    def test_empty_arguments_keep_the_later_positions(self):
        wrapper = SCRIPT.with_name("ingest-host-release.sh")
        with tempfile.TemporaryDirectory(prefix="capy-wrapper-test-") as temp:
            root = Path(temp)
            binaries = root / "bin"
            binaries.mkdir()
            record = root / "command"
            # Record the command string instead of contacting a host; the last
            # argument is what sshd would hand to the login shell.
            ssh = binaries / "ssh"
            ssh.write_text(
                "#!/usr/bin/env bash\nprintf '%s' \"${!#}\" > " + str(record) + "\n"
            )
            ssh.chmod(0o700)
            subprocess.run(
                [str(wrapper), "recover"],
                env={
                    **os.environ,
                    "PATH": str(binaries) + ":" + os.environ["PATH"],
                    "DEPLOY_REVISION": CANDIDATE,
                    "TARGET_ENVIRONMENT": "uat",
                    "CAPY_RELEASE_OWNER": "run-1",
                    "INGEST_HOST": "ingest.example.com",
                    "INGEST_HOST_USER": "capy-ingest",
                    "CAPY_INGEST_REPOSITORY_URL": "",
                    "CAPY_BACKEND_REVISION": PREVIOUS,
                },
                check=True,
                capture_output=True,
            )
            # shlex splits the way the remote shell does.
            argv = shlex.split(record.read_text())
            self.assertEqual(argv[:3], ["bash", "-s", "--"])
            phase = argv[3:]
            self.assertEqual(phase[0], "recover")
            self.assertEqual(phase[4], "", "staging must stay empty in slot 5")
            self.assertEqual(phase[6], PREVIOUS, "backend revision must stay in slot 7")


class WorkflowTest(unittest.TestCase):
    def test_release_tools_use_dispatch_revision_while_app_stays_pinned(self):
        steps = json.loads(
            subprocess.check_output(
                [
                    "node",
                    "--input-type=module",
                    "-e",
                    (
                        "import fs from 'node:fs'; import YAML from 'yaml'; "
                        "console.log(JSON.stringify(YAML.parse(fs.readFileSync("
                        "'.github/workflows/deploy-ingest.yml', 'utf8')).jobs.ingest.steps));"
                    ),
                ],
                cwd=SCRIPT.parents[2],
                text=True,
            )
        )
        load = next(
            s
            for s in steps
            if s.get("name") == "Load release scripts from the workflow revision"
        )
        release = next(s for s in steps if s.get("name") == "Release the ingest stack")
        with tempfile.TemporaryDirectory(prefix="capy-workflow-test-") as temp:
            root = Path(temp)

            def git(*args):
                return subprocess.check_output(
                    [
                        "git",
                        "-c",
                        "user.name=Test",
                        "-c",
                        "user.email=test@example.com",
                        "-c",
                        "commit.gpgsign=false",
                        "-c",
                        "core.hooksPath=/dev/null",
                        *args,
                    ],
                    cwd=root,
                    text=True,
                    stderr=subprocess.PIPE,
                ).strip()

            git("init", "-q")
            source = root / "scripts/deploy"
            source.mkdir(parents=True)
            wrapper = source / "ingest-host-release.sh"
            remote = source / "ingest-host-remote-release.sh"
            for path in (wrapper, remote):
                path.write_text("#!/usr/bin/env bash\nexit 99\n")
            git("add", ".")
            git("commit", "-qm", "old application release")
            app_sha = git("rev-parse", "HEAD")
            wrapper.write_text(
                '#!/usr/bin/env bash\nbash "$(dirname "$0")/ingest-host-remote-release.sh" "$@"\n'
            )
            remote.write_text(
                '#!/usr/bin/env bash\nprintf "%s %s\\n" "$1" "$DEPLOY_REVISION" >> "$CAPY_TEST_RECORD"\n'
            )
            git("add", ".")
            git("commit", "-qm", "fixed release tools")
            dispatch_sha = git("rev-parse", "HEAD")
            git("checkout", "--detach", app_sha)
            binaries = root / "bin"
            binaries.mkdir()
            python = binaries / "python3"
            python.write_text(
                '#!/usr/bin/env bash\nprintf "%s\\n" "$DEPLOY_REVISION"\n'
            )
            python.chmod(0o700)
            record = root / "phases"
            env = {
                **os.environ,
                "PATH": str(binaries) + ":" + os.environ["PATH"],
                "GITHUB_SHA": dispatch_sha,
                "DEPLOY_REVISION": app_sha,
                "RUNNER_TEMP": str(root / "runner"),
                "RECLAIM_PENDING": "true",
                "CAPY_TEST_RECORD": str(record),
            }
            env["CAPY_RELEASE_SCRIPT"] = release["env"]["CAPY_RELEASE_SCRIPT"].replace(
                "${{ runner.temp }}", env["RUNNER_TEMP"]
            )
            subprocess.run(
                ["bash", "-euo", "pipefail", "-c", load["run"]],
                cwd=root,
                env=env,
                check=True,
            )
            for bootstrap in ("false", "true"):
                with self.subTest(bootstrap=bootstrap):
                    record.write_text("")
                    subprocess.run(
                        ["bash", "-euo", "pipefail", "-c", release["run"]],
                        cwd=root,
                        env={**env, "BOOTSTRAP": bootstrap},
                        check=True,
                    )
                    prepare = "bootstrap-prepare" if bootstrap == "true" else "prepare"
                    self.assertEqual(
                        record.read_text().splitlines(),
                        [
                            f"{phase} {app_sha}"
                            for phase in ("reclaim", prepare, "activate", "recover")
                        ],
                    )
                    self.assertEqual(git("rev-parse", "HEAD"), app_sha)


if __name__ == "__main__":
    unittest.main()
