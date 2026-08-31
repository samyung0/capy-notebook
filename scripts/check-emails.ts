import { execFileSync } from 'node:child_process';

// Maily source lives in emails/templates/*.json, but the API embeds prerendered
// artifacts, so a saved edit without a rebuild would otherwise ship stale mail.
const generated = [
  'server/internal/mail/templates',
  'server/internal/mail/copy_gen.go',
];

// `git diff` alone would miss a brand-new template the build script just
// added, since untracked files never show up in a diff.
const status = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all', '--', ...generated],
  { encoding: 'utf8' }
).trim();

if (status) {
  process.stderr.write(
    `Prerendered email templates are stale. Run \`pnpm email:build\` and commit the result:\n${status}\n`
  );
  process.exit(1);
}
