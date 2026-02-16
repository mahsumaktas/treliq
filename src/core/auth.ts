/**
 * Authentication Factory
 *
 * Creates Octokit instances with appropriate authentication:
 * - PAT mode: Static personal access token
 * - App mode: Installation-scoped tokens via @octokit/auth-app
 */

import { Octokit } from '@octokit/rest';
import type { GitHubAppConfig } from './app-config';

/**
 * Token cache to avoid requesting new tokens for every API call
 * Installation tokens expire after 1 hour
 */
const tokenCache = new Map<number, { token: string; expiresAt: Date }>();

/**
 * Create an Octokit instance for PAT mode
 */
export function createPATOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

/**
 * Create an Octokit instance for GitHub App mode with installation authentication
 * Uses token caching to minimize API calls
 */
export async function createAppOctokit(
  appConfig: GitHubAppConfig,
  installationId: number
): Promise<Octokit> {
  // Check cache first
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > new Date()) {
    return new Octokit({ auth: cached.token });
  }

  // Dynamic import to avoid requiring @octokit/auth-app when in PAT mode
  const { createAppAuth } = await import('@octokit/auth-app');

  const auth = createAppAuth({
    appId: appConfig.appId,
    privateKey: appConfig.privateKey,
  });

  const installationAuth = await auth({
    type: 'installation',
    installationId,
  });

  // Cache token (expires in ~1 hour, refresh 5 minutes early)
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000);
  tokenCache.set(installationId, {
    token: installationAuth.token,
    expiresAt,
  });

  return new Octokit({ auth: installationAuth.token });
}

/**
 * Create an app-level Octokit (for listing installations, not for repo operations)
 */
export async function createAppLevelOctokit(appConfig: GitHubAppConfig): Promise<Octokit> {
  const { createAppAuth } = await import('@octokit/auth-app');

  const auth = createAppAuth({
    appId: appConfig.appId,
    privateKey: appConfig.privateKey,
  });

  const appAuth = await auth({ type: 'app' });
  return new Octokit({ auth: appAuth.token });
}

/**
 * Clear cached token for an installation (e.g., on deletion)
 */
export function clearTokenCache(installationId: number): void {
  tokenCache.delete(installationId);
}

/**
 * Clear all cached tokens
 */
export function clearAllTokenCache(): void {
  tokenCache.clear();
}
