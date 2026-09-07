import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateCallableGate,
  validateDeploymentWorkflows,
  validateRepositoryBoundaries,
  validateWorkflowIsDeterministic,
} from './validate-review-boundaries.mjs';

const uat =
  'on:\n  workflow_dispatch:\njobs:\n  gate:\n    uses: ./.github/workflows/uat-quality.yml\n';
const reusable = 'on:\n  workflow_call:\n';
const production = [
  'on:\n  workflow_dispatch:\njobs:',
  '  gate:\n    uses: ./.github/workflows/uat-quality.yml',
  '  perf:\n    uses: ./.github/workflows/perf.yml',
  '  deploy:\n    with:\n      environment_name: production\n',
].join('\n');

const SCHEDULED = /must not be scheduled/;
const RUNS_LOCALLY = /must run locally/;
const CALLABLE = /callable by deployment flows/;
const UAT_MANUAL = /deploy-uat\.yml must be workflow_dispatch-only/;
const PERF_CALL = /perf\.yml/;

test('the checked-in workflows keep agent work local and gates callable', () => {
  assert.doesNotThrow(validateRepositoryBoundaries);
});

test('a scheduled workflow is rejected', () => {
  assert.throws(
    () =>
      validateWorkflowIsDeterministic(
        'on:\n  workflow_dispatch:\n  schedule:\n    - cron: "0 0 * * *"\n',
        'bad.yml'
      ),
    SCHEDULED
  );
});

test('a workflow that runs an agent scanner is rejected', () => {
  assert.throws(
    () =>
      validateWorkflowIsDeterministic(
        'on:\n  workflow_dispatch:\njobs:\n  scan:\n    steps:\n      - run: uv tool install strix-agent==1.5.3\n',
        'bad.yml'
      ),
    RUNS_LOCALLY
  );
});

test('a gate must stay dispatchable and callable', () => {
  assert.throws(
    () => validateCallableGate('on:\n  workflow_dispatch:\n', 'perf.yml'),
    CALLABLE
  );
});

test('production promotion cannot drop a required gate', () => {
  assert.doesNotThrow(() =>
    validateDeploymentWorkflows(uat, production, reusable)
  );
  assert.throws(
    () =>
      validateDeploymentWorkflows(
        uat.replace(
          'workflow_dispatch:',
          'workflow_run:\n  workflow_dispatch:'
        ),
        production,
        reusable
      ),
    UAT_MANUAL
  );
  assert.throws(
    () =>
      validateDeploymentWorkflows(
        uat,
        production.replace('perf.yml', 'nothing.yml'),
        reusable
      ),
    PERF_CALL
  );
});
