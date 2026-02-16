/**
 * Unit tests for auth - token cache management
 *
 * Note: createPATOctokit / createAppOctokit require @octokit/rest (ESM),
 * which is difficult to import in a Jest/CJS context.
 * We test the token cache functions directly and mock Octokit for the rest.
 */

import { clearTokenCache, clearAllTokenCache } from '../../src/core/auth';

// Mock @octokit/rest to avoid ESM import issues
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation((opts: any) => ({
    auth: opts?.auth,
    rest: {},
    graphql: jest.fn(),
  })),
}));

describe('auth', () => {
  describe('createPATOctokit', () => {
    it('returns an Octokit-like instance', () => {
      // Re-import after mock
      const { createPATOctokit } = require('../../src/core/auth');
      const octokit = createPATOctokit('test-token');
      expect(octokit).toBeDefined();
      expect(octokit.rest).toBeDefined();
    });

    it('creates different instances for different tokens', () => {
      const { createPATOctokit } = require('../../src/core/auth');
      const octokit1 = createPATOctokit('token1');
      const octokit2 = createPATOctokit('token2');
      expect(octokit1).not.toBe(octokit2);
    });
  });

  describe('clearTokenCache', () => {
    it('does not throw when clearing cache', () => {
      expect(() => clearTokenCache(12345)).not.toThrow();
    });

    it('accepts any installation ID', () => {
      expect(() => clearTokenCache(0)).not.toThrow();
      expect(() => clearTokenCache(999999)).not.toThrow();
    });
  });

  describe('clearAllTokenCache', () => {
    it('does not throw when clearing all cache', () => {
      expect(() => clearAllTokenCache()).not.toThrow();
    });

    it('can be called multiple times', () => {
      expect(() => {
        clearAllTokenCache();
        clearAllTokenCache();
        clearAllTokenCache();
      }).not.toThrow();
    });
  });
});
