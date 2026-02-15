/**
 * TreliqScanner — Fetches and analyzes PRs from a GitHub repository
 *
 * TODO: Implement in v0.1
 * - Fetch open PRs via Octokit
 * - Extract PR metadata (files, CI status, commits)
 * - Pass to DedupEngine and ScoringEngine
 */

import type { TreliqConfig, PRData, TreliqResult } from './types';

export class TreliqScanner {
  private config: TreliqConfig;

  constructor(config: TreliqConfig) {
    this.config = config;
  }

  async scan(): Promise<TreliqResult> {
    // TODO: Implement
    throw new Error('Not implemented yet — v0.1 in progress');
  }

  async fetchPRs(): Promise<PRData[]> {
    // TODO: Implement with Octokit
    throw new Error('Not implemented yet');
  }
}
