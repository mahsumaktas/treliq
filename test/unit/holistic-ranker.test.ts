import { HolisticRanker } from '../../src/core/holistic-ranker';
import { MockLLMProvider } from '../fixtures/mock-provider';
import { createScoredPR, createScoredIssue } from '../fixtures/pr-factory';
import type { TriageItem } from '../../src/core/types';

describe('HolisticRanker', () => {
  it('ranks items with single group (< 50 items)', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      ranked: [3, 1, 2],
      reasoning: 'PR #3 is critical bugfix',
    });

    const items: TriageItem[] = [
      createScoredPR({ number: 1, totalScore: 80 }),
      createScoredPR({ number: 2, totalScore: 70 }),
      createScoredPR({ number: 3, totalScore: 60 }),
    ];

    const ranker = new HolisticRanker(provider);
    const result = await ranker.rank(items);

    expect(result.get(3)).toBe(1); // LLM ranked #3 first
    expect(result.get(1)).toBe(2);
    expect(result.get(2)).toBe(3);
  });

  it('applies bonus to adjustedScore', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      ranked: [1, 2],
      reasoning: 'ok',
    });

    const items: TriageItem[] = [
      createScoredPR({ number: 1, totalScore: 50 }),
      createScoredPR({ number: 2, totalScore: 50 }),
    ];

    const ranker = new HolisticRanker(provider);
    const rankings = await ranker.rank(items);

    // Rank #1 gets (16-1)*2 = 30 bonus
    expect(HolisticRanker.calculateAdjustedScore(50, rankings.get(1))).toBe(80);
    // Rank #2 gets (16-2)*2 = 28 bonus
    expect(HolisticRanker.calculateAdjustedScore(50, rankings.get(2))).toBe(78);
    // Unranked gets 0 bonus
    expect(HolisticRanker.calculateAdjustedScore(50, undefined)).toBe(50);
  });

  it('handles LLM failure gracefully (returns empty rankings)', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = 'not valid json';

    const items: TriageItem[] = [
      createScoredPR({ number: 1, totalScore: 80 }),
      createScoredPR({ number: 2, totalScore: 70 }),
    ];

    const ranker = new HolisticRanker(provider);
    const result = await ranker.rank(items);

    expect(result.size).toBe(0);
  });

  it('works without provider (returns empty)', async () => {
    const items: TriageItem[] = [
      createScoredPR({ number: 1, totalScore: 80 }),
    ];

    const ranker = new HolisticRanker();
    const result = await ranker.rank(items);

    expect(result.size).toBe(0);
  });

  it('handles tournament with multiple groups', async () => {
    const provider = new MockLLMProvider();
    let callNum = 0;
    provider.generateTextResponse = () => {
      callNum++;
      if (callNum <= 2) {
        // Group rounds: pick first 10 from each group
        const start = (callNum - 1) * 50;
        const ranked = Array.from({ length: 10 }, (_, i) => start + i);
        return JSON.stringify({ ranked, reasoning: `Group ${callNum}` });
      }
      // Final round: pick top 15
      const ranked = Array.from({ length: 15 }, (_, i) => i);
      return JSON.stringify({ ranked, reasoning: 'Final' });
    };

    // 80 items -> 2 groups of 50 (second has 30)
    const items: TriageItem[] = Array.from({ length: 80 }, (_, i) =>
      createScoredPR({ number: i, totalScore: 80 - i })
    );

    const ranker = new HolisticRanker(provider, 50);
    const result = await ranker.rank(items);

    // Should have called LLM 3 times: 2 groups + 1 final
    expect(provider.generateTextCalls.length).toBe(3);
    // Top 15 should have ranks
    expect(result.size).toBeLessThanOrEqual(15);
  });

  it('includes mixed PR and Issue items', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      ranked: [10, 20],
      reasoning: 'Issue #10 is critical, PR #20 fixes it',
    });

    const items: TriageItem[] = [
      createScoredIssue({ number: 10, totalScore: 90 }),
      createScoredPR({ number: 20, totalScore: 80 }),
    ];

    const ranker = new HolisticRanker(provider);
    const result = await ranker.rank(items);

    expect(result.get(10)).toBe(1);
    expect(result.get(20)).toBe(2);
  });

  it('filters out invalid item numbers from LLM response', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      ranked: [1, 999, 2], // 999 doesn't exist
      reasoning: 'ok',
    });

    const items: TriageItem[] = [
      createScoredPR({ number: 1, totalScore: 80 }),
      createScoredPR({ number: 2, totalScore: 70 }),
    ];

    const ranker = new HolisticRanker(provider);
    const result = await ranker.rank(items);

    expect(result.get(1)).toBe(1);
    expect(result.get(2)).toBe(2);
    expect(result.has(999)).toBe(false);
  });
});
