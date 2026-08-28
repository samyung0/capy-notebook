#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? '');
const enforceFindings = process.argv.includes('--enforce-findings');

const readJson = (name) => {
  const file = path.join(directory, name);
  if (!existsSync(file)) return;
  return JSON.parse(readFileSync(file, 'utf8'));
};

const run = readJson('run.json');
const vulnerabilityDocument = readJson('vulnerabilities.json');
const exitFile = path.join(directory, 'strix-exit-code.txt');
const budgetFile = path.join(directory, 'strix-max-budget.txt');
const reportFile = path.join(directory, 'penetration_test_report.md');
const exitCode = existsSync(exitFile)
  ? Number(readFileSync(exitFile, 'utf8').trim())
  : undefined;
const maxBudget = existsSync(budgetFile)
  ? Number(readFileSync(budgetFile, 'utf8').trim())
  : undefined;
const spend = Number(run?.llm_usage?.cost);
const budgetSaturated =
  Number.isFinite(spend) &&
  Number.isFinite(maxBudget) &&
  maxBudget > 0 &&
  spend >= maxBudget * 0.95;

const collectObjects = (value, output = []) => {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, output);
  } else if (value && typeof value === 'object') {
    if ('severity' in value || 'title' in value || 'name' in value) {
      output.push(value);
    } else {
      for (const child of Object.values(value)) collectObjects(child, output);
    }
  }
  return output;
};

const findings = collectObjects(vulnerabilityDocument);
const severityCounts = {};
for (const finding of findings) {
  const severity = String(finding.severity ?? 'unknown').toLowerCase();
  severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
}

const lines = [
  '## Strix scan result',
  '',
  `- Run status: ${run?.status ?? 'missing'}`,
  `- Process exit code: ${exitCode ?? 'missing'}`,
  `- Findings parsed: ${findings.length}`,
  `- Severity counts: ${JSON.stringify(severityCounts)}`,
  `- LLM spend / maximum: ${Number.isFinite(spend) ? spend : 'unknown'} / ${Number.isFinite(maxBudget) ? maxBudget : 'unknown'}`,
  `- Budget saturation warning: ${budgetSaturated ? 'yes' : 'no'}`,
  `- Findings gate: ${enforceFindings ? 'enabled' : 'report only'}`,
];
const summary = `${lines.join('\n')}\n`;
process.stdout.write(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (run?.status !== 'completed') {
  console.error(
    'Strix did not leave a completed run.json; coverage is invalid.'
  );
  process.exit(1);
}
if (![0, 2].includes(exitCode)) {
  console.error('Strix failed or did not record a usable exit code.');
  process.exit(1);
}
if (!Array.isArray(vulnerabilityDocument) || !existsSync(reportFile)) {
  console.error(
    'Strix did not produce the required report and vulnerability index.'
  );
  process.exit(1);
}
if (budgetSaturated) {
  const message =
    'Strix spent at least 95% of its hard budget; inspect coverage and raise the budget before relying on a release gate.';
  if (enforceFindings) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
}

const blocking = (severityCounts.critical ?? 0) + (severityCounts.high ?? 0);
if (
  enforceFindings &&
  (blocking > 0 || (exitCode === 2 && findings.length === 0))
) {
  console.error(
    'The release gate found a high/critical or unparsed validated vulnerability.'
  );
  process.exit(2);
}
