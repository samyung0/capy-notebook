import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APOSTROPHE = /'/g;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function psLiteral(value) {
  return `'${value.replace(APOSTROPHE, "''")}'`;
}

export function elevatedCommand(platform, executable, args) {
  if (platform === 'darwin') {
    return ['/usr/bin/sudo', [executable, ...args]];
  }
  if (platform !== 'win32') {
    throw new Error('These commands support macOS and Windows.');
  }
  // Encode the inner script so Start-Process cannot lose argument quoting.
  const script = `$ErrorActionPreference = 'Stop'; try { & ${[executable, ...args].map(psLiteral).join(' ')}; $code = $LASTEXITCODE } catch { Write-Host $_; $code = 1 }; if ($code -ne 0) { Read-Host 'Command failed. Press Enter to close' }; exit $code`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return [
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$ErrorActionPreference = 'Stop'; try { $p = Start-Process -FilePath "$PSHOME\\powershell.exe" -Verb RunAs -ArgumentList '-NoProfile -EncodedCommand ${encoded}' -Wait -PassThru; exit $p.ExitCode } catch { Write-Error $_; exit 1 }`,
    ],
  ];
}

function findCaddy() {
  const name = process.platform === 'win32' ? 'caddy.exe' : 'caddy';
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.resolve(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(
    'Install Caddy and put it on PATH. See scripts/dev/README.md.'
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    const task = process.argv[2];
    if (process.argv.length !== 3 || !['hosts', 'https'].includes(task)) {
      throw new Error('Usage: pnpm dev:hosts or pnpm dev:https');
    }
    const executable = task === 'hosts' ? process.execPath : findCaddy();
    const args =
      task === 'hosts'
        ? [path.join(scriptDir, 'hosts.mjs')]
        : ['run', '--config', path.join(scriptDir, 'Caddyfile')];
    const [command, commandArgs] = elevatedCommand(
      process.platform,
      executable,
      args
    );
    process.stdout.write(
      process.platform === 'win32'
        ? 'Approve the Windows UAC prompt. Output appears in the elevated window; stop Caddy there with Ctrl+C.\n'
        : 'Administrator privileges required. Enter your macOS password if sudo asks.\n'
    );
    const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
    if (result.error) {
      throw result.error;
    }
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
