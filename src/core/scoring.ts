/**
 * ScoringEngine — Multi-signal PR scoring with LLM-assisted analysis
 */

import type { PRData, ScoredPR, SignalScore, DiffAnalysis, ScoringEngineOptions } from './types';
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

/** Result from dual CheckEval scoring */
interface LLMScoringResult {
  ideaScore: number;
  implementationScore: number;
  noveltyBonus: number;
  risk: 'low' | 'medium' | 'high';
  reason: string;
  ideaChecklist: boolean[];
  implementationChecklist: boolean[];
  checklist: boolean[];  // combined for backward compat
}

export class ScoringEngine {
  private provider?: LLMProvider;
  private trustContributors: boolean;
  private reputationScores = new Map<string, number>();
  private concurrency: ConcurrencyController;
  private intentClassifier: IntentClassifier;
  private diffAnalyses = new Map<number, DiffAnalysis>();
  private scoringPasses: number;
  private reScoreProvider?: LLMProvider;
  private cascadeEnabled: boolean = false;
  private preFilterThreshold: number = 15;
  private haikuThreshold: number = 40;

  constructor(provider?: LLMProvider, trustContributors?: boolean, maxConcurrent?: number, scoringPasses?: number);
  constructor(options: ScoringEngineOptions);
  constructor(
    providerOrOptions?: LLMProvider | ScoringEngineOptions,
    trustContributors = false,
    maxConcurrent = 5,
    scoringPasses = 1,
  ) {
    // Detection: LLMProvider has generateText, ScoringEngineOptions doesn't
    if (providerOrOptions && typeof providerOrOptions === 'object' && !('generateText' in providerOrOptions)) {
      const opts = providerOrOptions as ScoringEngineOptions;
      this.provider = opts.provider;
      this.trustContributors = opts.trustContributors ?? false;
      this.concurrency = new ConcurrencyController(opts.maxConcurrent ?? 5);
      this.scoringPasses = Math.max(1, opts.scoringPasses ?? 1);
      this.cascadeEnabled = opts.cascade?.enabled ?? false;
      this.reScoreProvider = opts.cascade?.reScoreProvider;
      this.preFilterThreshold = opts.cascade?.preFilterThreshold ?? 15;
      this.haikuThreshold = opts.cascade?.haikuThreshold ?? 40;
    } else {
      // Legacy positional — all existing tests use this path
      this.provider = providerOrOptions as LLMProvider | undefined;
      this.trustContributors = trustContributors;
      this.concurrency = new ConcurrencyController(maxConcurrent);
      this.scoringPasses = Math.max(1, scoringPasses);
    }
    this.intentClassifier = new IntentClassifier(this.provider);
  }

  /** Halve concurrency on rate-limit (429) */
  throttle(): void {
    this.concurrency.throttle();
  }

  /** Current max concurrency value */
  concurrencyMax(): number {
    return this.concurrency.getMaxConcurrent();
  }

  setReputation(login: string, score: number) {
    this.reputationScores.set(login, score);
  }

  setDiffAnalysis(prNumber: number, analysis: DiffAnalysis): void {
    this.diffAnalyses.set(prNumber, analysis);
  }

  /** Score multiple PRs in parallel with concurrency control + percentile rank */
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

    // Percentile rank normalization
    scored.sort((a, b) => a.totalScore - b.totalScore);
    for (let i = 0; i < scored.length; i++) {
      scored[i].percentileRank = scored.length > 1
        ? Math.round((i / (scored.length - 1)) * 100)
        : 50;
    }

