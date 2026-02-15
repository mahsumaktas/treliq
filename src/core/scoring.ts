/**
 * ScoringEngine — Multi-signal PR scoring with LLM-assisted analysis
 */

import type { PRData, ScoredPR, SignalScore } from './types';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export class ScoringEngine {
  private geminiApiKey: string;

  constructor(geminiApiKey?: string) {
    this.geminiApiKey = geminiApiKey ?? process.env.GEMINI_API_KEY ?? '';
  }

  async score(pr: PRData): Promise<ScoredPR> {
    const signals: SignalScore[] = [
      this.scoreCI(pr),
      this.scoreDiffSize(pr),
      this.scoreCommitQuality(pr),
      this.scoreContributor(pr),
      this.scoreIssueRef(pr),
      this.scoreSpam(pr),
    ];

    const heuristicScore = signals.reduce(
      (sum, s) => sum + s.score * s.weight,
      0
    ) / signals.reduce((sum, s) => sum + s.weight, 0);

    const spamSignal = signals.find(s => s.name === 'spam');
    const isSpam = (spamSignal?.score ?? 100) < 30;

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

    const prompt = `Rate this GitHub PR on code quality, completeness, and risk (0-100). Return JSON: {"score": <number>, "risk": "low"|"medium"|"high", "reason": "<brief>"}\n${input}`;

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
    return { name: 'contributor', score: trustMap[pr.authorAssociation] ?? 50, weight: 0.15, reason: `${pr.author} (${pr.authorAssociation})` };
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
    if (pr.commits === 1) { spamScore++; reasons.push('Single commit'); }
    if (pr.filesChanged === 1) { spamScore++; reasons.push('Single file'); }
    if (pr.additions + pr.deletions < 5) { spamScore++; reasons.push('<5 lines'); }
    if (!pr.hasIssueRef) { spamScore++; reasons.push('No issue ref'); }
    const docsOnly = pr.changedFiles.every(f => /readme|contributing|license|changelog|\.md$|\.txt$/i.test(f));
    if (docsOnly && pr.changedFiles.length > 0) { spamScore++; reasons.push('Docs-only change'); }
    return { name: 'spam', score: Math.max(0, 100 - spamScore * 20), weight: 0.15, reason: reasons.length > 0 ? reasons.join(', ') : 'No spam signals' };
  }
}
