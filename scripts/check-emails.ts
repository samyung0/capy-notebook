import { execFileSync } from 'node:child_process';

const templateDir = 'server/internal/mail/templates';

// `git diff` alone would miss a brand-new template the build script just
// added, since untracked files never show up in a diff.
const status = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', templateDir],
  { encoding: 'utf8' }
).trim();

if (status) {
  process.stderr.write(
    `Prerendered email templates are stale. Run \`pnpm email:build\` and commit the result:\n${status}\n`
  );
  process.exit(1);
}
