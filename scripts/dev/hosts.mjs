import { constants, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_HOST = 'local.uat.capynotebook.com';
const LINES = /\r?\n/;
const WHITESPACE = /\s+/;

export function hostsPath(platform, systemRoot) {
  if (platform === 'darwin') {
    return '/etc/hosts';
  }
  if (platform === 'win32' && systemRoot) {
    return path.win32.join(systemRoot, 'System32', 'drivers', 'etc', 'hosts');
  }
  throw new Error(
    'Supported platforms are macOS and Windows with SystemRoot set.'
  );
}

export function addLocalHost(text) {
  let present = false;
  for (const line of text.split(LINES)) {
    const [address, ...names] = line.split('#')[0].trim().split(WHITESPACE);
    if (!names.some((name) => name.toLowerCase() === LOCAL_HOST)) {
      continue;
    }
    if (address !== '127.0.0.1') {
      throw new Error(
        `${LOCAL_HOST} already maps to ${address}; resolve that entry first.`
      );
    }
    present = true;
  }
  if (present) {
    return text;
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = text && !text.endsWith('\n') ? newline : '';
  return `${text}${separator}127.0.0.1 ${LOCAL_HOST} # Capy local UI${newline}`;
}

export function updateHosts(file) {
  const before = readFileSync(file, 'utf8');
  const after = addLocalHost(before);
  if (before === after) {
    return false;
  }
  // Preserve the first backup; repeated setup must not replace it.
  try {
    copyFileSync(file, `${file}.capy-backup`, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  writeFileSync(file, after);
  return true;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    if (process.argv.length !== 2) {
      throw new Error('Usage: pnpm dev:hosts');
    }
    const file = hostsPath(process.platform, process.env.SystemRoot);
    const changed = updateHosts(file);
    process.stdout.write(
      `${LOCAL_HOST} -> 127.0.0.1 ${changed ? 'added' : 'already configured'}\n`
    );
  } catch (error) {
    console.error(error.message);
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      console.error('macOS: sudo "$(command -v node)" scripts/dev/hosts.mjs');
      console.error(
        'Windows: run pnpm dev:hosts in an Administrator PowerShell.'
      );
    }
    process.exitCode = 1;
  }
}
