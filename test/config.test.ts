import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const BASE_ENV = { JIRA_BASE_URL: 'https://jira.example.com', JIRA_PAT: 'secret-pat' };

describe('loadConfig', () => {
  afterEach(() => {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  it('applies documented defaults', () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg).toMatchObject({
      baseUrl: 'https://jira.example.com',
      auth: 'pat',
      pat: 'secret-pat',
      timeoutMs: 30000,
      maxRetries: 2,
      tlsRejectUnauthorized: true,
      readonly: false,
      logLevel: 'info',
    });
    expect(cfg.defaultProjectKey).toBeUndefined();
  });

  it('strips trailing slashes from the base URL', () => {
    expect(loadConfig({ ...BASE_ENV, JIRA_BASE_URL: 'https://jira.example.com//' }).baseUrl).toBe('https://jira.example.com');
  });

  it('requires JIRA_BASE_URL', () => {
    expect(() => loadConfig({ JIRA_PAT: 'x' })).toThrow(/JIRA_BASE_URL/);
  });

  it('rejects a malformed base URL', () => {
    expect(() => loadConfig({ ...BASE_ENV, JIRA_BASE_URL: 'not a url' })).toThrow(ConfigError);
  });

  it('rejects non-http(s) protocols', () => {
    expect(() => loadConfig({ ...BASE_ENV, JIRA_BASE_URL: 'ftp://jira.example.com' })).toThrow(/http/);
  });

  it('requires JIRA_PAT in pat mode', () => {
    expect(() => loadConfig({ JIRA_BASE_URL: BASE_ENV.JIRA_BASE_URL })).toThrow(/JIRA_PAT/);
  });

  it('requires username and password in basic mode', () => {
    expect(() => loadConfig({ JIRA_BASE_URL: BASE_ENV.JIRA_BASE_URL, JIRA_AUTH: 'basic' })).toThrow(/JIRA_USERNAME/);
    const cfg = loadConfig({
      JIRA_BASE_URL: BASE_ENV.JIRA_BASE_URL,
      JIRA_AUTH: 'basic',
      JIRA_USERNAME: 'user',
      JIRA_PASSWORD: 'pass',
    });
    expect(cfg.auth).toBe('basic');
    expect(cfg.username).toBe('user');
  });

  it('rejects unknown JIRA_AUTH values', () => {
    expect(() => loadConfig({ ...BASE_ENV, JIRA_AUTH: 'oauth' })).toThrow(/JIRA_AUTH/);
  });

  it('rejects non-numeric timeouts and retries', () => {
    expect(() => loadConfig({ ...BASE_ENV, JIRA_TIMEOUT_MS: 'abc' })).toThrow(/JIRA_TIMEOUT_MS/);
    expect(() => loadConfig({ ...BASE_ENV, JIRA_MAX_RETRIES: '-1' })).toThrow(/JIRA_MAX_RETRIES/);
  });

  it('parses optional settings', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      ZEPHYR_READONLY: 'true',
      ZEPHYR_DEFAULT_PROJECT_KEY: 'PROJ',
      ZEPHYR_LOG_LEVEL: 'debug',
      JIRA_TIMEOUT_MS: '1000',
      JIRA_MAX_RETRIES: '5',
    });
    expect(cfg.readonly).toBe(true);
    expect(cfg.defaultProjectKey).toBe('PROJ');
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.timeoutMs).toBe(1000);
    expect(cfg.maxRetries).toBe(5);
  });

  it('parses ZEPHYR_ALLOW_INTERNAL_API with a false default', () => {
    expect(loadConfig({ ...BASE_ENV }).allowInternalApi).toBe(false);
    expect(loadConfig({ ...BASE_ENV, ZEPHYR_ALLOW_INTERNAL_API: 'true' }).allowInternalApi).toBe(true);
    expect(() => loadConfig({ ...BASE_ENV, ZEPHYR_ALLOW_INTERNAL_API: 'да' })).toThrow(/ZEPHYR_ALLOW_INTERNAL_API/);
  });

  it('rejects invalid log levels', () => {
    expect(() => loadConfig({ ...BASE_ENV, ZEPHYR_LOG_LEVEL: 'trace' })).toThrow(/ZEPHYR_LOG_LEVEL/);
  });

  it('disables TLS verification globally only when asked to', () => {
    loadConfig({ ...BASE_ENV });
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    const cfg = loadConfig({ ...BASE_ENV, JIRA_TLS_REJECT_UNAUTHORIZED: 'false' });
    expect(cfg.tlsRejectUnauthorized).toBe(false);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('0');
  });

  it('aggregates multiple errors into one message', () => {
    try {
      loadConfig({ JIRA_AUTH: 'basic' });
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/JIRA_BASE_URL/);
      expect(message).toMatch(/JIRA_USERNAME/);
    }
  });
});
