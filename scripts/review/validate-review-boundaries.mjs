import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const agentToolPattern =
  /\bstrix\b|\$review-repository|codex security|spawn[_ -]?agent/i;

function eventMap(workflow, label) {
  const events = workflow.on;
  if (!events || typeof events !== 'object') {
    throw new Error(`${label}: workflow must declare an event map`);
  }
  return events;
}

function validateDispatchOnlyWorkflow(source, label, subject) {
  const workflow = parse(source);
  const events = eventMap(workflow, label);
  const names = Object.keys(events);
  if (names.length !== 1 || names[0] !== 'workflow_dispatch') {
    throw new Error(
      `${label}: ${subject} must be workflow_dispatch-only; found ${names.join(', ')}`
    );
  }
}

export function validateManualAgentWorkflow(source, label) {
  validateDispatchOnlyWorkflow(source, label, 'agent-driven workflow');
}

export function validateManualDeterministicWorkflow(source, label) {
  validateDispatchOnlyWorkflow(source, label, 'manual deterministic workflow');
  if (agentToolPattern.test(source)) {
    throw new Error(
      `${label}: manual deterministic workflow contains an agent-driven tool`
    );
  }
}

export function validateDeterministicWorkflow(source, label) {
  const workflow = parse(source);
  const events = eventMap(workflow, label);
  if (agentToolPattern.test(source)) {
    throw new Error(
      `${label}: deterministic workflow contains an agent-driven tool`
    );
  }
  if (!Object.hasOwn(events, 'workflow_dispatch')) {
    throw new Error(
      `${label}: deterministic workflow must remain manually runnable`
    );
  }
  if (!Object.hasOwn(events, 'workflow_call')) {
    throw new Error(
      `${label}: deterministic workflow must be callable by deployment flows`
    );
  }
  if (Object.hasOwn(events, 'schedule')) {
    throw new Error(`${label}: deterministic workflow must not be scheduled`);
  }
}

export function validateDeploymentWorkflows(
  uatSource,
  productionSource,
  reusableSource
) {
  const uat = parse(uatSource);
  const uatEvents = eventMap(uat, 'deploy-uat.yml');
  if (
    !Object.hasOwn(uatEvents, 'workflow_run') ||
    !Object.hasOwn(uatEvents, 'workflow_dispatch') ||
    Object.hasOwn(uatEvents, 'push') ||
    Object.hasOwn(uatEvents, 'schedule')
  ) {
    throw new Error(
      'deploy-uat.yml must run after CI or by manual dispatch only'
    );
  }
  if (!uatSource.includes('./.github/workflows/uat-quality.yml')) {
    throw new Error('deploy-uat.yml must call the reusable UAT quality gate');
  }

  validateDispatchOnlyWorkflow(
    productionSource,
    'promote-production.yml',
    'production promotion workflow'
  );
  if (!productionSource.includes('./.github/workflows/uat-quality.yml')) {
    throw new Error(
      'promote-production.yml must call the reusable UAT quality gate'
    );
  }
  if (!productionSource.includes('environment_name: production')) {
    throw new Error(
      'promote-production.yml must deploy through the production environment'
    );
  }

  const reusable = parse(reusableSource);
  const reusableEvents = eventMap(reusable, 'deploy-environment.yml');
  const reusableNames = Object.keys(reusableEvents);
  if (reusableNames.length !== 1 || reusableNames[0] !== 'workflow_call') {
    throw new Error('deploy-environment.yml must be workflow_call-only');
  }
  if (
    agentToolPattern.test(
      `${uatSource}\n${productionSource}\n${reusableSource}`
    )
  ) {
    throw new Error('deployment workflows must not contain agent-driven tools');
  }
}

export function validateSkillMetadata(source) {
  const metadata = parse(source);
  if (metadata?.policy?.allow_implicit_invocation !== false) {
    throw new Error(
      'review-repository metadata must set policy.allow_implicit_invocation=false'
    );
  }
}

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

export function validateRepositoryBoundaries() {
  validateManualAgentWorkflow(
    read('.github/workflows/repository-review.yml'),
    'repository-review.yml'
  );
  validateManualAgentWorkflow(
    read('.github/workflows/uat-review.yml'),
    'uat-review.yml'
  );
  validateDeterministicWorkflow(
    read('.github/workflows/uat-quality.yml'),
    'uat-quality.yml'
  );
  validateManualDeterministicWorkflow(
    read('.github/workflows/perf.yml'),
    'perf.yml'
  );
  validateDeploymentWorkflows(
    read('.github/workflows/deploy-uat.yml'),
    read('.github/workflows/promote-production.yml'),
    read('.github/workflows/deploy-environment.yml')
  );
  validateSkillMetadata(
    read('.agents/skills/review-repository/agents/openai.yaml')
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  validateRepositoryBoundaries();
  process.stdout.write('Review automation boundaries are valid.\n');
}
