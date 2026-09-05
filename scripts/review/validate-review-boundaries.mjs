import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const workflowsDir = path.join(root, '.github/workflows');

/** Agent-driven scanners run locally; a workflow that invokes one is a leak. */
const AGENT_SCANNER_MARKERS = [
  'strix-scan.sh',
  'strix-agent',
  'codex-security-scan.sh',
  'codex exec',
];

const REQUIRED_STATUS_CONTEXTS = ['source/codex-security', 'uat/strix'];

function events(source, label) {
  const workflow = parse(source);
  const map = workflow?.on;
  if (!map || typeof map !== 'object') {
    throw new Error(`${label}: workflow must declare an event map`);
  }
  return Object.keys(map);
}

export function validateWorkflowIsDeterministic(source, label) {
  if (events(source, label).includes('schedule')) {
    throw new Error(`${label}: workflows must not be scheduled`);
  }
  for (const marker of AGENT_SCANNER_MARKERS) {
    if (source.includes(marker)) {
      throw new Error(
        `${label}: agent-driven scanner '${marker}' must run locally, not in Actions`
      );
    }
  }
}

export function validateCallableGate(source, label) {
  const names = events(source, label);
  if (
    !names.includes('workflow_dispatch') ||
    !names.includes('workflow_call')
  ) {
    throw new Error(
      `${label}: gate must be manually runnable and callable by deployment flows`
    );
  }
}

export function validateDeploymentWorkflows(
  uatSource,
  productionSource,
  reusableSource
) {
  const uatEvents = events(uatSource, 'deploy-uat.yml');
  if (
    !uatEvents.includes('workflow_run') ||
    !uatEvents.includes('workflow_dispatch') ||
    uatEvents.includes('push')
  ) {
    throw new Error(
      'deploy-uat.yml must run after CI or by manual dispatch only'
    );
  }
  if (!uatSource.includes('./.github/workflows/uat-quality.yml')) {
    throw new Error('deploy-uat.yml must call the reusable UAT quality gate');
  }

  const productionEvents = events(productionSource, 'promote-production.yml');
  if (productionEvents.join() !== 'workflow_dispatch') {
    throw new Error('promote-production.yml must be workflow_dispatch-only');
  }
  for (const gate of [
    './.github/workflows/uat-quality.yml',
    './.github/workflows/perf.yml',
    'scripts/review/require-statuses.sh',
    ...REQUIRED_STATUS_CONTEXTS,
    'environment_name: production',
  ]) {
    if (!productionSource.includes(gate)) {
      throw new Error(`promote-production.yml must include '${gate}'`);
    }
  }

  if (
    events(reusableSource, 'deploy-environment.yml').join() !== 'workflow_call'
  ) {
    throw new Error('deploy-environment.yml must be workflow_call-only');
  }
}

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

export function validateRepositoryBoundaries() {
  for (const file of readdirSync(workflowsDir)) {
    validateWorkflowIsDeterministic(
      readFileSync(path.join(workflowsDir, file), 'utf8'),
      file
    );
  }
  validateCallableGate(
    read('.github/workflows/uat-quality.yml'),
    'uat-quality.yml'
  );
  validateCallableGate(read('.github/workflows/perf.yml'), 'perf.yml');
  validateDeploymentWorkflows(
    read('.github/workflows/deploy-uat.yml'),
    read('.github/workflows/promote-production.yml'),
    read('.github/workflows/deploy-environment.yml')
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateRepositoryBoundaries();
  process.stdout.write('Review automation boundaries are valid.\n');
}
