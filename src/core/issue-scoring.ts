import type { IssueData, ScoredIssue, SignalScore } from './types';
import type { LLMProvider } from './provider';
import { IntentClassifier, type IntentResult } from './intent';
import { ConcurrencyController } from './concurrency';
import { createLogger } from './logger';

const log = createLogger('issue-scoring');

const SPAM_THRESHOLD = 25;

export class IssueScoringEngine {
  private provider?: LLMProvider;
  private intentClassifier: IntentClassifier;
  private concurrency: ConcurrencyController;

  constructor(provider?: LLMProvider, maxConcurrent = 10) {
    this.provider = provider;
    this.intentClassifier = new IntentClassifier(provider);
    this.concurrency = new ConcurrencyController(maxConcurrent);
  }

  async scoreMany(issues: IssueData[]): Promise<ScoredIssue[]> {
    if (issues.length === 0) return [];
    log.info({ count: issues.length }, 'Scoring issues');

    const results = await Promise.allSettled(
      issues.map(issue => this.concurrency.execute(() => this.score(issue)))
    );

    const scored: ScoredIssue[] = [];
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        scored.push(result.value);
      } else {
        log.warn({ issue: issues[i].number, err: result.reason }, 'Failed to score issue');
      }
    }
    return scored;
  }

  async score(issue: IssueData): Promise<ScoredIssue> {
    const intentResult = await this.intentClassifier.classify(issue.title, issue.body ?? '', []);

    const signals: SignalScore[] = [
      this.scoreStaleness(issue),
      this.scoreBodyQuality(issue),
      this.scoreLabelPriority(issue),
      this.scoreActivity(issue),
      this.scoreContributor(issue),
      this.scoreSpam(issue),
      this.scoreMilestone(issue),
      this.scoreReactions(issue),
      this.scoreLinkedPR(issue),
      this.scoreAssignee(issue),
      this.scoreReproducibility(issue),
      this.scoreIntent(intentResult),
    ];

    const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
    const totalScore = totalWeight > 0
      ? Math.round(signals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight)
      : 0;

    const spamSignal = signals.find(s => s.name === 'spam');
    const isSpam = (spamSignal?.score ?? 100) < SPAM_THRESHOLD;

    return {
      ...issue,
      totalScore,
      signals,
      intent: intentResult.intent,
      isSpam,
      spamReasons: isSpam ? this.collectSpamReasons(issue) : [],
    };
  }

  private collectSpamReasons(issue: IssueData): string[] {
    const reasons: string[] = [];
    const body = issue.body ?? '';
    if (body.length < 20) reasons.push('Empty or very short body');
    if (issue.title.length < 10) reasons.push('Very short title');
    if (issue.labels.length === 0 && issue.commentCount === 0) reasons.push('No labels and no comments');
    const aiMarkers = [/certainly!/i, /as an ai/i, /i apologize/i];
    if (aiMarkers.some(p => p.test(body))) reasons.push('AI-generated language detected');
    if (reasons.length === 0) reasons.push('Low quality content');
    return reasons;
  }

  private scoreStaleness(issue: IssueData): SignalScore {
    const days = Math.floor((Date.now() - new Date(issue.createdAt).getTime()) / (1000 * 60 * 60 * 24));
    let score: number;
    if (days < 7) score = 100;
    else if (days <= 30) score = 70;
    else if (days <= 90) score = 40;
    else score = 15;
    return { name: 'staleness', score, weight: 0.08, reason: `${days}d old` };
  }

  private scoreBodyQuality(issue: IssueData): SignalScore {
    const len = (issue.body ?? '').length;
    let score = len > 500 ? 90 : len >= 200 ? 70 : len >= 50 ? 50 : 20;
    if (/- \[[ x]\]/.test(issue.body ?? '')) score = Math.min(100, score + 10);
    return { name: 'body_quality', score, weight: 0.08, reason: `Body: ${len} chars` };
  }

  private scoreLabelPriority(issue: IssueData): SignalScore {
    const highLabels = ['high-priority', 'urgent', 'critical', 'p0', 'p1', 'security', 'bug'];
    const labels = issue.labels.map(l => l.toLowerCase());
    if (labels.some(l => highLabels.some(h => l.includes(h)))) {
      return { name: 'label_priority', score: 95, weight: 0.10, reason: `High priority: ${issue.labels.join(', ')}` };
    }
    return { name: 'label_priority', score: 50, weight: 0.07, reason: issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : 'No labels' };
  }

  private scoreActivity(issue: IssueData): SignalScore {
    const score = issue.commentCount >= 5 ? 90 : issue.commentCount >= 2 ? 70 : issue.commentCount === 1 ? 50 : 30;
    return { name: 'activity', score, weight: 0.08, reason: `${issue.commentCount} comments` };
  }

  private scoreContributor(issue: IssueData): SignalScore {
    const trustMap: Record<string, number> = { OWNER: 100, MEMBER: 90, COLLABORATOR: 85, CONTRIBUTOR: 70, NONE: 30 };
    return { name: 'contributor', score: trustMap[issue.authorAssociation] ?? 50, weight: 0.08, reason: `${issue.author} (${issue.authorAssociation})` };
  }

  private scoreSpam(issue: IssueData): SignalScore {
    let spamScore = 0;
    const reasons: string[] = [];
    const body = issue.body ?? '';

    if (body.length < 20) { spamScore += 2; reasons.push('Empty/short body'); }
    if (issue.title.length < 10) { spamScore += 2; reasons.push('Short title'); }
    if (issue.labels.length === 0 && issue.commentCount === 0) { spamScore++; reasons.push('No labels/comments'); }
    const aiMarkers = [/certainly!/i, /as an ai/i, /i apologize/i];
    if (aiMarkers.some(p => p.test(body))) { spamScore++; reasons.push('AI language'); }

    return { name: 'spam', score: Math.max(0, 100 - spamScore * 20), weight: 0.10, reason: reasons.length > 0 ? reasons.join(', ') : 'No spam signals' };
  }

  private scoreMilestone(issue: IssueData): SignalScore {
    return { name: 'milestone', score: issue.milestone ? 90 : 40, weight: 0.07, reason: issue.milestone ? `Milestone: ${issue.milestone}` : 'No milestone' };
  }

  private scoreReactions(issue: IssueData): SignalScore {
    const score = issue.reactionCount >= 10 ? 95 : issue.reactionCount >= 5 ? 80 : issue.reactionCount >= 1 ? 60 : 30;
    return { name: 'reaction_score', score, weight: 0.10, reason: `${issue.reactionCount} reactions` };
  }

  private scoreLinkedPR(issue: IssueData): SignalScore {
    return { name: 'has_linked_pr', score: issue.linkedPRs.length > 0 ? 90 : 30, weight: 0.08, reason: issue.linkedPRs.length > 0 ? `Linked to PR(s): ${issue.linkedPRs.map(n => `#${n}`).join(', ')}` : 'No linked PR' };
  }

  private scoreAssignee(issue: IssueData): SignalScore {
    return { name: 'assignee_status', score: issue.assignees.length > 0 ? 80 : 30, weight: 0.07, reason: issue.assignees.length > 0 ? `Assigned: ${issue.assignees.join(', ')}` : 'Unassigned' };
  }

  private scoreReproducibility(issue: IssueData): SignalScore {
    const body = issue.body ?? '';
    let score = 40;
    if (/steps?\s*to\s*reproduce/i.test(body)) score += 20;
    if (/expected|actual/i.test(body)) score += 20;
    if (/```/.test(body)) score += 10;
    score = Math.min(100, score);
    return { name: 'reproducibility', score, weight: 0.07, reason: score >= 80 ? 'Has reproduction steps' : 'Missing reproduction info' };
  }

  private scoreIntent(result: IntentResult): SignalScore {
    const scores: Record<string, number> = { bugfix: 90, feature: 85, refactor: 60, dependency: 35, docs: 30, chore: 25 };
    return { name: 'intent', score: scores[result.intent] ?? 50, weight: 0.09, reason: `${result.intent} (${result.reason})` };
  }
}
