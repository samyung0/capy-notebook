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

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): CollaborationConfig {
  const origins = required('COLLABORATION_ALLOWED_ORIGINS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error('COLLABORATION_ALLOWED_ORIGINS must contain an origin');
  }
  return {
    allowedOrigins: new Set(origins),
    apiUrl: required('API_URL').replace(TRAILING_SLASH, ''),
    compactionFloorBytes: positiveInteger(
      'COLLABORATION_COMPACTION_FLOOR_BYTES',
      256 * 1024
    ),
    compactionIdleMs: positiveInteger(
      'COLLABORATION_COMPACTION_IDLE_MS',
      60 * 60 * 1000
    ),
    compactionIntervalMs: positiveInteger(
      'COLLABORATION_COMPACTION_INTERVAL_MS',
      15 * 60 * 1000
    ),
    compactionMaxRooms: positiveInteger(
      'COLLABORATION_COMPACTION_MAX_ROOMS',
      10
    ),
    compactionMultiplier: positiveInteger(
      'COLLABORATION_COMPACTION_MULTIPLIER',
      4
    ),
    databaseUrl: required('DATABASE_URL'),
    debounceMs: positiveInteger('COLLABORATION_DEBOUNCE_MS', 2000),
    host: process.env.HOST?.trim() || '0.0.0.0',
    maxDebounceMs: positiveInteger('COLLABORATION_MAX_DEBOUNCE_MS', 10_000),
    maxPayloadBytes: positiveInteger(
      'COLLABORATION_MAX_PAYLOAD_BYTES',
      2 * 1024 * 1024
    ),
    port: positiveInteger('PORT', 1234),
    redisUrl: required('REDIS_URL'),
    secret: required('COLLABORATION_SECRET'),
  };
}
