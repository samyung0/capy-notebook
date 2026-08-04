import { describe, expect, it } from 'vitest';
import { DEV_DEFAULTS, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses local-dev defaults when env is empty', () => {
    const config = loadConfig({});
    expect([...config.allowedOrigins]).toEqual([DEV_DEFAULTS.allowedOrigins]);
    expect(config.apiUrl).toBe(DEV_DEFAULTS.apiUrl);
    expect(config.databaseUrl).toBe(DEV_DEFAULTS.databaseUrl);
    expect(config.redisUrl).toBe(DEV_DEFAULTS.redisUrl);
    expect(config.secret).toBe(DEV_DEFAULTS.secret);
    expect(config.port).toBe(1234);
  });

  it('parses comma-separated allowed origins and overrides', () => {
    const config = loadConfig({
      API_URL: 'http://server:8080/',
      COLLABORATION_ALLOWED_ORIGINS:
        'https://app.example.com, http://localhost:5173',
      COLLABORATION_SECRET: 'prod-secret',
      DATABASE_URL: 'postgres://db/evo',
      PORT: '2345',
      REDIS_URL: 'redis://redis:6379/1',
    });
    expect([...config.allowedOrigins]).toEqual([
      'https://app.example.com',
      'http://localhost:5173',
    ]);
    expect(config.apiUrl).toBe('http://server:8080');
    expect(config.port).toBe(2345);
    expect(config.secret).toBe('prod-secret');
  });

  it('rejects an empty origins list', () => {
    expect(() =>
      loadConfig({ COLLABORATION_ALLOWED_ORIGINS: ' , , ' })
    ).toThrow('must contain an origin');
  });
});
