/**
 * GitHub App Configuration
 *
 * Detects whether Treliq is running in PAT mode (personal access token)
 * or GitHub App mode (installation-based authentication).
 *
 * PAT mode: Set GITHUB_TOKEN env var (existing behavior)
 * App mode: Set GITHUB_APP_ID + GITHUB_PRIVATE_KEY env vars
 */

import { readFileSync } from 'fs';

export type AuthMode = 'pat' | 'app';

export interface GitHubAppConfig {
  appId: number;
  privateKey: string;
  webhookSecret: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Detect authentication mode based on environment variables
 */
export function getAuthMode(): AuthMode {
  return process.env.GITHUB_APP_ID ? 'app' : 'pat';
}

/**
 * Load GitHub App configuration from environment
 * Returns null if not in app mode
 */
export function getAppConfig(): GitHubAppConfig | null {
  if (getAuthMode() !== 'app') return null;

  const appId = parseInt(process.env.GITHUB_APP_ID!, 10);
  if (isNaN(appId)) {
    throw new Error('GITHUB_APP_ID must be a valid number');
  }

  // Private key can be provided directly or via file path
  let privateKey: string;
  if (process.env.GITHUB_PRIVATE_KEY) {
    privateKey = process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else if (process.env.GITHUB_PRIVATE_KEY_PATH) {
    try {
      privateKey = readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf-8');
    } catch (err: any) {
      throw new Error(`Failed to read private key from ${process.env.GITHUB_PRIVATE_KEY_PATH}: ${err.message}`);
    }
  } else {
    throw new Error('GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH is required in app mode');
  }

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || '';

  return {
    appId,
    privateKey,
    webhookSecret,
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  };
}

/**
 * Validate that all required configuration is present for the current auth mode
 */
export function validateConfig(): { mode: AuthMode; valid: boolean; errors: string[] } {
  const mode = getAuthMode();
  const errors: string[] = [];

  if (mode === 'pat') {
    if (!process.env.GITHUB_TOKEN) {
      errors.push('GITHUB_TOKEN environment variable is required');
    }
  } else {
    try {
      getAppConfig();
    } catch (err: any) {
      errors.push(err.message);
    }
  }

  return { mode, valid: errors.length === 0, errors };
}
