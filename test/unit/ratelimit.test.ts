/**
 * Unit tests for RateLimitManager
 */

import { RateLimitManager } from '../../src/core/ratelimit';

describe('RateLimitManager', () => {
  let manager: RateLimitManager;

  beforeEach(() => {
    manager = new RateLimitManager();
  });

  describe('updateFromHeaders', () => {
    it('parses rate limit headers correctly', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '4500',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '1234567890',
      });

      const status = manager.getStatus();
      expect(status.remaining).toBe(4500);
      expect(status.limit).toBe(5000);
      expect(status.resetAt).toBe(1234567890);
    });

    it('handles missing headers gracefully', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '3000',
      });

      const status = manager.getStatus();
      expect(status.remaining).toBe(3000);
      // Default values should remain
      expect(status.limit).toBe(5000);
    });

    it('handles undefined headers', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': undefined,
      });

      const status = manager.getStatus();
      // Should retain default values
      expect(status.remaining).toBe(5000);
    });
  });

  describe('shouldSlowDown', () => {
    it('returns true when remaining < 500', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '400',
        'x-ratelimit-limit': '5000',
      });

      expect(manager.shouldSlowDown()).toBe(true);
    });

    it('returns false when remaining >= 500', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '1000',
        'x-ratelimit-limit': '5000',
      });

      expect(manager.shouldSlowDown()).toBe(false);
    });

    it('returns false when remaining is 0', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-limit': '5000',
      });

      expect(manager.shouldSlowDown()).toBe(false);
    });
  });

  describe('isCritical', () => {
    it('returns true when remaining <= 100', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '50',
        'x-ratelimit-limit': '5000',
      });

      expect(manager.isCritical()).toBe(true);
    });

    it('returns false when remaining > 100', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '150',
        'x-ratelimit-limit': '5000',
      });

      expect(manager.isCritical()).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('calculates usage percentage correctly', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '3000',
        'x-ratelimit-limit': '5000',
      });

      const status = manager.getStatus();
      expect(status.usage).toBe('40.0%'); // (5000 - 3000) / 5000 * 100
    });

    it('handles zero limit correctly', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-limit': '0',
      });

      const status = manager.getStatus();
      expect(status.usage).toBe('0.0%');
    });

    it('returns all status fields', () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '2500',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '1234567890',
      });

      const status = manager.getStatus();
      expect(status).toHaveProperty('remaining');
      expect(status).toHaveProperty('limit');
      expect(status).toHaveProperty('resetAt');
      expect(status).toHaveProperty('usage');
    });
  });

  describe('waitIfNeeded', () => {
    it('resolves immediately when remaining > 100', async () => {
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '500',
        'x-ratelimit-limit': '5000',
      });

      const start = Date.now();
      await manager.waitIfNeeded();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50); // Should be nearly instant
    });

    it('waits when remaining <= 100', async () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 1; // 1 second in future
      manager.updateFromHeaders({
        'x-ratelimit-remaining': '50',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': futureTimestamp.toString(),
      });

      const start = Date.now();
      await manager.waitIfNeeded();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(900); // Should wait ~1 second
      expect(elapsed).toBeLessThan(1500); // But not much more
    });
  });
});
