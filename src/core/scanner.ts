/**
 * TreliqScanner — Fetches and analyzes PRs from a GitHub repository
 */

import { Octokit } from '@octokit/rest';
import type { TreliqConfig, PRData, ScoredPR, TreliqResult, DedupCluster } from './types';
import { ScoringEngine } from './scoring';
import { DedupEngine } from './dedup';
import { VisionChecker } from './vision';
import { loadCache, saveCache, getCacheHit, configHash, type PRListItem } from './cache';
import { getReputation } from './reputation';

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
  private scoring: ScoringEngine;
  public shaMap = new Map<number, string>();

  constructor(config: TreliqConfig) {
    this.config = config;
    this.octokit = new Octokit({ auth: config.token, request: { timeout: 15000 } });
    this.scoring = new ScoringEngine(config.provider, config.trustContributors);
  }

  async scan(): Promise<TreliqResult> {
    const [owner, repo] = this.config.repo.split('/');
    console.error(`📡 Fetching open PRs from ${this.config.repo}...`);

    // 1. Try loading cache
    const hash = configHash({
      trustContributors: this.config.trustContributors,
      providerName: this.config.provider?.name,
    });
    const cache = this.config.useCache
      ? loadCache(this.config.cacheFile, this.config.repo, hash)
      : null;
    if (cache) {
      console.error(`📦 Cache loaded (${Object.keys(cache.prs).length} PRs cached)`);
    }

    // 2. Fetch PR list (lightweight if using cache)
    let prs: PRData[];
    let scored: ScoredPR[] = [];
    let fromCache = 0;
    let reScored = 0;
    const shaMap = new Map<number, string>();

    if (cache) {
      // Fetch lightweight list first
      const prList = await this.fetchPRList();
      console.error(`   Found ${prList.length} open PRs`);

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
        console.error(`📊 Scoring ${toFetch.length} changed/new PRs (${fromCache} from cache)...`);
        const freshPRs = await this.fetchPRDetails(toFetch);
        // Fetch reputation for new authors (parallel)
        const newAuthors = [...new Set(freshPRs.map(p => p.author))];
        await this.fetchReputations(newAuthors);
        for (const pr of freshPRs) {
          scored.push(await this.scoring.score(pr));
          reScored++;
        }
      } else {
        console.error(`📊 All ${fromCache} PRs from cache, nothing to re-score`);
      }
    } else {
      // No cache — full fetch (shas collected via this.shaMap in fetchPRs)
      prs = await this.fetchPRs();
      console.error(`   Found ${prs.length} open PRs`);

      // Fetch reputation for unique authors (parallel)
      const uniqueAuthors = [...new Set(prs.map(p => p.author))];
      console.error(`👤 Fetching reputation for ${uniqueAuthors.length} contributors...`);
      await this.fetchReputations(uniqueAuthors);

      console.error('📊 Scoring PRs...');
      for (const pr of prs) {
        scored.push(await this.scoring.score(pr));
        reScored++;
      }
    }

    console.error(`   ✅ ${fromCache} PRs from cache, ${reScored} PRs re-scored`);

    // 3. Dedup
    let clusters: DedupCluster[] = [];
    if (this.config.provider) {
      try {
        console.error('🔍 Finding duplicates via embeddings...');
        const dedup = new DedupEngine(
          this.config.duplicateThreshold,
          this.config.relatedThreshold,
          this.config.provider,
        );
        clusters = await dedup.findDuplicates(scored);
        console.error(`   Found ${clusters.length} duplicate clusters`);
      } catch (err: any) {
        console.error(`⚠️  Dedup failed (skipping): ${err.message}`);
      }
    } else {
      console.error('⏭️  Skipping dedup (no LLM provider)');
    }

    // 4. Vision check
    if (this.config.provider) {
      try {
        console.error('🔭 Checking vision alignment...');
        const visionDoc = await this.fetchVisionDoc(owner, repo);
        if (visionDoc) {
          const vision = new VisionChecker(visionDoc, this.config.provider);
          for (const pr of scored) {
            try {
              const result = await vision.check(pr);
              pr.visionAlignment = result.alignment;
              pr.visionScore = result.score;
              pr.visionReason = result.reason;
            } catch (err: any) {
              console.warn(`⚠️  Vision check failed for PR #${pr.number}: ${err.message}`);
              pr.visionAlignment = 'unchecked';
            }
          }
        } else {
          console.error('   No VISION.md or ROADMAP.md found, skipping');
        }
      } catch (err: any) {
        console.error(`⚠️  Vision check failed (skipping): ${err.message}`);
      }
    }

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
      console.error(`💾 Cache saved to ${this.config.cacheFile}`);
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
        console.warn(`⚠️  Failed to fetch reputation for ${authors[i]}: ${result.reason}`);
      }
    }
  }

  async fetchPRs(): Promise<PRData[]> {
    const [owner, repo] = this.config.repo.split('/');
    const prs: PRData[] = [];
    let page = 1;

    while (prs.length < this.config.maxPRs) {
      const { data } = await this.octokit.pulls.list({
        owner, repo,
        state: 'open',
        per_page: 100,
        page,
        sort: 'updated',
        direction: 'desc',
      });

      if (data.length === 0) break;

      for (const pr of data) {
        if (prs.length >= this.config.maxPRs) break;

        // Track sha for cache
        this.shaMap.set(pr.number, pr.head.sha);

        // Fetch details in parallel: detail, files, checks, reviews
        const [detailRes, filesRes, checksRes, reviewsRes] = await Promise.allSettled([
          this.octokit.pulls.get({ owner, repo, pull_number: pr.number }),
          this.octokit.pulls.listFiles({ owner, repo, pull_number: pr.number, per_page: 100 }),
          this.octokit.checks.listForRef({ owner, repo, ref: pr.head.sha }),
          this.octokit.pulls.listReviews({ owner, repo, pull_number: pr.number }),
        ]);

        // Extract detail
        let filesChanged = 0;
        let additions = 0;
        let deletions = 0;
        let commits = 0;
        let mergeableState = 'unknown';
        let commentCount = 0;
        if (detailRes.status === 'fulfilled') {
          const d = detailRes.value.data;
          filesChanged = d.changed_files;
          additions = d.additions;
          deletions = d.deletions;
          commits = d.commits;
          mergeableState = d.mergeable_state ?? 'unknown';
          commentCount = d.comments ?? 0;
        } else {
          console.warn(`⚠️  Failed to fetch details for PR #${pr.number}: ${detailRes.reason}`);
        }

        // Extract files
        let changedFiles: string[] = [];
        if (filesRes.status === 'fulfilled') {
          changedFiles = filesRes.value.data.map(f => f.filename);
        } else {
          console.warn(`⚠️  Failed to fetch files for PR #${pr.number}: ${filesRes.reason}`);
        }

        // Extract CI status
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
          // Try commit status as fallback
          try {
            const status = await this.octokit.repos.getCombinedStatusForRef({
              owner, repo, ref: pr.head.sha,
            });
            const stateMap: Record<string, PRData['ciStatus']> = {
              success: 'success', failure: 'failure', pending: 'pending',
            };
            ciStatus = stateMap[status.data.state] ?? 'unknown';
          } catch (err: any) {
            console.warn(`⚠️  Failed to fetch CI status for PR #${pr.number}: ${err.message}`);
          }
        }

        // Extract reviews
        let reviewState: PRData['reviewState'] = 'none';
        let reviewCount = 0;
        if (reviewsRes.status === 'fulfilled') {
          const reviews = reviewsRes.value.data;
          reviewCount = reviews.length;
          const states = reviews.map(r => r.state);
          if (states.includes('APPROVED')) reviewState = 'approved';
          else if (states.includes('CHANGES_REQUESTED')) reviewState = 'changes_requested';
          else if (states.some(s => s === 'COMMENTED')) reviewState = 'commented';
        } else {
          console.warn(`⚠️  Failed to fetch reviews for PR #${pr.number}: ${reviewsRes.reason}`);
        }

        // Test detection
        const testFilesChanged = changedFiles.filter(f => TEST_PATTERNS.some(p => p.test(f)));
        const hasTests = testFilesChanged.length > 0;

        // Age
        const ageInDays = Math.floor((Date.now() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60 * 24));

        // Mergeable
        const mergeable: PRData['mergeable'] = MERGEABLE_MAP[mergeableState] ?? 'unknown';

        // Issue references
        const text = `${pr.title} ${pr.body ?? ''}`;
        const issueNumbers = extractIssueNumbers(text);

        prs.push({
          number: pr.number,
          title: pr.title,
          body: pr.body ?? '',
          author: pr.user?.login ?? 'unknown',
          authorAssociation: pr.author_association,
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          headRef: pr.head.ref,
          baseRef: pr.base.ref,
          filesChanged,
          additions,
          deletions,
          commits,
          labels: pr.labels.map(l => (typeof l === 'string' ? l : l.name ?? '')),
          ciStatus,
          hasIssueRef: issueNumbers.length > 0,
          issueNumbers,
          changedFiles,
          diffUrl: pr.diff_url,
          hasTests,
          testFilesChanged,
          ageInDays,
          mergeable,
          reviewState,
          reviewCount,
          commentCount,
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
    const items: PRListItem[] = [];
    let page = 1;

    while (items.length < this.config.maxPRs) {
      const { data } = await this.octokit.pulls.list({
        owner, repo,
        state: 'open',
        per_page: 100,
        page,
        sort: 'updated',
        direction: 'desc',
      });
      if (data.length === 0) break;
      for (const pr of data) {
        if (items.length >= this.config.maxPRs) break;
        items.push({
          number: pr.number,
          updatedAt: pr.updated_at,
          headSha: pr.head.sha,
        });
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
    const prs: PRData[] = [];

    for (const prNum of prNumbers) {
      try {
        const { data: pr } = await this.octokit.pulls.get({ owner, repo, pull_number: prNum });

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
          console.warn(`⚠️  Failed to fetch files for PR #${prNum}: ${err.message}`);
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
            console.warn(`⚠️  Failed to fetch CI status for PR #${prNum}: ${err.message}`);
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
          console.warn(`⚠️  Failed to fetch reviews for PR #${prNum}: ${err.message}`);
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
        });
      } catch (err: any) {
        console.error(`⚠️  Failed to fetch PR #${prNum}: ${err.message}`);
      }
    }
    return prs;
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
