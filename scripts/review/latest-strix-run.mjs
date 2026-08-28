#!/usr/bin/env node

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'strix_runs');
const modifiedAfter = Number(process.argv[3] ?? 0);
let entries;
try {
  entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(root, entry.name);
      return { directory, modified: statSync(directory).mtimeMs };
    })
    .filter(({ modified }) => modified >= modifiedAfter)
    .sort((a, b) => b.modified - a.modified);
} catch {
  process.exit(1);
}

if (!entries.length) process.exit(1);
process.stdout.write(`${entries[0].directory}\n`);
