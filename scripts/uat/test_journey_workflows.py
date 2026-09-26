"""Offline checks for the UAT promotion gate and its read-only SSH routes."""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
REVISION = "a" * 40


class JourneyWorkflowsTest(unittest.TestCase):
    def test_quality_resolves_running_revision_once_for_all_jobs(self):
        result = subprocess.run(
            ["node", "--input-type=module", "-"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            input=r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
const quality = YAML.parse(fs.readFileSync('.github/workflows/uat-quality.yml', 'utf8'));
const smoke = quality.jobs.smoke;
const resolve = smoke.steps.find(s => s.id === 'resolve');
const probe = smoke.steps.find(s => s.run === 'scripts/review/remote-smoke.sh');
assert.equal(resolve.env.REQUESTED_REVISION, '${{ inputs.revision }}');
assert.equal(resolve.env.DEPLOYMENT_API_URL, probe.env.UAT_API_URL);
assert.equal(smoke.steps.filter(s => s.uses?.startsWith('actions/checkout')).at(-1).with.ref,
  '${{ steps.resolve.outputs.revision }}');
assert.equal(probe.env.EXPECTED_REVISION, '${{ steps.resolve.outputs.revision }}');
assert.equal(smoke.outputs.revision, '${{ steps.resolve.outputs.revision }}');
for (const name of ['authenticated_browser', 'critical_paths']) {
  const job = quality.jobs[name];
  assert.equal(job.needs, 'smoke');
  assert.equal(job.steps.find(s => s.uses?.startsWith('actions/checkout')).with.ref,
    '${{ needs.smoke.outputs.revision }}');
}
assert.equal(quality.jobs.critical_paths.env.EXPECTED_REVISION, '${{ needs.smoke.outputs.revision }}');
assert.equal(quality.on.workflow_call.inputs.revision.required, true);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'capy-quality-revision-'));
try {
  const python = path.join(temp, 'python3');
  fs.writeFileSync(python,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$CAPY_TEST_SHA"\nexit "$CAPY_TEST_STATUS"\n',
    { mode: 0o700 });
  const output = path.join(temp, 'output');
  const deployed = 'a'.repeat(40), requested = 'b'.repeat(40);
  for (const [input, backend, backendStatus, expected] of [
    ['', deployed, '0', deployed],
    [requested, deployed, '1', requested], // Explicit targets do not query the backend.
    ['', deployed, '1', null], // A failed lookup must not fall back to github.sha.
    ['', 'invalid', '0', null],
    ['invalid', deployed, '0', null],
  ]) {
    fs.writeFileSync(output, '');
    const run = spawnSync('bash', ['-euo', 'pipefail', '-c', resolve.run], {
      encoding: 'utf8', env: { ...process.env, PATH: `${temp}:${process.env.PATH}`,
        REQUESTED_REVISION: input, GITHUB_OUTPUT: output, GITHUB_SHA: 'c'.repeat(40),
        CAPY_TEST_SHA: backend, CAPY_TEST_STATUS: backendStatus },
    });
    assert.equal(run.status === 0, expected !== null, run.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), expected ? `revision=${expected}\n` : '');
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
""",
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_promotion_requires_journeys_and_cleanup_with_scoped_credentials(self):
        result = subprocess.run(
            ["node", "--input-type=module", "-"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            input=r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
const read = (name) => YAML.parse(fs.readFileSync(name, 'utf8'));
const quality = read('.github/workflows/uat-quality.yml');
const promotion = read('.github/workflows/promote-production.yml');
assert.equal(quality.on.workflow_dispatch.inputs.critical_paths.default, true);
assert.equal(quality.on.workflow_call.inputs.critical_paths.default, false);
assert.equal(promotion.jobs.uat_quality_gate.with.critical_paths, true);
assert(promotion.jobs.deploy_production.needs.includes('uat_quality_gate'));
const job = quality.jobs.critical_paths;
assert.equal(job.environment, 'uat');
assert.equal(job.steps.find(s => s.uses?.startsWith('actions/checkout')).with.submodules, 'recursive');
assert.equal(job.steps.find(s => s.uses?.startsWith('oven-sh/setup-bun')).with['bun-version'], '1.3.14');
assert.equal(job.steps.find(s => s.uses?.startsWith('dtolnay/rust-toolchain')).with.targets, 'wasm32-unknown-unknown');
assert(job.steps.some(s => s.uses === './vendor/betteroffice/.github/actions/wasm-toolchain'));
assert.equal(job.steps.find(s => s.uses?.startsWith('taiki-e/install-action')).with.tool, 'wasm-pack@0.15.0');
assert(job.steps.some(s => s.uses === './.github/actions/cache-betteroffice'));
const prepared = job.steps.findIndex(s => s.run === 'pnpm office:prepare');
assert(prepared > 0 && prepared < job.steps.findIndex(s => s.run === 'pnpm e2e:uat:journeys'));
assert.equal(job.steps[prepared]['timeout-minutes'], 30);
assert.equal(job['timeout-minutes'], 150);

assert.equal(job.steps.find(s => s.name?.startsWith('Clean up')).if, 'always()');
assert.equal(job.steps.find(s => s.uses?.startsWith('actions/upload-artifact')).if, 'always()');
assert(!job['continue-on-error'] && !job.steps.some(s => s['continue-on-error']));
const keys = read('deploy/env-manifest.json').keys;
for (const [key, expression] of Object.entries(job.env)) {
  const match = expression.match(/^\$\{\{ (vars|secrets)\.([A-Z0-9_]+) \}\}$/);
  if (!match) continue;
  assert.equal(key, match[2]);
  assert(keys[key].targets.includes('quality'), key);
  assert.equal(keys[key].kind, match[1] === 'vars' ? 'variable' : 'secret', key);
}
""",
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_tunnel_rejects_partial_config_and_database_route_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            env = {"PATH": os.environ["PATH"], "RUNNER_TEMP": temporary}

            def run():
                return subprocess.run(
                    ["bash", str(ROOT / "scripts/uat/journey-tunnel.sh"), "start"],
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                )

            self.assertEqual(run().returncode, 0)
            env["UAT_DB_SSH_HOST"] = "uat.example.com"
            result = run()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("UAT_DB_SSH_USER is required", result.stderr)
            env.update(
                UAT_DB_SSH_USER="verifier",
                UAT_DB_SSH_PORT="22",
                UAT_DB_SSH_PRIVATE_KEY="synthetic-key",
                UAT_DB_SSH_KNOWN_HOSTS="synthetic-host-key",
                UAT_DB_FORWARD_HOST="10.77.0.3",
                UAT_DB_FORWARD_PORT="5432",
                UAT_DB_LOCAL_PORT="15432",
                UAT_DATABASE_URL="postgres://capy_uat_verifier:synthetic@db.example.com:15432/capy",
            )
            result = run()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("must target 127.0.0.1", result.stderr)
            self.assertFalse((Path(temporary) / "uat-journey-db").exists())
            self.assertNotIn("synthetic-key", result.stderr)

    def test_image_revision_must_match_even_if_container_label_matches(self):
        script = (ROOT / "scripts/uat/verify-journey-releases.sh").read_text()
        source = script.split("<<'PY'\n", 1)[1].split("\nPY\n", 1)[0]
        state = Path("/opt/capy-ingest/releases/nonprod")
        for image_revision in (REVISION, "d" * 40):
            with self.subTest(image_revision=image_revision):

                def command(args, image_revision=image_revision, **_kwargs):
                    if args[0] == "git":
                        value = REVISION
                    elif args[1] == "ps":
                        value = "b" * 64
                    elif args[1:3] == ("image", "inspect"):
                        value = image_revision
                    else:
                        value = {
                            "{{json .Id}}": json.dumps("b" * 64),
                            "{{json .Image}}": json.dumps("sha256:" + "c" * 64),
                            '{{index .Config.Labels "org.opencontainers.image.revision"}}': REVISION,
                            "{{.State.Running}}": "true",
                            "{{.State.Health.Status}}": "healthy",
                        }[args[3]]
                    return subprocess.CompletedProcess(args, 0, value, "")

                output, errors = io.StringIO(), io.StringIO()
                with (
                    patch.object(sys, "argv", ["verify", REVISION]),
                    patch.object(Path, "read_text", return_value=REVISION),
                    patch.object(Path, "exists", return_value=False),
                    patch.object(
                        Path, "resolve", return_value=state / "config-fixture"
                    ),
                    patch.object(Path, "is_file", return_value=True),
                    patch.object(subprocess, "run", side_effect=command),
                    contextlib.redirect_stdout(output),
                    contextlib.redirect_stderr(errors),
                ):
                    if image_revision == REVISION:
                        exec(compile(source, "ingest-verification", "exec"), {})  # noqa: S102 - checked-in verifier with mocked I/O
                        self.assertEqual(
                            len(json.loads(output.getvalue())["containers"]), 5
                        )
                    else:
                        with self.assertRaises(SystemExit) as error:
                            exec(compile(source, "ingest-verification", "exec"), {})  # noqa: S102 - checked-in verifier with mocked I/O
                        self.assertEqual(error.exception.code, 1)
                        self.assertIn(
                            "not running the candidate image", errors.getvalue()
                        )


if __name__ == "__main__":
    unittest.main()
