/**
 * TreliqScanner — Fetches and analyzes PRs from a GitHub repository
 * Uses GraphQL API by default with REST fallback for optimal performance.
 */

import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import type { TreliqConfig, PRData, ScoredPR, TreliqResult, DedupCluster } from './types';
import type { LLMProvider } from './provider';
import { ScoringEngine } from './scoring';
import { DedupEngine } from './dedup';
import { VisionChecker } from './vision';
import { RetryableProvider } from './retryable-provider';
import { loadCache, saveCache, getCacheHit, configHash, type PRListItem } from './cache';
import { getReputation } from './reputation';
import { TreliqDB } from './db';
import { RateLimitManager } from './ratelimit';
import { PR_LIST_QUERY, PR_DETAILS_QUERY, SINGLE_PR_QUERY, mapGraphQLToPRData } from './graphql';
import { createLogger } from './logger';

const log = createLogger('scanner');

const ISSUE_REF_PATTERN = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|related\s+to|addresses|refs?)\s+#(\d+)/gi;
export const TEST_PATTERNS = [/test\//, /spec\//, /__test__/, /__tests__/, /\.test\./, /\.spec\./, /_test\.go$/, /Test\.java$/];
const LOOSE_ISSUE_REF = /#(\d+)/g;

/** Extract issue numbers from text using strong and loose patterns */
function extractIssueNumbers(text: string): number[] {
  const issueNumbers: number[] = [];
  for (const match of text.matchAll(ISSUE_REF_PATTERN)) {
    issueNumbers.push(parseInt(match[1], 10));
  }
  if (issueNumbers.length === 0) {
    for (const match of text.matchAll(LOOSE_ISSUE_REF)) {
      const num = parseInt(match[1], 10);
      if (num > 0 && num < 100000) issueNumbers.push(num);
    }
  }
  return issueNumbers;
}

const MERGEABLE_MAP: Record<string, PRData['mergeable']> = {
  clean: 'mergeable', unstable: 'mergeable', dirty: 'conflicting', blocked: 'mergeable',
};

export class TreliqScanner {
  private config: TreliqConfig;
  private octokit: Octokit;
  private graphqlClient: typeof graphql;
  private rateLimit: RateLimitManager;
  private wrappedProvider?: LLMProvider;
  scoring: ScoringEngine;
  public shaMap = new Map<number, string>();
  private db?: TreliqDB;

  constructor(config: TreliqConfig) {
    this.config = config;
    this.octokit = new Octokit({ auth: config.token, request: { timeout: 15000 } });
    this.graphqlClient = graphql.defaults({
      headers: { authorization: `token ${config.token}` },
    });
    this.rateLimit = new RateLimitManager();
    const wrappedProvider = config.provider ? new RetryableProvider(config.provider) : undefined;
    this.wrappedProvider = wrappedProvider;
    this.scoring = new ScoringEngine(wrappedProvider, config.trustContributors, 10);
    if (config.dbPath) {
      this.db = new TreliqDB(config.dbPath);
    }
  }

  async scan(): Promise<TreliqResult> {
    const [owner, repo] = this.config.repo.split('/');
    log.info({ repo: this.config.repo }, 'Fetching open PRs');

    // 1. Try loading cache
    const hash = configHash({
      trustContributors: this.config.trustContributors,
      providerName: this.config.provider?.name,
    });
    const cache = this.config.useCache
      ? loadCache(this.config.cacheFile, this.config.repo, hash)
      : null;
    if (cache) {
      log.info({ cached: Object.keys(cache.prs).length }, 'Cache loaded');
    }

    // 2. Fetch PR list (lightweight if using cache)
    let prs: PRData[];
    let scored: ScoredPR[] = [];
    let fromCache = 0;
    let reScored = 0;
    const shaMap = new Map<number, string>();

    // Fetch CODEOWNERS once for the repo
    const codeownersMap = await this.fetchCodeowners(owner, repo);
    if (codeownersMap.size > 0) {
      log.info({ patterns: codeownersMap.size }, 'CODEOWNERS loaded');
    }

    if (cache) {
      // Fetch lightweight list first
      const prList = await this.fetchPRList();
      log.info({ count: prList.length }, 'Found open PRs');

      // Track shas for cache saving
      for (const item of prList) shaMap.set(item.number, item.headSha);

      // Check cache for each PR
      const toFetch: number[] = [];
      for (const item of prList) {
        const cached = getCacheHit(cache, item);
        if (cached) {
          scored.push(cached);
          fromCache++;
        } else {
          toFetch.push(item.number);
        }
      }

      // Full fetch + score only changed/new PRs
      if (toFetch.length > 0) {
        log.info({ changed: toFetch.length, cached: fromCache }, 'Scoring changed/new PRs');
        const freshPRs = await this.fetchPRDetails(toFetch);
        // Assign codeowners
        for (const pr of freshPRs) {
          pr.codeowners = this.matchCodeowners(pr.changedFiles, codeownersMap);
        }
        // Fetch reputation for new authors (parallel)
        const newAuthors = [...new Set(freshPRs.map(p => p.author))];
        await this.fetchReputations(newAuthors);
        const scoredBatch = await this.scoring.scoreMany(freshPRs);
        scored.push(...scoredBatch);
        reScored += scoredBatch.length;
      } else {
        log.info({ cached: fromCache }, 'All PRs from cache, nothing to re-score');
      }
    } else {
      // No cache — full fetch (shas collected via this.shaMap in fetchPRs)
      prs = await this.fetchPRs();
      log.info({ count: prs.length }, 'Found open PRs');

      // Assign codeowners
      for (const pr of prs) {
        pr.codeowners = this.matchCodeowners(pr.changedFiles, codeownersMap);
      }

      // Fetch reputation for unique authors (parallel)
      const uniqueAuthors = [...new Set(prs.map(p => p.author))];
      log.info({ count: uniqueAuthors.length }, 'Fetching reputation for contributors');
      await this.fetchReputations(uniqueAuthors);

      const scoredBatch = await this.scoring.scoreMany(prs);
      scored.push(...scoredBatch);
      reScored += scoredBatch.length;
    }

    log.info({ cached: fromCache, reScored }, 'Scoring complete');

    // 3. Dedup + Vision — run in parallel (they are independent)
    let clusters: DedupCluster[] = [];

    const dedupPromise = (async (): Promise<DedupCluster[]> => {
      if (!this.wrappedProvider) {
        log.info('Skipping dedup (no LLM provider)');
        return [];
      }
      try {
        // Only embed PRs that don't already have embeddings (from cache)
        const needsEmbedding = scored.filter(p => !p.embedding);
        if (needsEmbedding.length < scored.length) {
          log.info({ cached: scored.length - needsEmbedding.length }, 'Skipping cached embeddings');
        }
        log.info({ count: scored.length, newEmbeddings: needsEmbedding.length }, 'Finding duplicates via embeddings');
        const dedup = new DedupEngine(
          this.config.duplicateThreshold,
          this.config.relatedThreshold,
          this.wrappedProvider,
        );
        const c = await dedup.findDuplicates(scored);
        log.info({ clusters: c.length }, 'Found duplicate clusters');
        return c;
      } catch (err: any) {
        log.warn({ err }, 'Dedup failed (skipping)');
        return [];
      }
    })();

    const visionPromise = (async () => {
      if (!this.wrappedProvider) return;
      try {
        const visionDoc = await this.fetchVisionDoc(owner, repo);
        if (visionDoc) {
          // Only check PRs that don't have vision results yet (from cache)
          const needsVision = scored.filter(p => p.visionAlignment === 'unchecked');
          if (needsVision.length < scored.length) {
            log.info({ cached: scored.length - needsVision.length }, 'Skipping cached vision results');
          }
          if (needsVision.length > 0) {
            log.info({ count: needsVision.length }, 'Checking vision alignment (parallel)');
            const vision = new VisionChecker(visionDoc, this.wrappedProvider);
            await vision.checkMany(needsVision);
          }
        } else {
          log.info('No VISION.md or ROADMAP.md found, skipping');
        }
      } catch (err: any) {
        log.warn({ err }, 'Vision check failed (skipping)');
      }
    })();

    [clusters] = await Promise.all([dedupPromise, visionPromise]);

    // Sort by score desc
    scored.sort((a, b) => b.totalScore - a.totalScore);
    const spamCount = scored.filter(p => p.isSpam).length;

    const topLine = scored.length > 0
      ? `Top PR: #${scored[0].number} (${scored[0].totalScore}/100) — ${scored[0].title}`
      : 'No PRs found';
    const summary = [
      `Scanned ${scored.length} PRs in ${this.config.repo}`,
      `${spamCount} flagged as spam`,
      `${clusters.length} duplicate clusters found`,
      topLine,
    ].join('. ');

    const result: TreliqResult = {
      repo: this.config.repo,
      scannedAt: new Date().toISOString(),
      totalPRs: scored.length,
      spamCount,
      duplicateClusters: clusters,
      rankedPRs: scored,
      summary,
    };

    // Save cache
    if (this.config.useCache) {
      // Merge shaMap from fetchPRList and fetchPRs
      for (const [k, v] of this.shaMap) shaMap.set(k, v);
      saveCache(this.config.cacheFile, this.config.repo, scored, shaMap, hash);
      log.info({ cacheFile: this.config.cacheFile }, 'Cache saved');
    }

    // Save to database
    if (this.db) {
      try {
        const repoId = this.db.upsertRepository(owner, repo);
        for (const pr of scored) {
          this.db.upsertPR(repoId, pr, hash);
        }
        this.db.recordScan(repoId, scored.length, spamCount, clusters.length, hash);
        log.info({ count: scored.length }, 'Database saved');
      } catch (err: any) {
        log.error({ err }, 'Database save failed');
      }
    }

    return result;
  }

  /** Fetch reputations for a list of authors in parallel */
  private async fetchReputations(authors: string[]): Promise<void> {
    const results = await Promise.allSettled(
      authors.map(author => getReputation(this.octokit, author))
    );
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        this.scoring.setReputation(authors[i], result.value.reputationScore);
      } else {
        log.warn({ author: authors[i], err: result.reason }, 'Failed to fetch reputation');
      }
    }
  }

  async fetchPRs(): Promise<PRData[]> {
    const [owner, repo] = this.config.repo.split('/');

    // Try GraphQL first (much more efficient)
    try {
      return await this.fetchPRsGraphQL(owner, repo);
    } catch (err: any) {
      log.warn({ err }, 'GraphQL fetch failed, falling back to REST');
      return await this.fetchPRsREST(owner, repo);
    }
  }

  /**
   * Fetch PRs via GraphQL — single query per 100 PRs (replaces 4 REST calls/PR)
   */
  private async fetchPRsGraphQL(owner: string, repo: string): Promise<PRData[]> {
    const prs: PRData[] = [];
    let after: string | null = null;

    while (prs.length < this.config.maxPRs) {
      await this.rateLimit.waitIfNeeded();

      const batchSize = Math.min(100, this.config.maxPRs - prs.length);
      const response: any = await this.graphqlClient(PR_DETAILS_QUERY, {
        owner, repo, first: batchSize, after,
      });

      // Update rate limit from response headers (if available via graphql metadata)
      const prConnection = response.repository?.pullRequests;
      if (!prConnection?.nodes || prConnection.nodes.length === 0) break;

      for (const node of prConnection.nodes) {
        if (prs.length >= this.config.maxPRs) break;

        const { pr, headSha } = mapGraphQLToPRData(node, owner, repo);
        this.shaMap.set(pr.number, headSha);
        prs.push(pr);
      }

      if (!prConnection.pageInfo.hasNextPage) break;
      after = prConnection.pageInfo.endCursor;
    }

    log.info({ count: prs.length, method: 'GraphQL' }, 'Fetched PRs');
    return prs;
  }

  /**
   * Fetch PRs via REST API — fallback when GraphQL fails.
   * Makes 4 parallel REST calls per PR (slower but proven).
   */
  private async fetchPRsREST(owner: string, repo: string): Promise<PRData[]> {
    const prs: PRData[] = [];
    let page = 1;

    while (prs.length < this.config.maxPRs) {
      await this.rateLimit.waitIfNeeded();

      const { data, headers } = await this.octokit.pulls.list({
        owner, repo, state: 'open', per_page: 100, page, sort: 'updated', direction: 'desc',
      });
      this.rateLimit.updateFromHeaders(headers as Record<string, string>);

      if (data.length === 0) break;

      for (const pr of data) {
        if (prs.length >= this.config.maxPRs) break;
        this.shaMap.set(pr.number, pr.head.sha);

        await this.rateLimit.waitIfNeeded();
        const [detailRes, filesRes, checksRes, reviewsRes] = await Promise.allSettled([
          this.octokit.pulls.get({ owner, repo, pull_number: pr.number }),
          this.octokit.pulls.listFiles({ owner, repo, pull_number: pr.number, per_page: 100 }),
          this.octokit.checks.listForRef({ owner, repo, ref: pr.head.sha }),
          this.octokit.pulls.listReviews({ owner, repo, pull_number: pr.number }),
        ]);

        let filesChanged = 0, additions = 0, deletions = 0, commits = 0, mergeableState = 'unknown', commentCount = 0;
        if (detailRes.status === 'fulfilled') {
          const d = detailRes.value.data;
          filesChanged = d.changed_files; additions = d.additions; deletions = d.deletions;
          commits = d.commits; mergeableState = d.mergeable_state ?? 'unknown'; commentCount = d.comments ?? 0;
          this.rateLimit.updateFromHeaders(detailRes.value.headers as Record<string, string>);
        }

        let changedFiles: string[] = [];
        if (filesRes.status === 'fulfilled') changedFiles = filesRes.value.data.map(f => f.filename);

        let ciStatus: PRData['ciStatus'] = 'unknown';
        if (checksRes.status === 'fulfilled') {
          const checksData = checksRes.value.data;
          if (checksData.total_count > 0) {
            const conclusions = checksData.check_runs.map(c => c.conclusion);
            if (conclusions.every(c => c === 'success')) ciStatus = 'success';
            else if (conclusions.some(c => c === 'failure')) ciStatus = 'failure';
            else ciStatus = 'pending';
          }
        } else {
          try {
            const status = await this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: pr.head.sha });
            const stateMap: Record<string, PRData['ciStatus']> = { success: 'success', failure: 'failure', pending: 'pending' };
            ciStatus = stateMap[status.data.state] ?? 'unknown';
          } catch { /* skip */ }
        }

        let reviewState: PRData['reviewState'] = 'none';
        let reviewCount = 0;
        if (reviewsRes.status === 'fulfilled') {
          const reviews = reviewsRes.value.data;
          reviewCount = reviews.length;
          const states = reviews.map(r => r.state);
          if (states.includes('APPROVED')) reviewState = 'approved';
          else if (states.includes('CHANGES_REQUESTED')) reviewState = 'changes_requested';
          else if (states.some(s => s === 'COMMENTED')) reviewState = 'commented';
        }

        const testFilesChanged = changedFiles.filter(f => TEST_PATTERNS.some(p => p.test(f)));
        const ageInDays = Math.floor((Date.now() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60 * 24));
        const mergeable: PRData['mergeable'] = MERGEABLE_MAP[mergeableState] ?? 'unknown';
        const text = `${pr.title} ${pr.body ?? ''}`;
        const issueNumbers = extractIssueNumbers(text);

        prs.push({
          number: pr.number, title: pr.title, body: pr.body ?? '',
          author: pr.user?.login ?? 'unknown', authorAssociation: pr.author_association,
          createdAt: pr.created_at, updatedAt: pr.updated_at,
          headRef: pr.head.ref, baseRef: pr.base.ref,
          filesChanged, additions, deletions, commits,
          labels: pr.labels.map(l => (typeof l === 'string' ? l : l.name ?? '')),
          ciStatus, hasIssueRef: issueNumbers.length > 0, issueNumbers,
          changedFiles, diffUrl: pr.diff_url,
          hasTests: testFilesChanged.length > 0, testFilesChanged,
          ageInDays, mergeable, reviewState, reviewCount, commentCount,
          isDraft: pr.draft ?? false,
          milestone: pr.milestone?.title ?? undefined,
          requestedReviewers: pr.requested_reviewers?.map((r: any) => r.login) ?? [],
          codeowners: [],
        });
      }
      page++;
    }
    return prs;
  }

  /**
   * Lightweight PR list fetch — only metadata needed for cache comparison
   */
  private async fetchPRList(): Promise<PRListItem[]> {
    const [owner, repo] = this.config.repo.split('/');

    // Try GraphQL first
    try {
      return await this.fetchPRListGraphQL(owner, repo);
    } catch (err: any) {
      log.warn({ err }, 'GraphQL PR list failed, falling back to REST');
      return await this.fetchPRListREST(owner, repo);
    }
  }

  private async fetchPRListGraphQL(owner: string, repo: string): Promise<PRListItem[]> {
    const items: PRListItem[] = [];
    let after: string | null = null;

    while (items.length < this.config.maxPRs) {
      await this.rateLimit.waitIfNeeded();

      const batchSize = Math.min(100, this.config.maxPRs - items.length);
      const response: any = await this.graphqlClient(PR_LIST_QUERY, {
        owner, repo, first: batchSize, after,
      });

      const prConnection = response.repository?.pullRequests;
      if (!prConnection?.nodes || prConnection.nodes.length === 0) break;

      for (const node of prConnection.nodes) {
        if (items.length >= this.config.maxPRs) break;
        items.push({
          number: node.number,
          updatedAt: node.updatedAt,
          headSha: node.headRefOid,
        });
      }

      if (!prConnection.pageInfo.hasNextPage) break;
      after = prConnection.pageInfo.endCursor;
    }

    return items;
  }

  private async fetchPRListREST(owner: string, repo: string): Promise<PRListItem[]> {
    const items: PRListItem[] = [];
    let page = 1;

    while (items.length < this.config.maxPRs) {
      await this.rateLimit.waitIfNeeded();
      const { data, headers } = await this.octokit.pulls.list({
        owner, repo, state: 'open', per_page: 100, page, sort: 'updated', direction: 'desc',
      });
      this.rateLimit.updateFromHeaders(headers as Record<string, string>);

      if (data.length === 0) break;
      for (const pr of data) {
        if (items.length >= this.config.maxPRs) break;
        items.push({ number: pr.number, updatedAt: pr.updated_at, headSha: pr.head.sha });
      }
      page++;
    }
    return items;
  }

  /**
   * Fetch full details for specific PR numbers
   */
  async fetchPRDetails(prNumbers: number[]): Promise<PRData[]> {
    const [owner, repo] = this.config.repo.split('/');

    // Try GraphQL first
    try {
      return await this.fetchPRDetailsGraphQL(owner, repo, prNumbers);
    } catch (err: any) {
      log.warn({ err }, 'GraphQL PR details failed, falling back to REST');
      return await this.fetchPRDetailsREST(owner, repo, prNumbers);
    }
  }

  /**
   * Fetch specific PR details via GraphQL (one query per PR).
   */
  private async fetchPRDetailsGraphQL(owner: string, repo: string, prNumbers: number[]): Promise<PRData[]> {
    const prs: PRData[] = [];

    for (const prNum of prNumbers) {
      try {
        await this.rateLimit.waitIfNeeded();
        const response: any = await this.graphqlClient(SINGLE_PR_QUERY, {
          owner, repo, number: prNum,
        });

        const node = response.repository?.pullRequest;
        if (!node) {
          log.warn({ pr: prNum }, 'PR not found via GraphQL');
          continue;
        }

        const { pr, headSha } = mapGraphQLToPRData(node, owner, repo);
        this.shaMap.set(pr.number, headSha);
        prs.push(pr);
      } catch (err: any) {
        log.error({ pr: prNum, err }, 'Failed to fetch PR via GraphQL');
      }
    }

    return prs;
  }

  /**
   * Fetch specific PR details via REST — fallback.
   */
  private async fetchPRDetailsREST(owner: string, repo: string, prNumbers: number[]): Promise<PRData[]> {
    const prs: PRData[] = [];

    for (const prNum of prNumbers) {
      try {
        await this.rateLimit.waitIfNeeded();
        const { data: pr, headers } = await this.octokit.pulls.get({ owner, repo, pull_number: prNum });
        this.rateLimit.updateFromHeaders(headers as Record<string, string>);

        const filesChanged = pr.changed_files;
        const additions = pr.additions;
        const deletions = pr.deletions;
        const commits = pr.commits;
        const mergeableState = pr.mergeable_state ?? 'unknown';
        const commentCount = pr.comments ?? 0;

        let changedFiles: string[] = [];
        try {
          const files = await this.octokit.pulls.listFiles({ owner, repo, pull_number: prNum, per_page: 100 });
          changedFiles = files.data.map(f => f.filename);
        } catch (err: any) {
          log.warn({ pr: prNum, err }, 'Failed to fetch files for PR');
        }

        let ciStatus: PRData['ciStatus'] = 'unknown';
        try {
          const checks = await this.octokit.checks.listForRef({ owner, repo, ref: pr.head.sha });
          if (checks.data.total_count > 0) {
            const conclusions = checks.data.check_runs.map(c => c.conclusion);
            if (conclusions.every(c => c === 'success')) ciStatus = 'success';
            else if (conclusions.some(c => c === 'failure')) ciStatus = 'failure';
            else ciStatus = 'pending';
          }
        } catch {
          try {
            const status = await this.octokit.repos.getCombinedStatusForRef({ owner, repo, ref: pr.head.sha });
            const stateMap: Record<string, PRData['ciStatus']> = { success: 'success', failure: 'failure', pending: 'pending' };
            ciStatus = stateMap[status.data.state] ?? 'unknown';
          } catch (err: any) {
            log.warn({ pr: prNum, err }, 'Failed to fetch CI status for PR');
          }
        }

        let reviewState: PRData['reviewState'] = 'none';
        let reviewCount = 0;
        try {
          const { data: reviews } = await this.octokit.pulls.listReviews({ owner, repo, pull_number: prNum });
          reviewCount = reviews.length;
          const states = reviews.map(r => r.state);
          if (states.includes('APPROVED')) reviewState = 'approved';
          else if (states.includes('CHANGES_REQUESTED')) reviewState = 'changes_requested';
          else if (states.some(s => s === 'COMMENTED')) reviewState = 'commented';
        } catch (err: any) {
          log.warn({ pr: prNum, err }, 'Failed to fetch reviews for PR');
        }

        const testFilesChanged = changedFiles.filter(f => TEST_PATTERNS.some(p => p.test(f)));
        const ageInDays = Math.floor((Date.now() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60 * 24));
        const mergeable: PRData['mergeable'] = MERGEABLE_MAP[mergeableState] ?? 'unknown';
        const text = `${pr.title} ${pr.body ?? ''}`;
        const issueNumbers = extractIssueNumbers(text);

        prs.push({
          number: pr.number, title: pr.title, body: pr.body ?? '',
          author: pr.user?.login ?? 'unknown', authorAssociation: pr.author_association,
          createdAt: pr.created_at, updatedAt: pr.updated_at,
          headRef: pr.head.ref, baseRef: pr.base.ref,
          filesChanged, additions, deletions, commits,
          labels: pr.labels.map(l => (typeof l === 'string' ? l : l.name ?? '')),
          ciStatus, hasIssueRef: issueNumbers.length > 0, issueNumbers,
          changedFiles, diffUrl: pr.diff_url,
          hasTests: testFilesChanged.length > 0, testFilesChanged,
          ageInDays, mergeable, reviewState, reviewCount, commentCount,
          isDraft: pr.draft ?? false,
          milestone: pr.milestone?.title ?? undefined,
          requestedReviewers: pr.requested_reviewers?.map((r: any) => r.login) ?? [],
          codeowners: [],
        });
      } catch (err: any) {
        log.error({ pr: prNum, err }, 'Failed to fetch PR');
      }
    }
    return prs;
  }

  /**
   * Fetch CODEOWNERS file and parse into pattern -> owners map
   */
  private async fetchCodeowners(owner: string, repo: string): Promise<Map<string, string[]>> {
    for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
      try {
        const { data } = await this.octokit.repos.getContent({ owner, repo, path });
        if ('content' in data && data.content) {
          const content = Buffer.from(data.content, 'base64').toString('utf-8');
          const map = new Map<string, string[]>();
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const [pattern, ...owners] = trimmed.split(/\s+/);
            if (pattern && owners.length > 0) {
              map.set(pattern, owners.map(o => o.replace(/^@/, '')));
            }
          }
          return map;
        }
      } catch { /* try next path */ }
    }
    return new Map();
  }

  /**
   * Match changed files against CODEOWNERS patterns and return matched owners
   */
  private matchCodeowners(changedFiles: string[], codeowners: Map<string, string[]>): string[] {
    if (codeowners.size === 0) return [];
    const owners = new Set<string>();
    for (const file of changedFiles) {
      for (const [pattern, patternOwners] of codeowners) {
        // Simple glob matching: *.ts, src/*, /docs/
        const regex = pattern
          .replace(/\./g, '\\.')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');
        if (new RegExp(regex).test(file)) {
          for (const o of patternOwners) owners.add(o);
        }
      }
    }
    return [...owners];
  }

  private async fetchVisionDoc(owner: string, repo: string): Promise<string | null> {
    for (const path of ['VISION.md', 'ROADMAP.md', 'vision.md', 'roadmap.md']) {
      try {
        const { data } = await this.octokit.repos.getContent({ owner, repo, path });
        if ('content' in data && data.content) {
          return Buffer.from(data.content, 'base64').toString('utf-8');
        }
      } catch { /* try next */ }
    }
    return null;
  }
}
