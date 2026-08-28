import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateDeploymentWorkflows,
  validateDeterministicWorkflow,
  validateManualAgentWorkflow,
  validateManualDeterministicWorkflow,
  validateRepositoryBoundaries,
  validateSkillMetadata,
} from './validate-review-boundaries.mjs';

const agentToolError = /agent-driven tool/;
const implicitInvocationError = /allow_implicit_invocation=false/;
const manualOnlyError = /workflow_dispatch-only/;
const noScheduleError = /must not be scheduled/;
const sharedGateError = /must call the reusable UAT quality gate/;

test('the checked-in review automation keeps agent work manual', () => {
  assert.doesNotThrow(validateRepositoryBoundaries);
});

test('scheduled agent workflow is rejected', () => {
  assert.throws(
    () =>
      validateManualAgentWorkflow(
        'on:\n  workflow_dispatch:\n  schedule:\n    - cron: "0 0 * * *"\n',
        'bad.yml'
      ),
    manualOnlyError
  );
});

test('deterministic workflow rejects embedded agent tools', () => {
  assert.throws(
    () =>
      validateDeterministicWorkflow(
        'on:\n  workflow_dispatch:\njobs:\n  scan:\n    steps:\n      - run: strix scan\n',
        'bad.yml'
      ),
    agentToolError
  );
});

test('deterministic UAT workflow cannot regain a schedule', () => {
  assert.throws(
    () =>
      validateDeterministicWorkflow(
        'on:\n  workflow_dispatch:\n  workflow_call:\n  schedule:\n    - cron: "0 0 * * *"\n',
        'bad.yml'
      ),
    noScheduleError
  );
});

test('manual performance workflow cannot regain a schedule', () => {
  assert.throws(
    () =>
      validateManualDeterministicWorkflow(
        'on:\n  workflow_dispatch:\n  schedule:\n    - cron: "0 0 * * *"\n',
        'perf.yml'
      ),
    manualOnlyError
  );
});

test('production promotion cannot bypass the shared UAT gate', () => {
  assert.throws(
    () =>
      validateDeploymentWorkflows(
        'on:\n  workflow_run:\n  workflow_dispatch:\njobs:\n  gate:\n    uses: ./.github/workflows/uat-quality.yml\n',
        'on:\n  workflow_dispatch:\njobs:\n  deploy:\n    with:\n      environment_name: production\n',
        'on:\n  workflow_call:\n'
      ),
    sharedGateError
  );
});

test('skill metadata must disable implicit invocation', () => {
  assert.throws(
    () => validateSkillMetadata('policy:\n  allow_implicit_invocation: true\n'),
    implicitInvocationError
  );
});
