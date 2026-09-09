import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { elevatedCommand } from './admin.mjs';
import { addLocalHost, hostsPath, LOCAL_HOST, updateHosts } from './hosts.mjs';

const CONFLICT = /already maps/;
const ENCODED_COMMAND = /-EncodedCommand ([A-Za-z0-9+/=]+)/;
const UNSUPPORTED = /support macOS and Windows/;

test('elevation preserves paths and literal arguments across both platforms', () => {
  const executable = "C:\\Program Files\\Epo's tools\\node.exe";
  const args = ["C:\\Capy & notes\\it's $local; (uat)\\hosts.mjs"];
  assert.deepEqual(elevatedCommand('darwin', executable, args), [
    '/usr/bin/sudo',
    [executable, ...args],
  ]);
  const [command, commandArgs] = elevatedCommand('win32', executable, args);
  assert.equal(command, 'powershell.exe');
  const outer = commandArgs.at(-1);
  assert.ok(outer.includes('-Verb RunAs'));
  assert.ok(outer.includes('-Wait -PassThru; exit $p.ExitCode'));
  const encoded = outer.match(ENCODED_COMMAND)[1];
  const inner = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(
    inner.includes(
      "& 'C:\\Program Files\\Epo''s tools\\node.exe' 'C:\\Capy & notes\\it''s $local; (uat)\\hosts.mjs'; $code = $LASTEXITCODE }"
    )
  );
  assert.ok(inner.endsWith('exit $code'));
  assert.throws(() => elevatedCommand('linux', executable, args), UNSUPPORTED);
});

test('macOS and Windows hosts files preserve content and update once', () => {
  assert.equal(hostsPath('darwin'), '/etc/hosts');
  assert.equal(
    hostsPath('win32', 'D:\\Windows'),
    'D:\\Windows\\System32\\drivers\\etc\\hosts'
  );
  for (const newline of ['\n', '\r\n']) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'capy-hosts-'));
    try {
      const file = path.join(dir, 'hosts');
      const original = `# Existing entries${newline}127.0.0.1 localhost alias${newline}`;
      writeFileSync(file, original);
      assert.equal(updateHosts(file), true);
      const updated = readFileSync(file, 'utf8');
      assert.equal(
        updated,
        `${original}127.0.0.1 ${LOCAL_HOST} # Capy local UI${newline}`
      );
      assert.equal(updateHosts(file), false);
      assert.equal(readFileSync(`${file}.capy-backup`, 'utf8'), original);
      assert.equal(readFileSync(file, 'utf8'), updated);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test('aliases and comments are parsed without masking conflicting mappings', () => {
  const existing = `127.0.0.1 alias ${LOCAL_HOST.toUpperCase()} # retained\n`;
  assert.equal(addLocalHost(existing), existing);
  assert.throws(
    () => addLocalHost(`${existing}10.0.0.1 ${LOCAL_HOST}\n`),
    CONFLICT
  );
  assert.equal(
    addLocalHost(`# ${LOCAL_HOST}`),
    `# ${LOCAL_HOST}\n127.0.0.1 ${LOCAL_HOST} # Capy local UI\n`
  );
});
