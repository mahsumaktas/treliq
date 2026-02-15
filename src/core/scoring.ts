/**
 * ScoringEngine — Multi-signal PR scoring with LLM-assisted analysis
 */

import type { PRData, ScoredPR, SignalScore } from './types';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export class ScoringEngine {
  private geminiApiKey: string;
  private trustContributors: boolean;
  private reputationScores = new Map<string, number>();

  constructor(geminiApiKey?: string, trustContributors = false) {
    this.geminiApiKey = geminiApiKey ?? process.env.GEMINI_API_KEY ?? '';
    this.trustContributors = trustContributors;
  }

  setReputation(login: string, score: number) {
    this.reputationScores.set(login, score);
  }

  async score(pr: PRData): Promise<ScoredPR> {
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
    ];

    const heuristicScore = signals.reduce(
      (sum, s) => sum + s.score * s.weight,
      0
    ) / signals.reduce((sum, s) => sum + s.weight, 0);

    const spamSignal = signals.find(s => s.name === 'spam');
    const isSpam = (spamSignal?.score ?? 100) < 25;

    // LLM scoring
    let llmScore: number | undefined;
    let llmRisk: 'low' | 'medium' | 'high' | undefined;
    let llmReason: string | undefined;

    if (this.geminiApiKey) {
      try {
        const llmResult = await this.scoreLLM(pr);
        llmScore = llmResult.score;
        llmRisk = llmResult.risk;
        llmReason = llmResult.reason;
      } catch (err: any) {
        // Graceful degrade
      }
    }

    // Blend: 0.4 heuristic + 0.6 LLM, or heuristic-only if LLM failed
    const totalScore = llmScore !== undefined
      ? Math.round(0.4 * heuristicScore + 0.6 * llmScore)
      : Math.round(heuristicScore);

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
    };
  }

  private async scoreLLM(pr: PRData): Promise<{ score: number; risk: 'low' | 'medium' | 'high'; reason: string }> {
    await sleep(100); // Rate limiting

    const filesStr = pr.changedFiles.slice(0, 30).join(', ');
    const input = `Title: ${pr.title}\nBody: ${(pr.body ?? '').slice(0, 2000)}\nFiles: ${filesStr}`.slice(0, 4000);

    const prompt = `Rate this GitHub PR on practical value and merge-readiness (0-100). Focus on: Does it solve a real problem? Is the implementation correct and complete? Would merging it improve the project? Ignore whether AI/LLM was used to write it — only judge the end result. Return JSON: {"score": <number>, "risk": "low"|"medium"|"high", "reason": "<brief>"}\nRisk means: would merging this PR cause issues (breaking changes, bugs, security)?\n${input}`;

    const res = await fetch(`${GEMINI_URL}?key=${this.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
      }),
    });

    if (!res.ok) throw new Error(`Gemini ${res.status}`);

    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    const match = text.match(/\{[^}]+\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        score: Math.max(0, Math.min(100, Number(parsed.score) || 50)),
        risk: ['low', 'medium', 'high'].includes(parsed.risk) ? parsed.risk : 'medium',
        reason: parsed.reason ?? '',
      };
    }
    throw new Error('Parse failed');
  }

  private scoreCI(pr: PRData): SignalScore {
    const scoreMap = { success: 100, pending: 50, failure: 10, unknown: 40 };
    return { name: 'ci_status', score: scoreMap[pr.ciStatus], weight: 0.2, reason: `CI: ${pr.ciStatus}` };
  }

  private scoreDiffSize(pr: PRData): SignalScore {
    const total = pr.additions + pr.deletions;
    let score = 80;
    if (total < 5) score = 20;
    else if (total < 50) score = 70;
    else if (total < 500) score = 100;
    else if (total < 2000) score = 60;
    else score = 30;
    return { name: 'diff_size', score, weight: 0.1, reason: `${total} lines changed (${pr.additions}+/${pr.deletions}-)` };
  }

  private scoreCommitQuality(pr: PRData): SignalScore {
    const conventional = /^(feat|fix|docs|style|refactor|test|chore|ci|perf|build)(\(.+\))?:/.test(pr.title);
    return { name: 'commit_quality', score: conventional ? 90 : 50, weight: 0.05, reason: conventional ? 'Conventional commit format' : 'Non-standard title' };
  }

  private scoreContributor(pr: PRData): SignalScore {
    const trustMap: Record<string, number> = {
      OWNER: 100, MEMBER: 90, COLLABORATOR: 85, CONTRIBUTOR: 70,
      FIRST_TIMER: 40, FIRST_TIME_CONTRIBUTOR: 40, NONE: 30,
    };
    let assocScore = trustMap[pr.authorAssociation] ?? 50;
    const repScore = this.reputationScores.get(pr.author);
    // Blend: 70% association + 30% reputation if available
    const score = repScore !== undefined
      ? Math.round(0.7 * assocScore + 0.3 * repScore)
      : assocScore;
    const repInfo = repScore !== undefined ? `, rep: ${repScore}` : '';
    return { name: 'contributor', score, weight: 0.15, reason: `${pr.author} (${pr.authorAssociation}${repInfo})` };
  }

  private scoreIssueRef(pr: PRData): SignalScore {
    return {
      name: 'issue_ref', score: pr.hasIssueRef ? 90 : 30, weight: 0.1,
      reason: pr.hasIssueRef ? `References: ${pr.issueNumbers.map(n => `#${n}`).join(', ')}` : 'No issue reference',
    };
  }

  private scoreSpam(pr: PRData): SignalScore {
    let spamScore = 0;
    const reasons: string[] = [];

    // Known contributors: full exemption if --trust-contributors, otherwise -1 penalty reduction
    const knownContributor = ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR'].includes(pr.authorAssociation);
    if (knownContributor && this.trustContributors) {
      return { name: 'spam', score: 100, weight: 0.15, reason: `Trusted contributor (${pr.authorAssociation})` };
    }
    let trustBonus = knownContributor ? -1 : 0;

    if (pr.additions + pr.deletions < 3) { spamScore += 2; reasons.push('<3 lines'); }
    else if (pr.additions + pr.deletions < 5) { spamScore++; reasons.push('<5 lines'); }
    if (!pr.hasIssueRef) { spamScore++; reasons.push('No issue ref'); }
    if ((pr.body ?? '').length < 20) { spamScore++; reasons.push('No/short description'); }
    const docsOnly = pr.changedFiles.every(f => /readme|contributing|license|changelog|\.md$|\.txt$/i.test(f));
    if (docsOnly && pr.changedFiles.length > 0 && pr.additions + pr.deletions < 20) { spamScore++; reasons.push('Trivial docs-only change'); }
    spamScore = Math.max(0, spamScore + trustBonus);
    if (knownContributor && reasons.length > 0) reasons.push(`contributor bonus -1`);
    return { name: 'spam', score: Math.max(0, 100 - spamScore * 25), weight: 0.15, reason: reasons.length > 0 ? reasons.join(', ') : 'No spam signals' };
  }

  private scoreTestCoverage(pr: PRData): SignalScore {
    if (pr.hasTests) {
      return { name: 'test_coverage', score: 90, weight: 0.15, reason: `${pr.testFilesChanged.length} test file(s) changed` };
    }
    // Check if docs/config-only PR (tests not expected)
    const docsConfigOnly = pr.changedFiles.length > 0 && pr.changedFiles.every(f =>
      /\.(md|txt|json|ya?ml|toml|ini|cfg|conf|lock)$/i.test(f) || /readme|license|changelog|contributing|docs\//i.test(f)
    );
    if (docsConfigOnly) {
      return { name: 'test_coverage', score: 60, weight: 0.15, reason: 'Docs/config PR — tests not expected' };
    }
    return { name: 'test_coverage', score: 20, weight: 0.15, reason: 'No test files changed in code PR' };
  }

  private scoreStaleness(pr: PRData): SignalScore {
    const days = pr.ageInDays;
    let score: number;
    let label: string;
    if (days < 7) { score = 100; label = 'Fresh'; }
    else if (days <= 30) { score = 70; label = 'Aging'; }
    else if (days <= 90) { score = 40; label = 'Stale'; }
    else { score = 15; label = 'Very stale'; }
    return { name: 'staleness', score, weight: 0.1, reason: `${days}d old (${label})` };
  }

  private scoreMergeability(pr: PRData): SignalScore {
    const scoreMap = { mergeable: 100, unknown: 50, conflicting: 10 };
    return { name: 'mergeability', score: scoreMap[pr.mergeable], weight: 0.15, reason: `Merge status: ${pr.mergeable}` };
  }

  private scoreReviewStatus(pr: PRData): SignalScore {
    const stateScores: Record<string, number> = {
      approved: 100, changes_requested: 30, commented: 60, none: 40,
    };
    let score = stateScores[pr.reviewState] ?? 40;
    if (pr.reviewCount >= 2) score = Math.min(100, score + 10);
    return { name: 'review_status', score, weight: 0.10, reason: `Review: ${pr.reviewState} (${pr.reviewCount} reviews)` };
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
    return { name: 'body_quality', score, weight: 0.05, reason: `Body: ${len} chars` };
  }

  private scoreActivity(pr: PRData): SignalScore {
    let score: number;
    if (pr.commentCount >= 5) score = 90;
    else if (pr.commentCount >= 2) score = 70;
    else if (pr.commentCount === 1) score = 50;
    else score = 30;
    return { name: 'activity', score, weight: 0.05, reason: `${pr.commentCount} comments` };
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
      weight: 0.05,
      reason: breaking ? reasons.join('; ') : 'No breaking change signals',
    };
  }
}