    return scored;
  }

  async score(pr: PRData): Promise<ScoredPR> {
    // 1. Intent classification
    const intentResult = await this.intentClassifier.classify(pr.title, pr.body ?? '', pr.changedFiles);

    // 2. All 21 signals (4A: missing=0, 4B: contributor weight=0.04, 4C: intent=0)
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

    // 3. Intent profile weight overrides + normalization
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

    // 4. TOPSIS readiness score
    const topsisScore = this.calculateTOPSIS(signals);

    // 5. Spam detection
    const spamSignal = signals.find(s => s.name === 'spam');
    const isSpam = (spamSignal?.score ?? 100) < 25;

    // 6. Hard penalties on readiness
    let penaltyMultiplier = 1.0;
    if (pr.ciStatus === 'failure') penaltyMultiplier *= 0.4;
    if (pr.mergeable === 'conflicting') penaltyMultiplier *= 0.5;
    if (isSpam) penaltyMultiplier *= 0.2;
    if (pr.isDraft) penaltyMultiplier *= 0.4;
    const isAbandoned = pr.ageInDays > 180 && pr.commentCount <= 1 && pr.reviewState === 'none';
    if (isAbandoned) penaltyMultiplier *= 0.3;
    const readinessScore = Math.round(Math.max(0, Math.min(100, topsisScore * penaltyMultiplier)));

    // 7. LLM dual scoring (CheckEval: idea + implementation) — with cascade support
    let ideaScore: number | undefined;
    let ideaReason: string | undefined;
    let ideaChecklist: boolean[] | undefined;
    let implementationScore: number | undefined;
    let implementationChecklist: boolean[] | undefined;
    let llmRisk: 'low' | 'medium' | 'high' | undefined;
    let scoredBy: 'heuristic' | 'haiku' | 'sonnet' | undefined;
    let noveltyBonusVal: number | undefined;

    if (this.cascadeEnabled && this.provider) {
      // CASCADE PIPELINE
      if (readinessScore < this.preFilterThreshold || isSpam) {
        // Stage 1: Pre-filter — skip LLM entirely
        scoredBy = 'heuristic';
      } else {
        // Stage 2: Haiku pass
        try {
          const haikuResult = await this.scoreLLM(pr);
          ideaScore = haikuResult.ideaScore;
          implementationScore = haikuResult.implementationScore;
          ideaReason = haikuResult.reason;
          llmRisk = haikuResult.risk;
          ideaChecklist = haikuResult.ideaChecklist;
          implementationChecklist = haikuResult.implementationChecklist;
          noveltyBonusVal = haikuResult.noveltyBonus;
          scoredBy = 'haiku';

          // Stage 3: Sonnet re-score if above threshold
          if (ideaScore >= this.haikuThreshold && this.reScoreProvider) {
            try {
              const sonnetResult = await this.scoreLLM(pr, this.reScoreProvider);
              ideaScore = sonnetResult.ideaScore;
              implementationScore = sonnetResult.implementationScore;
              ideaReason = sonnetResult.reason;
              llmRisk = sonnetResult.risk;
              ideaChecklist = sonnetResult.ideaChecklist;
              implementationChecklist = sonnetResult.implementationChecklist;
              noveltyBonusVal = sonnetResult.noveltyBonus;
              scoredBy = 'sonnet';
            } catch (err: any) {
              log.warn({ pr: pr.number, err }, 'Sonnet re-score failed, keeping Haiku');
            }
          }
        } catch (err: any) {
          ideaReason = `LLM failed: ${err.message}`;
          scoredBy = 'heuristic';
          log.warn({ pr: pr.number, err }, 'Haiku scoring failed');
        }
      }
    } else if (this.provider) {
      // Legacy non-cascade path
      try {
        const llmResult = await this.scoreLLM(pr);
        ideaScore = llmResult.ideaScore;
        implementationScore = llmResult.implementationScore;
        ideaReason = llmResult.reason;
        llmRisk = llmResult.risk;
        ideaChecklist = llmResult.ideaChecklist;
        implementationChecklist = llmResult.implementationChecklist;
        noveltyBonusVal = llmResult.noveltyBonus;
      } catch (err: any) {
        ideaReason = `LLM failed: ${err.message}`;
        log.warn({ pr: pr.number, err }, 'LLM scoring failed');
      }
    }

    // 8. Diff analysis bonus (if available)
    const diffAnalysis = this.diffAnalyses.get(pr.number);
    if (diffAnalysis && implementationScore !== undefined) {
      implementationScore = Math.round(0.6 * implementationScore + 0.4 * diffAnalysis.codeQuality);
      if (diffAnalysis.riskAssessment !== 'medium') {
        llmRisk = diffAnalysis.riskAssessment === 'critical' ? 'high' : diffAnalysis.riskAssessment;
      }
    }

    // 9. Combined total score: idea-heavy weighted average
    let totalScore: number;
    if (ideaScore !== undefined && implementationScore !== undefined) {
      totalScore = Math.round(0.7 * ideaScore + 0.3 * implementationScore);
    } else if (ideaScore !== undefined) {
      totalScore = ideaScore;
    } else {
      totalScore = readinessScore; // no LLM = readiness only
    }

    // 10. Tier classification (based on ideaScore)
    const tier = this.assignTier(ideaScore ?? readinessScore, readinessScore);

    // 11. readyToSteal: high-value closed/merged PR we can re-implement
    const readyToSteal = (ideaScore !== undefined && ideaScore >= 70)
      && (implementationScore !== undefined && implementationScore >= 80)
      && (pr.state === 'closed' || pr.state === 'merged');

    return {
      ...pr,
      totalScore,
      signals,
      isSpam,
      spamReasons: isSpam ? [spamSignal?.reason ?? 'Low quality'] : [],
      visionAlignment: 'unchecked',
      // backward compat
      llmScore: ideaScore,
      llmRisk,
      llmReason: ideaReason,
      intent: intentResult.intent,
      diffAnalysis,
      // v0.8 dual scoring
      ideaScore,
      ideaReason,
      ideaChecklist,
      implementationScore,
      implementationReason: ideaReason,
      implementationChecklist,
      readinessScore,
      penaltyMultiplier,
      tier,
      // v0.8 cascade
      scoredBy,
      readyToSteal: readyToSteal ?? false,
      noveltyBonus: noveltyBonusVal,
    };
  }

  /** TOPSIS — distance to ideal/anti-ideal for natural score spread */
  private calculateTOPSIS(signals: SignalScore[]): number {
    const active = signals.filter(s => s.weight > 0);
    if (active.length === 0) return 0;

    // Weighted normalized values
    const weighted = active.map(s => (s.score / 100) * s.weight);
    const weights = active.map(s => s.weight);

    // Distance to ideal (all signals = 100)
    const dPlus = Math.sqrt(
      weighted.reduce((sum, v, i) => sum + Math.pow(weights[i] - v, 2), 0)
    );
    // Distance to anti-ideal (all signals = 0)
    const dMinus = Math.sqrt(
      weighted.reduce((sum, v) => sum + Math.pow(v, 2), 0)
    );

    if (dPlus + dMinus === 0) return 0;
    return (dMinus / (dPlus + dMinus)) * 100;
  }

  /** Assign priority tier based primarily on ideaScore */
  private assignTier(ideaScore: number, _readinessScore: number): 'critical' | 'high' | 'normal' | 'low' {
    if (ideaScore >= 80) return 'critical';
    if (ideaScore >= 60) return 'high';
    if (ideaScore >= 30) return 'normal';
    return 'low';
  }

  /**
   * Hybrid CheckEval — Binary Checklist + Novelty Bonus (EMNLP 2025 + fine-grained)
   * Split into two checklists: 10 idea questions + 5 implementation questions.
   * ideaScore = (idea_yes * 8) + noveltyBonus(0-20)
   *   → base 0-80 from binary + 0-20 continuous bonus = fine-grained 0-100
   * implementationScore = (impl_yes / 5) * 100
   *
   * Multi-pass self-consistency (Wang et al. 2023): when scoringPasses > 1,
   * runs N times with varied temperature and takes median by ideaScore.
   */
  private async scoreLLM(pr: PRData, provider: LLMProvider = this.provider!): Promise<LLMScoringResult> {
    if (this.scoringPasses <= 1) {
      return this.scoreLLMSingle(pr, 0.1, provider);
    }

    // Multi-pass: run N times with slightly higher temperature, take median
    const results = await Promise.all(
      Array.from({ length: this.scoringPasses }, () => this.scoreLLMSingle(pr, 0.4, provider))
    );
    results.sort((a, b) => a.ideaScore - b.ideaScore);
    return results[Math.floor(results.length / 2)];
  }

  private async scoreLLMSingle(pr: PRData, temperature: number, provider: LLMProvider = this.provider!): Promise<LLMScoringResult> {
    const filesStr = pr.changedFiles.slice(0, 30).join(', ');
    const input = `Title: ${pr.title}\nBody: ${(pr.body ?? '').slice(0, 2000)}\nFiles: ${filesStr}`.slice(0, 4000);
    const issueCtx = pr.issueContext ? `\nLinked issue:\n${pr.issueContext.slice(0, 1000)}\n` : '';

    const prompt = `Evaluate this PR on two dimensions by answering each question true or false.

PART A — IDEA VALUE: How valuable is the PROBLEM this PR identifies and the APPROACH it proposes?
Score the idea, not the code. A brilliant idea with terrible code still has high idea value.

IMPORTANT:
- Diff size does NOT determine value. A 4-line fix preventing crashes is MORE valuable than a 500-line cosmetic refactor.
- Security vulnerability fixes (prototype pollution, injection, auth bypass) protect ALL users even if unexploited — high idea value.
- "Silent" problems (memory leaks, credential exposure, data corruption) that cause harm without obvious symptoms are especially valuable to identify.
- Config/default changes that affect ALL installations count as broad impact.
- Community contributions (plugins, skills, integrations, ecosystem docs) have value.
- Documentation that only promotes the author's own unrelated external project is self-promotion, not a contribution.

Idea Questions:
I1. Does this identify a real problem that users or developers actually encounter?
I2. Does this address a security vulnerability, hardening need, or defense-in-depth concern?
I3. Does this address a crash, data loss, or service outage scenario?
I4. Does this solve a performance, reliability, or resource efficiency problem?
I5. Does this propose a meaningful new capability, configuration option, or integration?
I6. Does the identified problem affect a broad base of users or installations?
I7. Is this a "silent" problem — causing harm without obvious symptoms until too late?
I8. Is the proposed approach/solution technically sound for the problem?
I9. Does this represent a non-obvious insight or valuable problem identification?
I10. Would you want this problem fixed in your codebase, regardless of who writes the fix?

PART B — IMPLEMENTATION QUALITY: How well is this PR actually implemented?
Score the code, not the idea. Good code for a bad idea still has high implementation quality.

Implementation Questions:
M1. Is the code integrated into the running system (not standalone/dead code)?
M2. Does the implementation correctly and completely solve the identified problem?
M3. Are there meaningful tests that verify the fix works?
M4. Is the code clean, handling edge cases, without introducing new issues?
M5. Could this be merged as-is without requiring significant rework?

PART C — NOVELTY & SEVERITY BONUS (0-20):
Rate the novelty and severity of the problem this PR identifies. This is a fine-grained continuous score to differentiate PRs with similar binary checklist results.

0-3:   Routine/trivial (typo, lint, cosmetic)
4-7:   Standard bug or minor improvement
8-11:  Valuable problem identification, real user impact
12-15: Important insight — security, data integrity, or architectural gap
16-20: Critical/novel discovery — root cause of multiple issues, paradigm shift, or silent production risk

Calibration anchors (idea / implementation / bonus):
- Security fix timingSafeEqual (3 lines): idea=7/10, impl=5/5, bonus=14
- Null crash fix in UI filter (8 lines): idea=5/10, impl=5/5, bonus=8
- Standalone safety utilities NOT wired in (transcript purge, tool budget): idea=8/10, impl=2/5, bonus=12
- Typo fix in README: idea=0/10, impl=4/5, bonus=0
- Spam/empty PR: idea=0/10, impl=0/5, bonus=0
- Config defaults affecting all users: idea=6/10, impl=4/5, bonus=10
- Community plugin docs (ecosystem page): idea=1/10, impl=4/5, bonus=2
- Proactive security hardening (TLS, auth, defense-in-depth): idea=7/10, impl=5/5, bonus=15
- Critical prototype pollution fix: idea=7/10, impl=5/5, bonus=16
- Crash prevention (catching unhandled I/O failures): idea=6/10, impl=5/5, bonus=13
- Small UX fix (Slack reaction emoji, real bug): idea=3/10, impl=4/5, bonus=4
- Root cause fix affecting 10+ upstream issues: idea=8/10, impl=5/5, bonus=19

Return JSON: {"idea": [true/false x10], "implementation": [true/false x5], "noveltyBonus": <0-20 integer>, "risk": "low"|"medium"|"high", "reason": "<1 sentence: what problem does this identify?>"}
${issueCtx}
${input}`;

    const text = await provider.generateText(prompt, { temperature, maxTokens: 400 });

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in LLM response');
    try {
      const parsed = JSON.parse(match[0]);

      // Parse idea answers (10 questions)
      const ideaAnswers: boolean[] = Array.isArray(parsed.idea)
        ? parsed.idea.slice(0, 10).map((a: unknown) => Boolean(a))
        : [];
      while (ideaAnswers.length < 10) ideaAnswers.push(false);

      // Parse implementation answers (5 questions)
      const implAnswers: boolean[] = Array.isArray(parsed.implementation)
        ? parsed.implementation.slice(0, 5).map((a: unknown) => Boolean(a))
        : [];
      while (implAnswers.length < 5) implAnswers.push(false);

      // Parse novelty bonus (0-20, clamped)
      const rawBonus = typeof parsed.noveltyBonus === 'number' ? parsed.noveltyBonus : 0;
      const noveltyBonus = Math.max(0, Math.min(20, Math.round(rawBonus)));

      // Backward compat: combined checklist
      const combinedChecklist = [...ideaAnswers, ...implAnswers];

      const ideaYes = ideaAnswers.filter(a => a).length;
      const implYes = implAnswers.filter(a => a).length;

      // Hybrid formula: binary base (0-80) + novelty bonus (0-20) = 0-100
      const ideaScore = Math.min(100, ideaYes * 8 + noveltyBonus);
      const implementationScore = Math.round((implYes / 5) * 100);

      return {
        ideaScore,
        implementationScore,
        noveltyBonus,
        risk: ['low', 'medium', 'high'].includes(parsed.risk) ? parsed.risk : 'medium',
        reason: String(parsed.reason ?? ''),
        ideaChecklist: ideaAnswers,
        implementationChecklist: implAnswers,
        checklist: combinedChecklist,
      };
    } catch (parseErr: any) {
      throw new Error(`JSON parse failed: ${parseErr.message}`);
    }
  }

  // --- Original 13 signals (weights adjusted for 18-signal total) ---

  private scoreCI(pr: PRData): SignalScore {
    const scoreMap = { success: 100, pending: 50, failure: 10, unknown: 0 };
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
      FIRST_TIMER: 25, FIRST_TIME_CONTRIBUTOR: 25, NONE: 15,
    };
    let assocScore = trustMap[pr.authorAssociation] ?? 50;
    const repScore = this.reputationScores.get(pr.author);
    const score = repScore !== undefined
      ? Math.round(0.7 * assocScore + 0.3 * repScore)
      : assocScore;
    const repInfo = repScore !== undefined ? `, rep: ${repScore}` : '';
    return { name: 'contributor', score, weight: 0.04, reason: `${pr.author} (${pr.authorAssociation}${repInfo})` };
  }

  private scoreIssueRef(pr: PRData): SignalScore {
    return {
      name: 'issue_ref', score: pr.hasIssueRef ? 90 : 0, weight: 0.07,
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

    // Net-zero detection: code added then reverted
    const netChange = Math.abs(pr.additions - pr.deletions);
    const totalLines = pr.additions + pr.deletions;
    if (totalLines >= 10 && totalLines > 0 && (netChange / totalLines) < 0.05) {
      spamScore += 3; reasons.push(`Reverted/no-op: +${pr.additions}/-${pr.deletions}`);
    }

    if (totalLines < 3) { spamScore += 2; reasons.push('<3 lines'); }
    else if (totalLines < 5) { spamScore++; reasons.push('<5 lines'); }
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

    // Abandoned/incomplete detection: old PR + inactivity signals
    const titleBody = `${pr.title} ${pr.body ?? ''}`.toLowerCase();
    const hasWipMarkers = /\bwip\b|\btodo\b|\bfixme\b|\bhack\b|\bwip:/i.test(pr.title) || pr.isDraft;
    const isAbandoned = days > 180 && pr.commentCount <= 1 && pr.reviewState === 'none';

    if (isAbandoned && hasWipMarkers) {
      score = 5;
      label = 'Abandoned+WIP';
    } else if (isAbandoned) {
      score = Math.min(score, 10);
      label = 'Abandoned';
    } else if (days > 90 && hasWipMarkers) {
      score = Math.min(score, 10);
      label = 'Stale+WIP';
    }

    return { name: 'staleness', score, weight: 0.07, reason: `${days}d old (${label})` };
  }

  private scoreMergeability(pr: PRData): SignalScore {
    const scoreMap = { mergeable: 100, unknown: 50, conflicting: 10 };
    return { name: 'mergeability', score: scoreMap[pr.mergeable], weight: 0.12, reason: `Merge status: ${pr.mergeable}` };
  }

  private scoreReviewStatus(pr: PRData): SignalScore {
    const stateScores: Record<string, number> = {
      approved: 100, changes_requested: 30, commented: 60, none: 0,
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
    else score = 0;
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
      score: pr.milestone ? 90 : 0,
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
    return { name: 'label_priority', score: 0, weight: 0.05, reason: pr.labels.length > 0 ? `Labels: ${pr.labels.join(', ')}` : 'No priority labels' };
  }

  private scoreCodeowners(pr: PRData): SignalScore {
    if (pr.codeowners.length === 0) {
      return { name: 'codeowners', score: 0, weight: 0.05, reason: 'No CODEOWNERS match' };
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
      score: pr.requestedReviewers.length > 0 ? 80 : 0,
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
    // Intent only affects scoring via INTENT_PROFILES weight overrides, not its own score
    return {
      name: 'intent',
      score: 0,
      weight: 0,
      reason: `${result.intent} (${result.reason})`,
    };
  }

  /** Large PR complexity: detect overengineered, massive, or reverted PRs */
  private scoreComplexity(pr: PRData): SignalScore {
    const total = pr.additions + pr.deletions;
    const files = pr.changedFiles;
    if (total === 0) return { name: 'complexity', score: 5, weight: 0.05, reason: 'Empty diff — no actual changes' };

    // Net-zero detection: additions ≈ deletions means code was likely reverted
    const netChange = Math.abs(pr.additions - pr.deletions);
    const churn = total > 0 ? netChange / total : 1;
    if (total >= 10 && churn < 0.05) {
      return { name: 'complexity', score: 5, weight: 0.05, reason: `Reverted/no-op: +${pr.additions}/-${pr.deletions} (net change ${netChange} lines, ${Math.round(churn * 100)}% effective)` };
    }
    if (total >= 20 && churn < 0.15) {
      return { name: 'complexity', score: 20, weight: 0.05, reason: `Near-reverted: +${pr.additions}/-${pr.deletions} (net ${netChange}, ${Math.round(churn * 100)}% effective)` };
    }

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
