import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve(import.meta.dirname, 'validate-strix-run.mjs');

const fixture = ({
  budget = 40,
  cost = 10,
  exitCode = 2,
  findings = [],
  report = true,
  status = 'completed',
} = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'strix-result-'));
  writeFileSync(
    path.join(directory, 'run.json'),
    JSON.stringify({ llm_usage: { cost }, status })
  );
  writeFileSync(
    path.join(directory, 'vulnerabilities.json'),
    JSON.stringify(findings)
  );
  writeFileSync(path.join(directory, 'strix-exit-code.txt'), `${exitCode}\n`);
  writeFileSync(path.join(directory, 'strix-max-budget.txt'), `${budget}\n`);
  if (report) {
    writeFileSync(
      path.join(directory, 'penetration_test_report.md'),
      '# Report\n'
    );
  }
  return directory;
};

test('report-only accepts a completed run with findings', () => {
  const directory = fixture({ findings: [{ severity: 'critical' }] });
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, [script, directory])
  );
});

test('release gate rejects high and critical findings', () => {
  const directory = fixture({ findings: [{ severity: 'high' }] });
  const result = spawnSync(process.execPath, [
    script,
    directory,
    '--enforce-findings',
  ]);
  assert.equal(result.status, 2);
});

test('an incomplete scan fails even in report-only mode', () => {
  const directory = fixture({ exitCode: 0, status: 'stopped' });
  const result = spawnSync(process.execPath, [script, directory]);
  assert.equal(result.status, 1);
});

test('missing required artifacts fail closed', () => {
  const directory = fixture({ exitCode: 0, report: false });
  const result = spawnSync(process.execPath, [script, directory]);
  assert.equal(result.status, 1);
});

test('a saturated budget blocks an enforced release gate', () => {
  const directory = fixture({ budget: 40, cost: 39, exitCode: 0 });
  const result = spawnSync(process.execPath, [
    script,
    directory,
    '--enforce-findings',
  ]);
  assert.equal(result.status, 1);
});
