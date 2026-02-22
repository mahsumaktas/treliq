/**
 * HolisticRanker — Tournament-style cross-item re-ranking via LLM
 */

import type { LLMProvider } from './provider';
import type { TriageItem } from './types';
import { createLogger } from './logger';

const log = createLogger('holistic-ranker');

export class HolisticRanker {
  private provider?: LLMProvider;
  private groupSize: number;

  constructor(provider?: LLMProvider, groupSize = 50) {
    this.provider = provider;
    this.groupSize = groupSize;
  }

  static calculateAdjustedScore(totalScore: number, holisticRank?: number): number {
    if (!holisticRank) return totalScore;
    return totalScore + (16 - holisticRank) * 2;
  }

  async rank(items: TriageItem[]): Promise<Map<number, number>> {
    const rankings = new Map<number, number>();
    if (!this.provider || items.length === 0) return rankings;

    const validNumbers = new Set(items.map(i => i.number));

    try {
      if (items.length <= this.groupSize) {
        // Single group — direct ranking
        const ranked = await this.rankGroup(items, 15);
        const filtered = ranked.filter(n => validNumbers.has(n));
        for (let i = 0; i < filtered.length; i++) {
          rankings.set(filtered[i], i + 1);
        }
      } else {
        // Multi-group tournament
        const groups: TriageItem[][] = [];
        for (let i = 0; i < items.length; i += this.groupSize) {
          groups.push(items.slice(i, i + this.groupSize));
        }

        // Group rounds: pick top 10 per group
        const finalists: number[] = [];
        for (const group of groups) {
          const ranked = await this.rankGroup(group, 10);
          finalists.push(...ranked.filter(n => validNumbers.has(n)));
        }

        // Final round: rank all finalists, pick top 15
        const finalistItems = items.filter(i => finalists.includes(i.number));
        const finalRanked = await this.rankGroup(finalistItems, 15);
        const filtered = finalRanked.filter(n => validNumbers.has(n));
        for (let i = 0; i < filtered.length; i++) {
          rankings.set(filtered[i], i + 1);
        }
      }
    } catch (err) {
      log.warn({ err }, 'Holistic ranking failed');
    }

    return rankings;
  }

  private async rankGroup(items: TriageItem[], topN: number): Promise<number[]> {
    const summaries = items.map(item => {
      const type = 'changedFiles' in item ? 'PR' : 'Issue';
      const intent = item.intent ?? 'unknown';
      const risk = 'llmRisk' in item ? (item as any).llmRisk ?? 'unknown' : 'n/a';
      const diff = 'diffAnalysis' in item && (item as any).diffAnalysis
        ? `diff:"${(item as any).diffAnalysis.summary}"`
        : '';
      return `#${item.number} [${type}] score:${item.totalScore} intent:${intent} risk:${risk} ${diff} "${item.title}"`;
    }).join('\n');

    const prompt = `You are triaging a GitHub repository. Rank the top ${topN} most important items to review/merge/address first.
Consider: code quality, risk level, intent, issue resolution, community demand.

Items:
${summaries}

Return JSON: {"ranked": [<item numbers in priority order>], "reasoning": "<brief>"}`;

    const text = await this.provider!.generateText(prompt, { temperature: 0.2, maxTokens: 500 });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];

    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.ranked)) {
        return parsed.ranked.map(Number).filter((n: number) => !isNaN(n)).slice(0, topN);
      }
    } catch {
      // invalid JSON
    }

    return [];
  }
}
