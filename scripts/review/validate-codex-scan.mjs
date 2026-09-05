#!/usr/bin/env node
// Validate a copied Codex Security scan bundle: the manifest must be sealed as
// completed and findings.json present; any high/critical finding fails the gate.
// Exit 1 = incomplete or missing evidence, exit 2 = blocking findings.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? '');

const readJson = (name) => {
  const file = path.join(directory, name);
  if (!existsSync(file)) return;
  return JSON.parse(readFileSync(file, 'utf8'));
};

const manifest = readJson('scan-manifest.json');
const findingsDocument = readJson('findings.json');
const findings = Array.isArray(findingsDocument?.findings)
  ? findingsDocument.findings
  : null;
const status = manifest?.scan?.status ?? 'missing';

const severityCounts = {};
for (const finding of findings ?? []) {
  const level = String(finding?.severity?.level ?? 'unknown').toLowerCase();
  severityCounts[level] = (severityCounts[level] ?? 0) + 1;
}
const blocking = (severityCounts.critical ?? 0) + (severityCounts.high ?? 0);

const summary = `${status}, ${findings?.length ?? '?'} findings ${JSON.stringify(severityCounts)}`;
process.stdout.write(`Codex Security scan: ${summary}\n`);
writeFileSync(path.join(directory, 'status-description.txt'), `${summary}\n`);

if (
  status !== 'completed' ||
  !findings ||
  !existsSync(path.join(directory, 'report.md'))
) {
  console.error(
    'Codex Security did not leave a completed manifest, findings.json, and report.md; coverage is invalid.'
  );
  process.exit(1);
}
if (blocking > 0) {
  console.error(
    `Codex Security reported ${blocking} high/critical finding(s).`
  );
  process.exit(2);
}
