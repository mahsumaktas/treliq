/**
 * SemanticMatcher — Determines if PRs actually resolve their referenced issues
 */

import type { LLMProvider } from './provider';
import type { ScoredPR, ScoredIssue, DiffAnalysis, SemanticMatch } from './types';
import { ConcurrencyController } from './concurrency';
import { createLogger } from './logger';

const log = createLogger('semantic-matcher');

const MATCH_PR_BONUS: Record<string, number> = {
  full: 8,
  partial: 3,
  unrelated: -5,
};

const MATCH_ISSUE_SCORE: Record<string, number> = {
  full: 95,
  partial: 70,
  unrelated: 40,
};

export interface MatchResult {
  matches: SemanticMatch[];
  prBonuses: Map<number, number>;
  issueScoreUpdates: Map<number, number>;
}

export class SemanticMatcher {
  private provider?: LLMProvider;
  private concurrency: ConcurrencyController;

  constructor(provider?: LLMProvider, maxConcurrent = 10) {
    this.provider = provider;
    this.concurrency = new ConcurrencyController(maxConcurrent);
  }

  async matchAll(
    prs: ScoredPR[],
    issues: ScoredIssue[],
    diffMap?: Map<number, DiffAnalysis>,
  ): Promise<MatchResult> {
    const result: MatchResult = {
      matches: [],
      prBonuses: new Map(),
      issueScoreUpdates: new Map(),
    };

    if (!this.provider) return result;

    const issueMap = new Map(issues.map(i => [i.number, i]));

    // Build pairs: PR references issue AND issue exists
    const pairs: Array<{ pr: ScoredPR; issue: ScoredIssue }> = [];
    for (const pr of prs) {
      for (const issueNum of pr.issueNumbers) {
        const issue = issueMap.get(issueNum);
        if (issue) {
          pairs.push({ pr, issue });
        }
      }
    }

    if (pairs.length === 0) return result;

    log.info({ pairs: pairs.length }, 'Matching PR-Issue pairs');

    const matchResults = await Promise.allSettled(
      pairs.map(({ pr, issue }) =>
        this.concurrency.execute(() => this.matchOne(pr, issue, diffMap?.get(pr.number)))
      )
    );

    for (const mr of matchResults) {
      if (mr.status !== 'fulfilled' || !mr.value) continue;
      const match = mr.value;
      result.matches.push(match);

      // PR bonus
      const bonus = MATCH_PR_BONUS[match.matchQuality] ?? 0;
      const existing = result.prBonuses.get(match.prNumber) ?? 0;
      result.prBonuses.set(match.prNumber, existing + bonus);

      // Issue score update (use best match quality if multiple PRs)
      const issueScore = MATCH_ISSUE_SCORE[match.matchQuality];
      if (issueScore !== undefined) {
        const current = result.issueScoreUpdates.get(match.issueNumber) ?? 0;
        result.issueScoreUpdates.set(match.issueNumber, Math.max(current, issueScore));
      }
    }

    return result;
  }

  private async matchOne(
    pr: ScoredPR,
    issue: ScoredIssue,
    diff?: DiffAnalysis,
  ): Promise<SemanticMatch | null> {
    try {
      const diffInfo = diff
        ? `\nDiff summary: ${diff.summary}\nAffected areas: ${diff.affectedAreas.join(', ')}`
        : '';

      const prompt = `Does this PR resolve this Issue?

Issue #${issue.number}: "${issue.title}"
${(issue.body ?? '').slice(0, 2000)}

PR #${pr.number}: "${pr.title}"
${(pr.body ?? '').slice(0, 1000)}${diffInfo}

Return JSON:
{"matchQuality": "full"|"partial"|"unrelated", "confidence": <0-1>, "reason": "<brief>"}`;

      const text = await this.provider!.generateText(prompt, { temperature: 0.1, maxTokens: 150 });
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]);
      const validQualities = ['full', 'partial', 'unrelated'];
      if (!validQualities.includes(parsed.matchQuality)) return null;

      return {
        prNumber: pr.number,
        issueNumber: issue.number,
        matchQuality: parsed.matchQuality,
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
        reason: String(parsed.reason ?? ''),
      };
    } catch (err) {
      log.warn({ pr: pr.number, issue: issue.number, err }, 'Semantic match failed');
      return null;
    }
  }
}
