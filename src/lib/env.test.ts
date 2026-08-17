import { describe, expect, it } from '@jest/globals';
import { loadEnv } from './env.js';

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/budget_app',
  CORS_ORIGIN: 'http://localhost:19006',
};

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv(validEnv);

    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(env.CORS_ORIGIN).toBe(validEnv.CORS_ORIGIN);
  });

  it('defaults NODE_ENV to development and PORT to 4000 when omitted', () => {
    const env = loadEnv(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
  });

  it('coerces a numeric PORT string to a number', () => {
    const env = loadEnv({ ...validEnv, PORT: '5001' });

    expect(env.PORT).toBe(5001);
  });

  it('throws when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _DATABASE_URL, ...rest } = validEnv;

    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it('throws when DATABASE_URL is not a valid URL', () => {
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/);
  });

  it('throws when CORS_ORIGIN is missing', () => {
    const { CORS_ORIGIN: _CORS_ORIGIN, ...rest } = validEnv;

    expect(() => loadEnv(rest)).toThrow(/CORS_ORIGIN/);
  });

  it('rejects an unrecognized NODE_ENV value', () => {
    expect(() => loadEnv({ ...validEnv, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });
});
