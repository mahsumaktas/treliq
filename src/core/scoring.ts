/**
 * ScoringEngine — Multi-signal PR scoring with LLM-assisted analysis
 */

import type { PRData, ScoredPR, SignalScore, DiffAnalysis } from './types';
import type { LLMProvider } from './provider';
import { IntentClassifier, type IntentResult } from './intent';
import { ConcurrencyController } from './concurrency';
import { createLogger } from './logger';
import type { IntentCategory } from './types';

/** Intent-aware weight profiles — overrides for specific signals per intent */
const INTENT_PROFILES: Record<IntentCategory, Partial<Record<string, number>>> = {
  bugfix: {
    ci_status: 0.20,
    test_coverage: 0.18,
    mergeability: 0.15,
    diff_size: 0.04,
  },
  feature: {
    body_quality: 0.08,
    test_coverage: 0.15,
    scope_coherence: 0.08,
  },
  refactor: {
    test_coverage: 0.18,
    breaking_change: 0.08,
    scope_coherence: 0.10,
  },
  dependency: {
    ci_status: 0.25,
    diff_size: 0.02,
    body_quality: 0.02,
    test_coverage: 0.15,
  },
  docs: {
    diff_size: 0.02,
    ci_status: 0.05,
    test_coverage: 0.03,
    body_quality: 0.08,
  },
  chore: {
    ci_status: 0.20,
    breaking_change: 0.06,
    diff_size: 0.03,
  },
};

const log = createLogger('scoring');

export class ScoringEngine {
  private provider?: LLMProvider;
  private trustContributors: boolean;
  private reputationScores = new Map<string, number>();
  private concurrency: ConcurrencyController;
  private intentClassifier: IntentClassifier;
  private diffAnalyses = new Map<number, DiffAnalysis>();

  constructor(provider?: LLMProvider, trustContributors = false, maxConcurrent = 5) {
    this.provider = provider;
    this.trustContributors = trustContributors;
    this.concurrency = new ConcurrencyController(maxConcurrent);
    this.intentClassifier = new IntentClassifier(provider);
  }

  setReputation(login: string, score: number) {
    this.reputationScores.set(login, score);
  }

  setDiffAnalysis(prNumber: number, analysis: DiffAnalysis): void {
    this.diffAnalyses.set(prNumber, analysis);
  }

