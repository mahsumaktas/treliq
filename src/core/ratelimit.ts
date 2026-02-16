/**
 * RateLimitManager — Tracks GitHub API rate limits and controls request pacing
 *
 * Reads x-ratelimit-remaining and x-ratelimit-reset headers from GitHub responses
 * to intelligently throttle requests before hitting the limit.
 */

import { createLogger } from './logger';

const log = createLogger('ratelimit');

export class RateLimitManager {
  private remaining = 5000;
  private limit = 5000;
  private resetAt = 0; // Unix timestamp (seconds)
  private lastUpdated = 0;

  /**
   * Update rate limit state from GitHub API response headers.
   * Works with both REST (Octokit) and GraphQL response headers.
   */
  updateFromHeaders(headers: Record<string, string | undefined>): void {
    const remaining = headers['x-ratelimit-remaining'];
    const limit = headers['x-ratelimit-limit'];
    const reset = headers['x-ratelimit-reset'];

    if (remaining !== undefined) {
      this.remaining = parseInt(remaining, 10);
    }
    if (limit !== undefined) {
      this.limit = parseInt(limit, 10);
    }
    if (reset !== undefined) {
      this.resetAt = parseInt(reset, 10);
    }
    this.lastUpdated = Date.now();
  }

  /**
   * Wait if we're critically low on rate limit quota.
   * Pauses execution until the rate limit resets.
   */
  async waitIfNeeded(): Promise<void> {
    if (this.remaining > 100) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const waitSec = this.resetAt - nowSec;

    if (waitSec > 0 && this.remaining <= 100) {
      const waitMs = Math.min(waitSec * 1000, 60_000); // Max 60s wait
      log.warn(
        { remaining: this.remaining, limit: this.limit, waitSec: Math.ceil(waitMs / 1000) },
        'Rate limit low, waiting for reset'
      );
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  /**
   * Returns true when rate limit is getting low — callers should reduce concurrency.
   */
  shouldSlowDown(): boolean {
    return this.remaining < 500 && this.remaining > 0;
  }

  /**
   * Returns true when rate limit is critically low — callers should pause.
   */
  isCritical(): boolean {
    return this.remaining <= 100;
  }

  /**
   * Get current rate limit status for logging/display.
   */
  getStatus(): { remaining: number; limit: number; resetAt: number; usage: string } {
    const usagePct = this.limit > 0
      ? ((this.limit - this.remaining) / this.limit * 100).toFixed(1)
      : '0.0';
    return {
      remaining: this.remaining,
      limit: this.limit,
      resetAt: this.resetAt,
      usage: `${usagePct}%`,
    };
  }
}
