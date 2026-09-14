import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Resource = {
  kind: string;
  id: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type Manifest = {
  version: 1;
  id: string;
  revision: string;
  appUrl: string;
  bucket: string;
  startedAt: string;
  resources: Resource[];
  cleanup?: { finishedAt: string; failed: string[]; retained: unknown[] };
};

export function runDirectory(id: string) {
  if (!/^[a-z0-9][a-z0-9-]{5,100}$/.test(id))
    throw new Error('Invalid UAT run ID');
  return path.resolve('e2e/uat/journey-runs', id);
}

export function readManifest(id: string): Manifest {
  const value: unknown = JSON.parse(
    readFileSync(path.join(runDirectory(id), 'manifest.json'), 'utf8')
  );
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('id' in value) ||
    value.id !== id ||
    !('resources' in value) ||
    !Array.isArray(value.resources) ||
    !('revision' in value) ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.revision) ||
    !('appUrl' in value) ||
    typeof value.appUrl !== 'string' ||
    !('bucket' in value) ||
    typeof value.bucket !== 'string' ||
    !('startedAt' in value) ||
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    value.resources.some(
      (resource: unknown) =>
        !resource ||
        typeof resource !== 'object' ||
        !('kind' in resource) ||
        typeof resource.kind !== 'string' ||
        !/^[a-z][a-z-]*$/.test(resource.kind) ||
        !('id' in resource) ||
        typeof resource.id !== 'string' ||
        !resource.id ||
        /[\r\n\0]/.test(resource.id) ||
        !('details' in resource) ||
        !resource.details ||
        typeof resource.details !== 'object' ||
        Array.isArray(resource.details) ||
        !('createdAt' in resource) ||
        typeof resource.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(resource.createdAt))
    )
  ) {
    throw new Error('Invalid UAT resource manifest');
  }
  return value as Manifest;
}

export function writeManifest(manifest: Manifest) {
  const directory = runDirectory(manifest.id);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const destination = path.join(directory, 'manifest.json');
  writeFileSync(`${destination}.tmp`, JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  renameSync(`${destination}.tmp`, destination);
}

export function writeEvidence(id: string, name: string, data: unknown) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name))
    throw new Error('Invalid UAT evidence name');
  const directory = path.join(runDirectory(id), 'evidence');
  mkdirSync(directory, { mode: 0o700, recursive: true });
  const destination = path.join(directory, `${name}-${randomUUID()}.json`);
  writeFileSync(destination, JSON.stringify(sanitize(data), null, 2), {
    mode: 0o600,
  });
  return destination;
}

export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/password|token|secret|authorization|cookie|signed.?url/i.test(key)
        )
        .map(([key, item]) => [key, sanitize(item)])
    );
  }
  if (
    typeof value === 'string' &&
    /(?:sk_(?:live|test)_|Bearer\s|X-Amz-(?:Credential|Signature)=)/i.test(
      value
    )
  )
    return '[redacted]';
  return value;
}

export function verify<T>(request: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'uv',
      ['run', '--frozen', 'python', 'e2e/uat/journeys/verify.py'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let output = '';
    let errorOutput = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      errorOutput += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          new Error(
            errorOutput.includes('UAT verifier failed')
              ? errorOutput.trim()
              : 'UAT verifier process failed; verify uv and Python dependencies'
          )
        );
      try {
        resolve(JSON.parse(output) as T);
      } catch {
        reject(new Error('UAT verifier returned invalid JSON'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function poll<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 90_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  throw new Error(
    `${label} did not converge: ${JSON.stringify(sanitize(value)).slice(0, 1500)}`
  );
}