  /** Score multiple PRs in parallel with concurrency control */
  async scoreMany(prs: PRData[]): Promise<ScoredPR[]> {
    if (prs.length === 0) return [];
    log.info({ count: prs.length, maxConcurrent: this.concurrency.getMaxConcurrent() }, 'Scoring PRs');

    const results = await Promise.allSettled(
      prs.map(pr => this.concurrency.execute(() => this.score(pr)))
    );

    const scored: ScoredPR[] = [];
    let failed = 0;
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        scored.push(result.value);
      } else {
        failed++;
        log.warn({ pr: prs[i].number, err: result.reason }, 'Failed to score PR');
      }
    }
    if (failed > 0) log.warn({ failed, total: prs.length }, 'Some PRs failed to score');
    return scored;
  }

  async score(pr: PRData): Promise<ScoredPR> {
    const intentResult = await this.intentClassifier.classify(pr.title, pr.body ?? '', pr.changedFiles);

    const signals: SignalScore[] = [
      this.scoreCI(pr),
      this.scoreDiffSize(pr),
      this.scoreCommitQuality(pr),
      this.scoreContributor(pr),
      this.scoreIssueRef(pr),
      this.scoreSpam(pr),
      this.scoreTestCoverage(pr),
      this.scoreStaleness(pr),
      this.scoreMergeability(pr),
      this.scoreReviewStatus(pr),
      this.scoreBodyQuality(pr),
      this.scoreActivity(pr),
      this.scoreBreakingChange(pr),
      this.scoreDraftStatus(pr),
      this.scoreMilestone(pr),
      this.scoreLabelPriority(pr),
      this.scoreCodeowners(pr),
      this.scoreRequestedReviewers(pr),
      this.scoreScopeCoherence(pr),
      this.scoreComplexity(pr),
      this.scoreIntent(intentResult),
    ];

    // Apply intent-aware weight profiles
    const profile = INTENT_PROFILES[intentResult.intent];
    if (profile) {
      for (const signal of signals) {
        if (profile[signal.name] !== undefined) {
          signal.weight = profile[signal.name]!;
        }
      }
      // Normalize weights to sum=1.0
      const rawTotal = signals.reduce((sum, s) => sum + s.weight, 0);
      if (rawTotal > 0 && rawTotal !== 1.0) {
        const factor = 1.0 / rawTotal;
        for (const signal of signals) {
          signal.weight *= factor;
        }
      }
    }

    const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
    const heuristicScore = totalWeight > 0
      ? signals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight
      : 0;

    const spamSignal = signals.find(s => s.name === 'spam');
    const isSpam = (spamSignal?.score ?? 100) < 25;

    // LLM scoring
    let llmScore: number | undefined;
    let llmRisk: 'low' | 'medium' | 'high' | undefined;
    let llmReason: string | undefined;

    if (this.provider) {
      try {
        const llmResult = await this.scoreLLM(pr);
        llmScore = llmResult.score;
        llmRisk = llmResult.risk;
        llmReason = llmResult.reason;
      } catch (err: any) {
        log.warn({ pr: pr.number, err }, 'LLM scoring failed');
      }
    }

    // Blend: new formula when diff available
    const diffAnalysis = this.diffAnalyses.get(pr.number);
    let totalScore: number;
    if (llmScore !== undefined && diffAnalysis) {
      // 0.4 heuristic + 0.3 LLM text + 0.3 LLM diff
      totalScore = Math.round(0.4 * heuristicScore + 0.3 * llmScore + 0.3 * diffAnalysis.codeQuality);
      // Override risk from diff (more reliable)
      if (diffAnalysis.riskAssessment !== 'medium') {
        llmRisk = diffAnalysis.riskAssessment === 'critical' ? 'high' : diffAnalysis.riskAssessment;
      }
    } else if (llmScore !== undefined) {
      totalScore = Math.round(0.4 * heuristicScore + 0.6 * llmScore);
    } else {
      totalScore = Math.round(heuristicScore);
    }

    return {
      ...pr,
      totalScore,
      signals,
      isSpam,
      spamReasons: isSpam ? [spamSignal?.reason ?? 'Low quality'] : [],
      visionAlignment: 'unchecked',
      llmScore,
      llmRisk,
      llmReason,
      intent: intentResult.intent,
      diffAnalysis,
    };
  }

  private async scoreLLM(pr: PRData): Promise<{ score: number; risk: 'low' | 'medium' | 'high'; reason: string }> {
    const filesStr = pr.changedFiles.slice(0, 30).join(', ');
    const input = `Title: ${pr.title}\nBody: ${(pr.body ?? '').slice(0, 2000)}\nFiles: ${filesStr}`.slice(0, 4000);

    const prompt = `Rate this GitHub PR on practical value and merge-readiness (0-100). Focus on: Does it solve a real problem? Is the implementation correct and complete? Would merging it improve the project? Ignore whether AI/LLM was used to write it — only judge the end result. Return JSON: {"score": <number>, "risk": "low"|"medium"|"high", "reason": "<brief>"}\nRisk means: would merging this PR cause issues (breaking changes, bugs, security)?\n${input}`;

    const text = await this.provider!.generateText(prompt, { temperature: 0.1, maxTokens: 200 });

    const match = text.match(/\{[^}]+\}/);
    if (!match) throw new Error('No JSON found in LLM response');
    try {
      const parsed = JSON.parse(match[0]);
      return {
        score: Math.max(0, Math.min(100, Number(parsed.score) || 50)),
        risk: ['low', 'medium', 'high'].includes(parsed.risk) ? parsed.risk : 'medium',
        reason: String(parsed.reason ?? ''),
      };
    } catch (parseErr: any) {
      throw new Error(`JSON parse failed: ${parseErr.message}`);
    }
  }

  // --- Original 13 signals (weights adjusted for 18-signal total) ---

  private scoreCI(pr: PRData): SignalScore {
    const scoreMap = { success: 100, pending: 50, failure: 10, unknown: 40 };
    return { name: 'ci_status', score: scoreMap[pr.ciStatus], weight: 0.15, reason: `CI: ${pr.ciStatus}` };
  }

  private scoreDiffSize(pr: PRData): SignalScore {
    const total = pr.additions + pr.deletions;
    let score = 80;
    if (total < 5) score = 20;
    else if (total < 50) score = 70;
    else if (total < 500) score = 100;
    else if (total < 2000) score = 60;
    else score = 30;
    return { name: 'diff_size', score, weight: 0.07, reason: `${total} lines changed (${pr.additions}+/${pr.deletions}-)` };
  }

  private scoreCommitQuality(pr: PRData): SignalScore {
    const conventional = /^(feat|fix|docs|style|refactor|test|chore|ci|perf|build)(\(.+\))?:/.test(pr.title);
    return { name: 'commit_quality', score: conventional ? 90 : 50, weight: 0.04, reason: conventional ? 'Conventional commit format' : 'Non-standard title' };
  }

  private scoreContributor(pr: PRData): SignalScore {
    const trustMap: Record<string, number> = {
      OWNER: 100, MEMBER: 90, COLLABORATOR: 85, CONTRIBUTOR: 70,
      FIRST_TIMER: 40, FIRST_TIME_CONTRIBUTOR: 40, NONE: 30,
    };
    let assocScore = trustMap[pr.authorAssociation] ?? 50;
    const repScore = this.reputationScores.get(pr.author);
    const score = repScore !== undefined
      ? Math.round(0.7 * assocScore + 0.3 * repScore)
      : assocScore;
    const repInfo = repScore !== undefined ? `, rep: ${repScore}` : '';
    return { name: 'contributor', score, weight: 0.12, reason: `${pr.author} (${pr.authorAssociation}${repInfo})` };
  }

  private scoreIssueRef(pr: PRData): SignalScore {
    return {
      name: 'issue_ref', score: pr.hasIssueRef ? 90 : 30, weight: 0.07,
      reason: pr.hasIssueRef ? `References: ${pr.issueNumbers.map(n => `#${n}`).join(', ')}` : 'No issue reference',
    };
  }

  private scoreSpam(pr: PRData): SignalScore {
    let spamScore = 0;
    const reasons: string[] = [];

    const knownContributor = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'].includes(pr.authorAssociation);
    if (knownContributor && this.trustContributors) {
      return { name: 'spam', score: 100, weight: 0.12, reason: `Trusted contributor (${pr.authorAssociation})` };
    }
    let trustBonus = knownContributor ? -1 : 0;

    if (pr.additions + pr.deletions < 3) { spamScore += 2; reasons.push('<3 lines'); }
    else if (pr.additions + pr.deletions < 5) { spamScore++; reasons.push('<5 lines'); }
    if (!pr.hasIssueRef) { spamScore++; reasons.push('No issue ref'); }
    if ((pr.body ?? '').length < 20) { spamScore++; reasons.push('No/short description'); }
    const docsOnly = pr.changedFiles.every(f => /readme|contributing|license|changelog|\.md$|\.txt$/i.test(f));
    if (docsOnly && pr.changedFiles.length > 0 && pr.additions + pr.deletions < 20) { spamScore++; reasons.push('Trivial docs-only change'); }

    // Typo-fix spam pattern: many files, tiny changes, all docs
    if (pr.changedFiles.length > 3 && pr.additions + pr.deletions < pr.changedFiles.length * 2 && docsOnly) {
      spamScore++; reasons.push('Likely typo-fix spam');
    }

    // AI-generated language markers in body
    const aiMarkers = [/certainly!/i, /as an ai/i, /i apologize/i, /here's the corrected/i, /i'd be happy to/i];
    if (aiMarkers.some(p => p.test(pr.body ?? ''))) {
      spamScore++; reasons.push('AI-generated language');
    }

    spamScore = Math.max(0, spamScore + trustBonus);
    if (knownContributor && reasons.length > 0) reasons.push(`contributor bonus -1`);
    return { name: 'spam', score: Math.max(0, 100 - spamScore * 20), weight: 0.12, reason: reasons.length > 0 ? reasons.join(', ') : 'No spam signals' };
  }

  private scoreTestCoverage(pr: PRData): SignalScore {
    if (pr.hasTests) {
      return { name: 'test_coverage', score: 90, weight: 0.12, reason: `${pr.testFilesChanged.length} test file(s) changed` };
    }
    const docsConfigOnly = pr.changedFiles.length > 0 && pr.changedFiles.every(f =>
      /\.(md|txt|json|ya?ml|toml|ini|cfg|conf|lock)$/i.test(f) || /readme|license|changelog|contributing|docs\//i.test(f)
    );
    if (docsConfigOnly) {
      return { name: 'test_coverage', score: 60, weight: 0.12, reason: 'Docs/config PR — tests not expected' };
    }
    return { name: 'test_coverage', score: 20, weight: 0.12, reason: 'No test files changed in code PR' };
  }

  private scoreStaleness(pr: PRData): SignalScore {
    const days = pr.ageInDays;
    let score: number;
    let label: string;
    if (days < 7) { score = 100; label = 'Fresh'; }
    else if (days <= 30) { score = 70; label = 'Aging'; }
    else if (days <= 90) { score = 40; label = 'Stale'; }
    else { score = 15; label = 'Very stale'; }
    return { name: 'staleness', score, weight: 0.07, reason: `${days}d old (${label})` };
  }

  private scoreMergeability(pr: PRData): SignalScore {
    const scoreMap = { mergeable: 100, unknown: 50, conflicting: 10 };
    return { name: 'mergeability', score: scoreMap[pr.mergeable], weight: 0.12, reason: `Merge status: ${pr.mergeable}` };
  }

  private scoreReviewStatus(pr: PRData): SignalScore {
    const stateScores: Record<string, number> = {
      approved: 100, changes_requested: 30, commented: 60, none: 40,
    };
    let score = stateScores[pr.reviewState] ?? 40;
    if (pr.reviewCount >= 2) score = Math.min(100, score + 10);
    return { name: 'review_status', score, weight: 0.08, reason: `Review: ${pr.reviewState} (${pr.reviewCount} reviews)` };
  }

  private scoreBodyQuality(pr: PRData): SignalScore {
    const len = (pr.body ?? '').length;
    let score: number;
    if (len > 500) score = 90;
    else if (len >= 200) score = 70;
    else if (len >= 50) score = 50;
    else score = 20;
    if (/- \[[ x]\]/.test(pr.body ?? '')) score = Math.min(100, score + 10);
    if (/!\[/.test(pr.body ?? '')) score = Math.min(100, score + 10);
    return { name: 'body_quality', score, weight: 0.04, reason: `Body: ${len} chars` };
  }

  private scoreActivity(pr: PRData): SignalScore {
    let score: number;
    if (pr.commentCount >= 5) score = 90;
    else if (pr.commentCount >= 2) score = 70;
    else if (pr.commentCount === 1) score = 50;
    else score = 30;
    return { name: 'activity', score, weight: 0.04, reason: `${pr.commentCount} comments` };
  }

  private scoreBreakingChange(pr: PRData): SignalScore {
    let breaking = false;
    const reasons: string[] = [];

    if (/breaking|BREAKING/i.test(pr.title) || /^[a-z]+(\(.+\))?!:/.test(pr.title)) {
      breaking = true;
      reasons.push('Title indicates breaking change');
    }
    const riskyFiles = pr.changedFiles.filter(f =>
      /^package\.json$|tsconfig\.json|\/api\//.test(f)
    );
    if (riskyFiles.length > 0) {
      breaking = true;
      reasons.push(`Risky files: ${riskyFiles.slice(0, 3).join(', ')}`);
    }
    if (pr.deletions > 100) {
      breaking = true;
      reasons.push(`${pr.deletions} deletions`);
    }

    return {
      name: 'breaking_change',
      score: breaking ? 40 : 80,
      weight: 0.04,
      reason: breaking ? reasons.join('; ') : 'No breaking change signals',
    };
  }

  // --- New 5 signals (v0.4) ---

  private scoreDraftStatus(pr: PRData): SignalScore {
    return {
      name: 'draft_status',
      score: pr.isDraft ? 10 : 90,
      weight: 0.08,
      reason: pr.isDraft ? 'Draft PR (not ready for review)' : 'Ready for review',
    };
  }

  private scoreMilestone(pr: PRData): SignalScore {
    return {
      name: 'milestone',
      score: pr.milestone ? 90 : 40,
      weight: 0.07,
      reason: pr.milestone ? `Milestone: ${pr.milestone}` : 'No milestone attached',
    };
  }

  private scoreLabelPriority(pr: PRData): SignalScore {
    const highLabels = ['high-priority', 'urgent', 'critical', 'p0', 'p1', 'security', 'bug'];
    const lowLabels = ['low-priority', 'backlog', 'nice-to-have', 'p3', 'p4', 'wontfix'];
    const labels = pr.labels.map(l => l.toLowerCase());

    if (labels.some(l => highLabels.some(h => l.includes(h)))) {
      return { name: 'label_priority', score: 95, weight: 0.08, reason: `High priority labels: ${pr.labels.join(', ')}` };
    }
    if (labels.some(l => lowLabels.some(h => l.includes(h)))) {
      return { name: 'label_priority', score: 30, weight: 0.08, reason: `Low priority labels: ${pr.labels.join(', ')}` };
    }
    return { name: 'label_priority', score: 50, weight: 0.05, reason: pr.labels.length > 0 ? `Labels: ${pr.labels.join(', ')}` : 'No priority labels' };
  }

  private scoreCodeowners(pr: PRData): SignalScore {
    if (pr.codeowners.length === 0) {
      return { name: 'codeowners', score: 40, weight: 0.05, reason: 'No CODEOWNERS match' };
    }
    const authorIsOwner = pr.codeowners.includes(pr.author);
    return {
      name: 'codeowners',
      score: authorIsOwner ? 95 : 60,
      weight: 0.10,
      reason: authorIsOwner
        ? `Author owns ${pr.codeowners.length} matched pattern(s)`
        : `${pr.codeowners.join(', ')} own affected files`,
    };
  }

  private scoreRequestedReviewers(pr: PRData): SignalScore {
    return {
      name: 'requested_reviewers',
      score: pr.requestedReviewers.length > 0 ? 80 : 40,
      weight: 0.05,
      reason: pr.requestedReviewers.length > 0
        ? `${pr.requestedReviewers.length} reviewer(s): ${pr.requestedReviewers.slice(0, 3).join(', ')}`
        : 'No reviewers requested',
    };
  }

  // --- v0.5.1 signals ---

  /** Scope coherence: do all changed files belong to the same area? */
  private scoreScopeCoherence(pr: PRData): SignalScore {
    const files = pr.changedFiles;
    if (files.length === 0) return { name: 'scope_coherence', score: 50, weight: 0.06, reason: 'No files' };

    // Extract top-level directories
    const topDirs = new Set<string>();
    for (const f of files) {
      const parts = f.split('/');
      if (parts.length === 1) topDirs.add('(root)');
      else topDirs.add(parts[0] + '/' + (parts[1] ?? ''));
    }

    const dirCount = topDirs.size;
    let score: number;
    let label: string;

    if (dirCount <= 1) {
      score = 90; label = 'focused';
    } else if (dirCount <= 2) {
      score = 70; label = 'normal';
    } else if (dirCount <= 4) {
      score = 50; label = 'mixed';
    } else {
      score = 25; label = 'scattered';
    }

    // Title-to-files mismatch check: simple keyword extraction
    const titleWords = pr.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3);
    const fileWords = files.map(f => f.toLowerCase().replace(/[^a-z0-9]/g, ' ')).join(' ');
    const matchCount = titleWords.filter(w => fileWords.includes(w)).length;
    const titleMatch = titleWords.length > 0 ? matchCount / titleWords.length : 1;
    if (titleMatch < 0.2 && dirCount > 2) {
      score = Math.max(15, score - 20);
      label = 'scattered';
    }

    return {
      name: 'scope_coherence',
      score,
      weight: 0.06,
      reason: `${label}: ${dirCount} area(s) [${[...topDirs].slice(0, 4).join(', ')}]`,
    };
  }

  private scoreIntent(result: IntentResult): SignalScore {
    const scores: Record<string, number> = {
      bugfix: 90, feature: 85, refactor: 60, dependency: 35, docs: 30, chore: 25,
    };
    return {
      name: 'intent',
      score: scores[result.intent] ?? 50,
      weight: 0.15,
      reason: `${result.intent} (${result.reason})`,
    };
  }

  /** Large PR complexity: detect overengineered or massive PRs */
  private scoreComplexity(pr: PRData): SignalScore {
    const total = pr.additions + pr.deletions;
    const files = pr.changedFiles;
    if (total === 0) return { name: 'complexity', score: 50, weight: 0.05, reason: 'Empty diff' };

    let score = 80;
    const flags: string[] = [];

    // Lines-per-file ratio
    const linesPerFile = files.length > 0 ? total / files.length : total;
    if (linesPerFile > 300) {
      score -= 15;
      flags.push(`${Math.round(linesPerFile)} lines/file avg`);
    } else if (linesPerFile > 200) {
      score -= 5;
    }

    // Size thresholds
    if (total > 5000) {
      score -= 25; flags.push(`XXL: ${total} lines`);
    } else if (total > 1000) {
      score -= 15; flags.push(`XL: ${total} lines`);
    } else if (total > 500) {
      score -= 5; flags.push(`L: ${total} lines`);
    }

    // Test-to-code ratio for large PRs
    if (total > 200) {
      const testFiles = files.filter(f => /test|spec|__tests__/i.test(f));
      if (testFiles.length === 0) {
        score -= 10; flags.push('no tests');
      }
    }

    // AI-generated signals
    const titleBody = `${pr.title} ${pr.body ?? ''}`.toLowerCase();
    if (/ai[\s-]?(assisted|generated)|copilot|cursor|chatgpt|claude/i.test(titleBody)) {
      flags.push('AI-generated');
      // Extra scrutiny for large AI PRs
      if (total > 200) { score -= 10; flags.push('large AI PR'); }
    }

    // Simple title + large diff = overengineered
    const titleLen = pr.title.replace(/^(feat|fix|docs|chore|refactor|ci|test)(\(.+?\))?:\s*/, '').length;
    if (titleLen < 30 && total > 400) {
      score -= 10; flags.push('simple title, large diff');
    }

    score = Math.max(5, Math.min(100, score));
    const label = score >= 70 ? 'proportional' : score >= 40 ? 'overengineered' : 'massive';

    return {
      name: 'complexity',
      score,
      weight: 0.05,
      reason: flags.length > 0 ? `${label}: ${flags.join(', ')}` : `${label}: ${total} lines, ${files.length} files`,
    };
  }
}
