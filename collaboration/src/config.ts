export interface CollaborationConfig {
  allowedOrigins: Set<string>;
  apiUrl: string;
  compactionFloorBytes: number;
  compactionIdleMs: number;
  compactionIntervalMs: number;
  compactionMaxRooms: number;
  compactionMultiplier: number;
  databaseUrl: string;
  debounceMs: number;
  host: string;
  maxDebounceMs: number;
  maxPayloadBytes: number;
  port: number;
  redisUrl: string;
  secret: string;
}

const TRAILING_SLASH = /\/$/;

/** Local-dev defaults aligned with deploy/docker-compose.yml and the Go API. */
export const DEV_DEFAULTS = {
  allowedOrigins: 'http://localhost:5173',
  apiUrl: 'http://localhost:8080',
  databaseUrl: 'postgres://capy:capy@localhost:5432/capy?sslmode=disable',
  redisUrl: 'redis://localhost:6379/0',
  secret: 'dev-collaboration-secret',
} as const;

function optional(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string
): string {
  const value = env[name]?.trim();
  return value || fallback;
}

function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseOrigins(raw: string): Set<string> {
  const origins = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error('COLLABORATION_ALLOWED_ORIGINS must contain an origin');
  }
  return new Set(origins);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): CollaborationConfig {
  return {
    allowedOrigins: parseOrigins(
      optional(
        env,
        'COLLABORATION_ALLOWED_ORIGINS',
        DEV_DEFAULTS.allowedOrigins
      )
    ),
    apiUrl: optional(env, 'API_URL', DEV_DEFAULTS.apiUrl).replace(
      TRAILING_SLASH,
      ''
    ),
    compactionFloorBytes: positiveInteger(
      env,
      'COLLABORATION_COMPACTION_FLOOR_BYTES',
      256 * 1024
    ),
    compactionIdleMs: positiveInteger(
      env,
      'COLLABORATION_COMPACTION_IDLE_MS',
      60 * 60 * 1000
    ),
    compactionIntervalMs: positiveInteger(
      env,
      'COLLABORATION_COMPACTION_INTERVAL_MS',
      15 * 60 * 1000
    ),
    compactionMaxRooms: positiveInteger(
      env,
      'COLLABORATION_COMPACTION_MAX_ROOMS',
      10
    ),
    compactionMultiplier: positiveInteger(
      env,
      'COLLABORATION_COMPACTION_MULTIPLIER',
      4
    ),
    databaseUrl: optional(env, 'DATABASE_URL', DEV_DEFAULTS.databaseUrl),
    debounceMs: positiveInteger(env, 'COLLABORATION_DEBOUNCE_MS', 2000),
    host: env.HOST?.trim() || '0.0.0.0',
    maxDebounceMs: positiveInteger(
      env,
      'COLLABORATION_MAX_DEBOUNCE_MS',
      10_000
    ),
    maxPayloadBytes: positiveInteger(
      env,
      'COLLABORATION_MAX_PAYLOAD_BYTES',
      2 * 1024 * 1024
    ),
    port: positiveInteger(env, 'PORT', 1234),
    redisUrl: optional(env, 'REDIS_URL', DEV_DEFAULTS.redisUrl),
    secret: optional(env, 'COLLABORATION_SECRET', DEV_DEFAULTS.secret),
  };
}
