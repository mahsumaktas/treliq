/**
 * Unit tests for cache
 */

import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  configHash,
  loadCache,
  saveCache,
  getCacheHit,
  type TreliqCache,
  type PRListItem
} from '../../src/core/cache';
import { createScoredPR } from '../fixtures/pr-factory';

describe('cache', () => {
  const testCacheFile = join(__dirname, '..', '..', 'test-cache.json');

  beforeEach(() => {
    // Clean up test cache file if it exists
    if (existsSync(testCacheFile)) {
      unlinkSync(testCacheFile);
    }
  });

  afterEach(() => {
    // Clean up test cache file after each test
    if (existsSync(testCacheFile)) {
      unlinkSync(testCacheFile);
    }
  });

  describe('configHash', () => {
    it('generates consistent hash for same config', () => {
      const hash1 = configHash({ trustContributors: true, providerName: 'test' });
      const hash2 = configHash({ trustContributors: true, providerName: 'test' });
      expect(hash1).toBe(hash2);
    });

    it('generates different hash for different trustContributors', () => {
      const hash1 = configHash({ trustContributors: true, providerName: 'test' });
      const hash2 = configHash({ trustContributors: false, providerName: 'test' });
      expect(hash1).not.toBe(hash2);
    });

    it('generates different hash for different provider', () => {
      const hash1 = configHash({ trustContributors: true, providerName: 'provider1' });
      const hash2 = configHash({ trustContributors: true, providerName: 'provider2' });
      expect(hash1).not.toBe(hash2);
    });

    it('handles undefined provider name', () => {
      const hash = configHash({ trustContributors: true });
      expect(hash).toBeDefined();
      expect(hash.length).toBe(8);
    });

    it('generates 8-character hash', () => {
      const hash = configHash({ trustContributors: true, providerName: 'test' });
      expect(hash).toMatch(/^[a-f0-9]{8}$/);
    });
  });

  describe('loadCache', () => {
    it('returns null when cache file does not exist', () => {
      const cache = loadCache(testCacheFile, 'owner/repo');
      expect(cache).toBeNull();
    });

    it('loads valid cache file', () => {
      const testCache: TreliqCache = {
        repo: 'owner/repo',
        lastScan: '2024-01-01T00:00:00Z',
        configHash: 'abc12345',
        prs: {},
      };
      writeFileSync(testCacheFile, JSON.stringify(testCache));

      const cache = loadCache(testCacheFile, 'owner/repo', 'abc12345');
      expect(cache).not.toBeNull();
      expect(cache?.repo).toBe('owner/repo');
      expect(cache?.configHash).toBe('abc12345');
    });

    it('returns null when repo does not match', () => {
      const testCache: TreliqCache = {
        repo: 'owner/repo1',
        lastScan: '2024-01-01T00:00:00Z',
        configHash: 'abc12345',
        prs: {},
      };
      writeFileSync(testCacheFile, JSON.stringify(testCache));

      const cache = loadCache(testCacheFile, 'owner/repo2');
      expect(cache).toBeNull();
    });

    it('returns null when config hash does not match', () => {
      const testCache: TreliqCache = {
        repo: 'owner/repo',
        lastScan: '2024-01-01T00:00:00Z',
        configHash: 'abc12345',
        prs: {},
      };
      writeFileSync(testCacheFile, JSON.stringify(testCache));

      const cache = loadCache(testCacheFile, 'owner/repo', 'def67890');
      expect(cache).toBeNull();
    });

    it('handles invalid JSON gracefully', () => {
      writeFileSync(testCacheFile, 'invalid json');

      const cache = loadCache(testCacheFile, 'owner/repo');
      expect(cache).toBeNull();
    });

    it('is backwards compatible with caches without configHash', () => {
      const testCache = {
        repo: 'owner/repo',
        lastScan: '2024-01-01T00:00:00Z',
        prs: {},
      };
      writeFileSync(testCacheFile, JSON.stringify(testCache));

      const cache = loadCache(testCacheFile, 'owner/repo');
      expect(cache).not.toBeNull();
      expect(cache?.repo).toBe('owner/repo');
    });
  });

  describe('saveCache', () => {
    it('saves cache to file', () => {
      const scoredPRs = [createScoredPR({ number: 1 })];
      const shaMap = new Map([[1, 'abc123']]);

      saveCache(testCacheFile, 'owner/repo', scoredPRs, shaMap, 'hash123');

      expect(existsSync(testCacheFile)).toBe(true);
      const cache = loadCache(testCacheFile, 'owner/repo', 'hash123');
      expect(cache).not.toBeNull();
      expect(cache?.repo).toBe('owner/repo');
      expect(cache?.configHash).toBe('hash123');
    });

    it('stores PR data with embedding preserved', () => {
      const scoredPR = createScoredPR({
        number: 1,
        embedding: [1, 2, 3, 4, 5],
      });
      const shaMap = new Map([[1, 'abc123']]);

      saveCache(testCacheFile, 'owner/repo', [scoredPR], shaMap);

      const cache = loadCache(testCacheFile, 'owner/repo');
      expect(cache).not.toBeNull();
      expect(cache?.prs['1']).toBeDefined();
      expect(cache?.prs['1'].scoredPR.embedding).toEqual([1, 2, 3, 4, 5]);
    });

    it('stores headSha from shaMap', () => {
      const scoredPR = createScoredPR({ number: 1 });
      const shaMap = new Map([[1, 'abc123def456']]);

      saveCache(testCacheFile, 'owner/repo', [scoredPR], shaMap);

      const cache = loadCache(testCacheFile, 'owner/repo');
      expect(cache?.prs['1'].headSha).toBe('abc123def456');
    });

    it('handles multiple PRs', () => {
      const scoredPRs = [
        createScoredPR({ number: 1 }),
        createScoredPR({ number: 2 }),
        createScoredPR({ number: 3 }),
      ];
      const shaMap = new Map([
        [1, 'sha1'],
        [2, 'sha2'],
        [3, 'sha3'],
      ]);

      saveCache(testCacheFile, 'owner/repo', scoredPRs, shaMap);

      const cache = loadCache(testCacheFile, 'owner/repo');
      expect(Object.keys(cache?.prs ?? {})).toHaveLength(3);
    });
  });

  describe('getCacheHit', () => {
    it('returns cached PR when updatedAt and headSha match', () => {
      const scoredPR = createScoredPR({
        number: 1,
        updatedAt: '2024-01-01T00:00:00Z',
      });
      const cache: TreliqCache = {
        repo: 'owner/repo',
        lastScan: '2024-01-01T00:00:00Z',
        configHash: 'abc123',
        prs: {
          '1': {
            updatedAt: '2024-01-01T00:00:00Z',
            headSha: 'abc123',
            scoredPR: scoredPR as any,
          },
        },
      };

      const item: PRListItem = {
        number: 1,
        updatedAt: '2024-01-01T00:00:00Z',
        headSha: 'abc123',
      };

      const hit = getCacheHit(cache, item);
      expect(hit).not.toBeNull();
      expect(hit?.number).toBe(1);
    });

    it('returns null when PR not in cache', () => {
      const cache: TreliqCache = {
        repo: 'owner/repo',
        lastScan: '2024-01-01T00:00:00Z',
        configHash: 'abc123',
        prs: {},
      };

      const item: PRListItem = {
        number: 1,
        updatedAt: '2024-01-01T00:00:00Z',
        headSha: 'abc123',
      };

      const hit = getCacheHit(cache, item);
      expect(hit).toBeNull();
    });

    it('returns null when updatedAt differs', () => {
      const scoredPR = createScoredPR({ number: 1 });
      const cache: TreliqCache = {
        repo: 'owner/repo',
        lastScan: '2024-01-01T00:00:00Z',
        configHash: 'abc123',
        prs: {
          '1': {
            updatedAt: '2024-01-01T00:00:00Z',
            headSha: 'abc123',
            scoredPR: scoredPR as any,
          },
        },
      };

      const item: PRListItem = {
        number: 1,
        updatedAt: '2024-01-02T00:00:00Z', // Different date
        headSha: 'abc123',
      };

      const hit = getCacheHit(cache, item);
      expect(hit).toBeNull();
    });

    it('returns null when headSha differs', () => {
      const scoredPR = createScoredPR({ number: 1 });
      const cache: TreliqCache = {
        repo: 'owner/repo',
        lastScan: '2024-01-01T00:00:00Z',
        configHash: 'abc123',
        prs: {
          '1': {
            updatedAt: '2024-01-01T00:00:00Z',
            headSha: 'abc123',
            scoredPR: scoredPR as any,
          },
        },
      };

      const item: PRListItem = {
        number: 1,
        updatedAt: '2024-01-01T00:00:00Z',
        headSha: 'def456', // Different SHA
      };

      const hit = getCacheHit(cache, item);
      expect(hit).toBeNull();
    });
  });

  describe('expanded cache (embedding + vision)', () => {
    it('saves and restores embedding data', () => {
      const scoredPR = createScoredPR({
        number: 1,
        updatedAt: '2024-01-01T00:00:00Z',
        embedding: [0.1, 0.2, 0.3],
      });
      const shaMap = new Map([[1, 'sha1']]);

      saveCache(testCacheFile, 'owner/repo', [scoredPR], shaMap, 'hash1');
      const cache = loadCache(testCacheFile, 'owner/repo', 'hash1');
      const item: PRListItem = { number: 1, updatedAt: '2024-01-01T00:00:00Z', headSha: 'sha1' };
      const hit = getCacheHit(cache!, item);

      expect(hit?.embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('saves and restores vision data', () => {
      const scoredPR = createScoredPR({
        number: 1,
        updatedAt: '2024-01-01T00:00:00Z',
        visionAlignment: 'aligned',
        visionScore: 88,
        visionReason: 'Matches roadmap',
      });
      const shaMap = new Map([[1, 'sha1']]);

      saveCache(testCacheFile, 'owner/repo', [scoredPR], shaMap, 'hash1');
      const cache = loadCache(testCacheFile, 'owner/repo', 'hash1');
      const item: PRListItem = { number: 1, updatedAt: '2024-01-01T00:00:00Z', headSha: 'sha1' };
      const hit = getCacheHit(cache!, item);

      expect(hit?.visionAlignment).toBe('aligned');
      expect(hit?.visionScore).toBe(88);
      expect(hit?.visionReason).toBe('Matches roadmap');
    });

    it('is backwards compatible with old cache format', () => {
      const oldCache = {
        repo: 'owner/repo',
        lastScan: '2024-01-01T00:00:00Z',
        configHash: 'hash1',
        prs: {
          '1': {
            updatedAt: '2024-01-01T00:00:00Z',
            headSha: 'sha1',
            scoredPR: createScoredPR({ number: 1, updatedAt: '2024-01-01T00:00:00Z' }),
          },
        },
      };
      writeFileSync(testCacheFile, JSON.stringify(oldCache));

      const cache = loadCache(testCacheFile, 'owner/repo', 'hash1');
      const item: PRListItem = { number: 1, updatedAt: '2024-01-01T00:00:00Z', headSha: 'sha1' };
      const hit = getCacheHit(cache!, item);

      expect(hit).not.toBeNull();
      expect(hit?.embedding).toBeUndefined();
    });
  });
});
