/**
 * Incremental cache for Treliq — skips re-scanning unchanged PRs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import type { ScoredPR } from './types';

export interface CachedPR {
  updatedAt: string;
  headSha: string;
  scoredPR: Omit<ScoredPR, 'embedding'>;
}

export interface TreliqCache {
  repo: string;
  lastScan: string;
  configHash: string;
  prs: Record<string, CachedPR>;
}

/** Generate a hash of config options that affect scoring results */
export function configHash(opts: { trustContributors: boolean; providerName?: string }): string {
  const input = JSON.stringify({
    trustContributors: opts.trustContributors,
    provider: opts.providerName ?? 'none',
  });
  return createHash('md5').update(input).digest('hex').slice(0, 8);
}

export function loadCache(cacheFile: string, repo: string, hash?: string): TreliqCache | null {
  if (!existsSync(cacheFile)) return null;
  try {
    const raw = JSON.parse(readFileSync(cacheFile, 'utf-8')) as TreliqCache;
    if (raw.repo !== repo) return null;
    // Invalidate cache if config changed (backwards compatible with old caches without hash)
    if (hash && raw.configHash && raw.configHash !== hash) {
      console.error('📦 Cache invalidated (config changed)');
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function saveCache(
  cacheFile: string,
  repo: string,
  scored: ScoredPR[],
  shaMap: Map<number, string>,
  hash?: string,
): void {
  const cache: TreliqCache = {
    repo,
    lastScan: new Date().toISOString(),
    configHash: hash ?? '',
    prs: {},
  };
  for (const pr of scored) {
    const { embedding, ...rest } = pr;
    cache.prs[String(pr.number)] = {
      updatedAt: pr.updatedAt,
      headSha: shaMap.get(pr.number) ?? '',
      scoredPR: rest,
    };
  }
  writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

export interface PRListItem {
  number: number;
  updatedAt: string;
  headSha: string;
}

export function getCacheHit(cache: TreliqCache, item: PRListItem): ScoredPR | null {
  const cached = cache.prs[String(item.number)];
  if (!cached) return null;
  if (cached.updatedAt === item.updatedAt && cached.headSha === item.headSha) {
    return cached.scoredPR as ScoredPR;
  }
  return null;
}
