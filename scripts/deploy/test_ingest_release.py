#!/usr/bin/env python3
"""Exercise the remote release protocol without an SSH host or Docker daemon."""

import json
import os
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
if args[0]=='inspect':
 service=args[-1]
 print(data['running'][service] if 'Labels' in args[2] else ('healthy' if 'Health' in args[2] else 'true'))
 sys.exit(0)
if args[0]=='compose':
 if 'build' in args and os.environ.get('CAPY_FAIL_BUILD'):sys.exit(1)
 if 'exec' in args:sys.exit(0)
 if 'ps' in args:
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
            ).write_text("PARSER_TOKEN=candidate\n")
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

    def test_uat_refuses_local_consumers_without_mutating_them(self):
        data = self.state_data()
        data["local_running"] = True
        (self.root / "mock.json").write_text(json.dumps(data))
        result = self.run_phase("prepare", success=False)
        self.assertIn("stop local-profile consumers", result.stderr)
        self.assertEqual(self.state_data()["running"], data["running"])
        self.assertFalse((self.state / "pending").exists())


if __name__ == "__main__":
    unittest.main()
