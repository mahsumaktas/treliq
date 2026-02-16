/**
 * Unit tests for app-config
 */

import { getAuthMode, getAppConfig, validateConfig } from '../../src/core/app-config';

describe('app-config', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getAuthMode', () => {
    it('returns pat when no GITHUB_APP_ID', () => {
      delete process.env.GITHUB_APP_ID;
      expect(getAuthMode()).toBe('pat');
    });

    it('returns app when GITHUB_APP_ID is set', () => {
      process.env.GITHUB_APP_ID = '12345';
      expect(getAuthMode()).toBe('app');
    });
  });

  describe('getAppConfig', () => {
    it('returns null in PAT mode', () => {
      delete process.env.GITHUB_APP_ID;
      expect(getAppConfig()).toBeNull();
    });

    it('returns config in app mode with valid settings', () => {
      process.env.GITHUB_APP_ID = '12345';
      process.env.GITHUB_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----';
      process.env.GITHUB_WEBHOOK_SECRET = 'secret123';
      process.env.GITHUB_CLIENT_ID = 'client123';
      process.env.GITHUB_CLIENT_SECRET = 'secret456';

      const config = getAppConfig();
      expect(config).not.toBeNull();
      expect(config?.appId).toBe(12345);
      expect(config?.privateKey).toContain('BEGIN RSA PRIVATE KEY');
      expect(config?.webhookSecret).toBe('secret123');
      expect(config?.clientId).toBe('client123');
      expect(config?.clientSecret).toBe('secret456');
    });

    it('throws when GITHUB_APP_ID is not a number', () => {
      process.env.GITHUB_APP_ID = 'not-a-number';
      process.env.GITHUB_PRIVATE_KEY = 'key';

      expect(() => getAppConfig()).toThrow('GITHUB_APP_ID must be a valid number');
    });

    it('handles escaped newlines in private key', () => {
      process.env.GITHUB_APP_ID = '12345';
      process.env.GITHUB_PRIVATE_KEY = 'line1\\nline2\\nline3';

      const config = getAppConfig();
      expect(config?.privateKey).toBe('line1\nline2\nline3');
    });

    it('defaults webhook secret to empty string', () => {
      process.env.GITHUB_APP_ID = '12345';
      process.env.GITHUB_PRIVATE_KEY = 'test-key';
      delete process.env.GITHUB_WEBHOOK_SECRET;

      const config = getAppConfig();
      expect(config?.webhookSecret).toBe('');
    });

    it('includes optional client credentials when provided', () => {
      process.env.GITHUB_APP_ID = '12345';
      process.env.GITHUB_PRIVATE_KEY = 'test-key';
      process.env.GITHUB_CLIENT_ID = 'client123';
      process.env.GITHUB_CLIENT_SECRET = 'secret456';

      const config = getAppConfig();
      expect(config?.clientId).toBe('client123');
      expect(config?.clientSecret).toBe('secret456');
    });
  });

  describe('validateConfig', () => {
    it('returns errors in PAT mode when GITHUB_TOKEN is missing', () => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_TOKEN;

      const result = validateConfig();
      expect(result.mode).toBe('pat');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('GITHUB_TOKEN environment variable is required');
    });

    it('returns no errors in valid PAT mode', () => {
      delete process.env.GITHUB_APP_ID;
      process.env.GITHUB_TOKEN = 'ghp_test123';

      const result = validateConfig();
      expect(result.mode).toBe('pat');
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns errors in app mode with invalid config', () => {
      process.env.GITHUB_APP_ID = '12345';
      delete process.env.GITHUB_PRIVATE_KEY;
      delete process.env.GITHUB_PRIVATE_KEY_PATH;

      const result = validateConfig();
      expect(result.mode).toBe('app');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns no errors in valid app mode', () => {
      process.env.GITHUB_APP_ID = '12345';
      process.env.GITHUB_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----';

      const result = validateConfig();
      expect(result.mode).toBe('app');
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });
});
