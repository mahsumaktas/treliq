/**
 * Unit tests for auth token cache and Octokit factories.
 */

const mockOctokitCtor = jest.fn().mockImplementation((opts: any) => ({
  auth: opts?.auth,
  rest: {},
  graphql: jest.fn(),
}));

const mockCreateAppAuth = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: mockOctokitCtor,
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: (...args: any[]) => mockCreateAppAuth(...args),
}));

import {
  clearAllTokenCache,
  clearTokenCache,
  createAppLevelOctokit,
  createAppOctokit,
  createPATOctokit,
} from '../../src/core/auth';

describe('auth', () => {
  const appConfig = {
    appId: 123,
    privateKey: 'test-private-key',
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    clearAllTokenCache();
  });

  describe('createPATOctokit', () => {
    it('returns an Octokit-like instance', () => {
      const octokit = createPATOctokit('test-token');
      expect(octokit).toBeDefined();
      expect(octokit.rest).toBeDefined();
      expect(mockOctokitCtor).toHaveBeenCalledWith({ auth: 'test-token' });
    });

    it('creates different instances for different tokens', () => {
      const octokit1 = createPATOctokit('token1');
      const octokit2 = createPATOctokit('token2');
      expect(octokit1).not.toBe(octokit2);
      expect(mockOctokitCtor).toHaveBeenCalledTimes(2);
    });
  });

  describe('createAppOctokit', () => {
    it('fetches installation token and caches it by installation id', async () => {
      const authFn = jest.fn().mockResolvedValue({ token: 'inst-token' });
      mockCreateAppAuth.mockReturnValue(authFn);

      await createAppOctokit(appConfig, 77);
      await createAppOctokit(appConfig, 77);

      expect(mockCreateAppAuth).toHaveBeenCalledWith({
        appId: 123,
        privateKey: 'test-private-key',
      });
      expect(authFn).toHaveBeenCalledTimes(1);
      expect(authFn).toHaveBeenCalledWith({
        type: 'installation',
        installationId: 77,
      });
      expect(mockOctokitCtor).toHaveBeenCalledWith({ auth: 'inst-token' });
    });

    it('refreshes token after cache is cleared', async () => {
      const authFn = jest.fn().mockResolvedValue({ token: 'inst-token' });
      mockCreateAppAuth.mockReturnValue(authFn);

      await createAppOctokit(appConfig, 12);
      clearTokenCache(12);
      await createAppOctokit(appConfig, 12);

      expect(authFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('createAppLevelOctokit', () => {
    it('requests app-level token', async () => {
      const authFn = jest.fn().mockResolvedValue({ token: 'app-token' });
      mockCreateAppAuth.mockReturnValue(authFn);

      await createAppLevelOctokit(appConfig);

      expect(authFn).toHaveBeenCalledWith({ type: 'app' });
      expect(mockOctokitCtor).toHaveBeenCalledWith({ auth: 'app-token' });
    });
  });

  describe('cache clear helpers', () => {
    it('clearTokenCache does not throw', () => {
      expect(() => clearTokenCache(12345)).not.toThrow();
    });

    it('clearAllTokenCache can be called multiple times', () => {
      expect(() => {
        clearAllTokenCache();
        clearAllTokenCache();
      }).not.toThrow();
    });
  });
});
