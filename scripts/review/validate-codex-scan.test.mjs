import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, 'validate-codex-scan.mjs');

const fixture = ({
  findings = [],
  report = true,
  status = 'completed',
} = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'codex-scan-'));
  writeFileSync(
    path.join(directory, 'scan-manifest.json'),
    JSON.stringify({ scan: { status } })
  );
  writeFileSync(
    path.join(directory, 'findings.json'),
    JSON.stringify({ findings })
  );
  if (report) writeFileSync(path.join(directory, 'report.md'), '# Report\n');
  return directory;
};

const run = (directory) => spawnSync(process.execPath, [script, directory]);

test('a completed scan with only medium findings passes', () => {
  const directory = fixture({ findings: [{ severity: { level: 'medium' } }] });
  assert.equal(run(directory).status, 0);
});

test('high or critical findings fail the gate', () => {
  const directory = fixture({ findings: [{ severity: { level: 'High' } }] });
  assert.equal(run(directory).status, 2);
});

test('an unsealed or incomplete scan fails closed', () => {
  assert.equal(run(fixture({ status: 'running' })).status, 1);
  assert.equal(run(fixture({ report: false })).status, 1);
});
