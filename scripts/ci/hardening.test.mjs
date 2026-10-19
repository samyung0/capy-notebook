// CI and deploy configuration rules (security regressions: CI hardening):
// third-party actions pinned by commit, a limited token per workflow, secrets
// only on the steps that use them, a vulnerability job per ecosystem, and no
// workers.dev or preview URL for any Worker.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const list = (relative) => readdirSync(path.join(root, relative));

const workflowFiles = list('.github/workflows').map(
  (name) => `.github/workflows/${name}`
);
const actionFiles = list('.github/actions').map(
  (name) => `.github/actions/${name}/action.yml`
);
const workflows = workflowFiles.map((file) => [file, parse(read(file))]);

const USES = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/;
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const RELEASE_COMMENT = /^\s+# \S+$/;
const SECRET = /\bsecrets\./;
const INSTALL =
  /\b(pnpm install|npm (ci|install)|bun install|uv sync|pip install|playwright install|e2e:install)\b/;
// The wrangler files comment only on whole lines.
const LINE_COMMENT = /^\s*\/\/.*$/gm;

test('every third-party action is pinned to a commit with its release in a comment', () => {
  for (const file of [...workflowFiles, ...actionFiles]) {
    for (const line of read(file).split('\n')) {
      const match = line.match(USES);
      if (!match || match[1].startsWith('./')) continue;
      assert.match(match[1], PINNED, `${file}: ${line.trim()}`);
      assert.match(match[2], RELEASE_COMMENT, `${file}: ${line.trim()}`);
    }
  }
});

test('Dependabot bumps the pinned actions, the composite ones included', () => {
  const { updates } = parse(read('.github/dependabot.yml'));
  const actions = updates.find(
    (update) => update['package-ecosystem'] === 'github-actions'
  );
  assert.deepEqual(actions.directories, ['/', '/.github/actions/*']);
});

test('every job runs with a declared token scope', () => {
  for (const [file, workflow] of workflows) {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert(workflow.permissions || job.permissions, `${file}: ${name}`);
    }
  }
});
