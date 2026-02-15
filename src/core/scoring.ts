/**
 * ScoringEngine — Multi-signal PR scoring
 *
 * Signals:
 * 1. CI Status (pass/fail/pending)
 * 2. Diff size (not too big, not too small)
 * 3. Commit quality (conventional commits, meaningful messages)
 * 4. Contributor history (repeat contributor vs first-timer)
 * 5. Issue reference (fixes #123)
 * 6. File diversity (touches many unrelated files = risky)
 * 7. Spam heuristics (single file, tiny change, docs-only)
 * 8. Code quality (LLM analysis of diff)
 *
 * TODO: Implement in v0.1
 */

import type { PRData, ScoredPR, SignalScore } from './types';

export class ScoringEngine {
  async score(pr: PRData): Promise<ScoredPR> {
    const signals: SignalScore[] = [
      this.scoreCI(pr),
      this.scoreDiffSize(pr),
      this.scoreCommitQuality(pr),
      this.scoreContributor(pr),
      this.scoreIssueRef(pr),
      this.scoreSpam(pr),
    ];

    const totalScore = signals.reduce(
      (sum, s) => sum + s.score * s.weight,
      0
    ) / signals.reduce((sum, s) => sum + s.weight, 0);

    const spamSignal = signals.find(s => s.name === 'spam');
    const isSpam = (spamSignal?.score ?? 100) < 30;

    return {
      ...pr,
      totalScore: Math.round(totalScore),
      signals,
      isSpam,
      spamReasons: isSpam ? [spamSignal?.reason ?? 'Low quality'] : [],
      visionAlignment: 'unchecked',
    };
  }

  private scoreCI(pr: PRData): SignalScore {
    const scoreMap = { success: 100, pending: 50, failure: 10, unknown: 40 };
    return {
      name: 'ci_status',
      score: scoreMap[pr.ciStatus],
      weight: 0.2,
      reason: `CI: ${pr.ciStatus}`,
    };
  }

  private scoreDiffSize(pr: PRData): SignalScore {
    const total = pr.additions + pr.deletions;
    let score = 80;
    if (total < 5) score = 20;        // Too small (suspicious)
    else if (total < 50) score = 70;   // Small but ok
    else if (total < 500) score = 100; // Sweet spot
    else if (total < 2000) score = 60; // Getting large
    else score = 30;                    // Massive PR

    return {
      name: 'diff_size',
      score,
      weight: 0.1,
      reason: `${total} lines changed (${pr.additions}+/${pr.deletions}-)`,
    };
  }

  private scoreCommitQuality(pr: PRData): SignalScore {
    // Basic: conventional commit check on title
    const conventional = /^(feat|fix|docs|style|refactor|test|chore|ci|perf|build)(\(.+\))?:/.test(pr.title);
    return {
      name: 'commit_quality',
      score: conventional ? 90 : 50,
      weight: 0.05,
      reason: conventional ? 'Conventional commit format' : 'Non-standard title',
    };
  }

  private scoreContributor(pr: PRData): SignalScore {
    const trustMap: Record<string, number> = {
      OWNER: 100,
      MEMBER: 90,
      COLLABORATOR: 85,
      CONTRIBUTOR: 70,
      FIRST_TIMER: 40,
      FIRST_TIME_CONTRIBUTOR: 40,
      NONE: 30,
    };
    const score = trustMap[pr.authorAssociation] ?? 50;
    return {
      name: 'contributor',
      score,
      weight: 0.15,
      reason: `${pr.author} (${pr.authorAssociation})`,
    };
  }

  private scoreIssueRef(pr: PRData): SignalScore {
    return {
      name: 'issue_ref',
      score: pr.hasIssueRef ? 90 : 30,
      weight: 0.1,
      reason: pr.hasIssueRef
        ? `References: ${pr.issueNumbers.map(n => `#${n}`).join(', ')}`
        : 'No issue reference',
    };
  }

  private scoreSpam(pr: PRData): SignalScore {
    let spamScore = 0;
    const reasons: string[] = [];

    if (pr.commits === 1) { spamScore++; reasons.push('Single commit'); }
    if (pr.filesChanged === 1) { spamScore++; reasons.push('Single file'); }
    if (pr.additions + pr.deletions < 5) { spamScore++; reasons.push('<5 lines'); }
    if (!pr.hasIssueRef) { spamScore++; reasons.push('No issue ref'); }

    const docsOnly = pr.changedFiles.every(f =>
      /readme|contributing|license|changelog|\.md$|\.txt$/i.test(f)
    );
    if (docsOnly && pr.changedFiles.length > 0) {
      spamScore++;
      reasons.push('Docs-only change');
    }

    // Invert: 0 spam indicators = 100 score, 5+ = 0
    const score = Math.max(0, 100 - spamScore * 20);

    return {
      name: 'spam',
      score,
      weight: 0.15,
      reason: reasons.length > 0 ? reasons.join(', ') : 'No spam signals',
    };
  }
}
