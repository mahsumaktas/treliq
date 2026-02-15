/**
 * TreliqScanner — Fetches and analyzes PRs from a GitHub repository
 */

import { Octokit } from '@octokit/rest';
import type { TreliqConfig, PRData, ScoredPR, TreliqResult } from './types';
import { ScoringEngine } from './scoring';
import { DedupEngine } from './dedup';
import { VisionChecker } from './vision';

const ISSUE_REF_PATTERN = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

export class TreliqScanner {
  private config: TreliqConfig;
  private octokit: Octokit;
  private scoring: ScoringEngine;

  constructor(config: TreliqConfig) {
    this.config = config;
    this.octokit = new Octokit({ auth: config.token });
    this.scoring = new ScoringEngine();
  }

  async scan(): Promise<TreliqResult> {
    const [owner, repo] = this.config.repo.split('/');
    console.error(`📡 Fetching open PRs from ${this.config.repo}...`);

    // 1. Fetch PRs
    const prs = await this.fetchPRs();
    console.error(`   Found ${prs.length} open PRs`);

    // 2. Score PRs
    console.error('📊 Scoring PRs...');
    const scored: ScoredPR[] = [];
    for (const pr of prs) {
      scored.push(await this.scoring.score(pr));
    }

    // 3. Dedup
    let clusters = [] as import('./types').DedupCluster[];
    if (this.config.geminiApiKey) {
      try {
        console.error('🔍 Finding duplicates via embeddings...');
        const dedup = new DedupEngine(
          this.config.duplicateThreshold,
          this.config.relatedThreshold,
          this.config.geminiApiKey,
        );
        clusters = await dedup.findDuplicates(scored);
        console.error(`   Found ${clusters.length} duplicate clusters`);
      } catch (err: any) {
        console.error(`⚠️  Dedup failed (skipping): ${err.message}`);
      }
    } else {
      console.error('⏭️  Skipping dedup (no GEMINI_API_KEY)');
    }

    // 4. Vision check
    if (this.config.geminiApiKey) {
      try {
        console.error('🔭 Checking vision alignment...');
        const visionDoc = await this.fetchVisionDoc(owner, repo);
        if (visionDoc) {
          const vision = new VisionChecker(visionDoc, this.config.geminiApiKey);
          for (const pr of scored) {
            try {
              const result = await vision.check(pr);
              pr.visionAlignment = result.alignment;
              pr.visionReason = result.reason;
            } catch {
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

    const summary = [
      `Scanned ${prs.length} PRs in ${this.config.repo}`,
      `${spamCount} flagged as spam`,
      `${clusters.length} duplicate clusters found`,
      `Top PR: #${scored[0]?.number} (${scored[0]?.totalScore}/100) — ${scored[0]?.title}`,
    ].join('. ');

    return {
      repo: this.config.repo,
      scannedAt: new Date().toISOString(),
      totalPRs: prs.length,
      spamCount,
      duplicateClusters: clusters,
      rankedPRs: scored,
      summary,
    };
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

        // Fetch details for files + commits
        let filesChanged = 0;
        let additions = 0;
        let deletions = 0;
        let commits = 0;
        let changedFiles: string[] = [];
        let ciStatus: PRData['ciStatus'] = 'unknown';

        try {
          const detail = await this.octokit.pulls.get({ owner, repo, pull_number: pr.number });
          filesChanged = detail.data.changed_files;
          additions = detail.data.additions;
          deletions = detail.data.deletions;
          commits = detail.data.commits;
        } catch { /* use defaults */ }

        try {
          const files = await this.octokit.pulls.listFiles({
            owner, repo, pull_number: pr.number, per_page: 100,
          });
          changedFiles = files.data.map(f => f.filename);
        } catch { /* skip */ }

        try {
          const checks = await this.octokit.checks.listForRef({
            owner, repo, ref: pr.head.sha,
          });
          if (checks.data.total_count > 0) {
            const conclusions = checks.data.check_runs.map(c => c.conclusion);
            if (conclusions.every(c => c === 'success')) ciStatus = 'success';
            else if (conclusions.some(c => c === 'failure')) ciStatus = 'failure';
            else ciStatus = 'pending';
          }
        } catch {
          // Try commit status as fallback
          try {
            const status = await this.octokit.repos.getCombinedStatusForRef({
              owner, repo, ref: pr.head.sha,
            });
            const stateMap: Record<string, PRData['ciStatus']> = {
              success: 'success', failure: 'failure', pending: 'pending',
            };
            ciStatus = stateMap[status.data.state] ?? 'unknown';
          } catch { /* unknown */ }
        }

        // Issue references
        const text = `${pr.title} ${pr.body ?? ''}`;
        const issueNumbers: number[] = [];
        let match: RegExpExecArray | null;
        const re = new RegExp(ISSUE_REF_PATTERN.source, 'gi');
        while ((match = re.exec(text)) !== null) {
          issueNumbers.push(parseInt(match[1], 10));
        }

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
        });
      }

      page++;
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
