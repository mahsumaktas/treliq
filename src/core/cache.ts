/**
 * Incremental cache for Treliq — skips re-scanning unchanged PRs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { ScoredPR } from './types';

export interface CachedPR {
  updatedAt: string;
  headSha: string;
  scoredPR: Omit<ScoredPR, 'embedding'>;
}

export interface TreliqCache {
  repo: string;
  lastScan: string;
  prs: Record<string, CachedPR>;
}

export function loadCache(cacheFile: string, repo: string): TreliqCache | null {
  if (!existsSync(cacheFile)) return null;
  try {
    const raw = JSON.parse(readFileSync(cacheFile, 'utf-8')) as TreliqCache;
    if (raw.repo !== repo) return null;
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
): void {
  const cache: TreliqCache = {
    repo,
    lastScan: new Date().toISOString(),
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
