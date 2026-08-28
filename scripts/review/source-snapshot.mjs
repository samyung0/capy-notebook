#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();

const statusLines = run('git', ['status', '--short'])
  .split('\n')
  .filter(Boolean);
const files = run('git', ['ls-files']).split('\n').filter(Boolean);
const byExtension = {};
for (const file of files) {
  const extension = path.extname(file).toLowerCase() || '[none]';
  byExtension[extension] = (byExtension[extension] ?? 0) + 1;
}

const snapshot = {
  branch: run('git', ['branch', '--show-current']),
  changedPaths: statusLines.map((line) => line.slice(3)),
  commit: run('git', ['rev-parse', 'HEAD']),
  dirty: statusLines.length > 0,
  filesByExtension: Object.fromEntries(
    Object.entries(byExtension).sort((a, b) => b[1] - a[1])
  ),
  generatedAt: new Date().toISOString(),
  trackedFiles: files.length,
};

const output = process.argv[2]
  ? path.resolve(root, process.argv[2])
  : path.join(root, 'review-results', 'source-snapshot.json');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
process.stdout.write(`${output}\n`);
