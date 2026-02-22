import { SemanticMatcher } from '../../src/core/semantic-matcher';
import { MockLLMProvider } from '../fixtures/mock-provider';
import { createScoredPR, createScoredIssue } from '../fixtures/pr-factory';
import type { DiffAnalysis } from '../../src/core/types';

describe('SemanticMatcher', () => {
  it('returns full match with bidirectional score impact', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      matchQuality: 'full',
      confidence: 0.95,
      reason: 'PR directly fixes the reported Safari issue',
    });

    const pr = createScoredPR({
      number: 42,
      title: 'fix: Safari auth crash',
      issueNumbers: [10],
      totalScore: 75,
    });
    const issue = createScoredIssue({
      number: 10,
      title: 'Login crashes on Safari',
      linkedPRs: [42],
      totalScore: 60,
    });

    const matcher = new SemanticMatcher(provider);
    const { matches, prBonuses, issueScoreUpdates } = await matcher.matchAll([pr], [issue]);

    expect(matches.length).toBe(1);
    expect(matches[0].matchQuality).toBe('full');
    expect(prBonuses.get(42)).toBe(8);
    expect(issueScoreUpdates.get(10)).toBe(95);
  });

  it('returns partial match', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      matchQuality: 'partial',
      confidence: 0.6,
      reason: 'Addresses part of the issue',
    });

    const pr = createScoredPR({ number: 1, issueNumbers: [2], totalScore: 70 });
    const issue = createScoredIssue({ number: 2, linkedPRs: [1] });

    const matcher = new SemanticMatcher(provider);
    const { matches, prBonuses, issueScoreUpdates } = await matcher.matchAll([pr], [issue]);

    expect(prBonuses.get(1)).toBe(3);
    expect(issueScoreUpdates.get(2)).toBe(70);
  });

  it('penalizes unrelated match', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      matchQuality: 'unrelated',
      confidence: 0.9,
      reason: 'PR does not address this issue',
    });

    const pr = createScoredPR({ number: 1, issueNumbers: [2], totalScore: 80 });
    const issue = createScoredIssue({ number: 2, linkedPRs: [1] });

    const matcher = new SemanticMatcher(provider);
    const { prBonuses, issueScoreUpdates } = await matcher.matchAll([pr], [issue]);

    expect(prBonuses.get(1)).toBe(-5);
    expect(issueScoreUpdates.get(2)).toBe(40);
  });

  it('skips pairs with no issue reference', async () => {
    const provider = new MockLLMProvider();

    const pr = createScoredPR({ number: 1, issueNumbers: [] });
    const issue = createScoredIssue({ number: 2 });

    const matcher = new SemanticMatcher(provider);
    const { matches } = await matcher.matchAll([pr], [issue]);

    expect(matches.length).toBe(0);
    expect(provider.generateTextCalls.length).toBe(0);
  });

  it('returns empty when no provider', async () => {
    const pr = createScoredPR({ number: 1, issueNumbers: [2] });
    const issue = createScoredIssue({ number: 2, linkedPRs: [1] });

    const matcher = new SemanticMatcher();
    const { matches } = await matcher.matchAll([pr], [issue]);

    expect(matches.length).toBe(0);
  });

  it('handles LLM failure gracefully', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = 'not json';

    const pr = createScoredPR({ number: 1, issueNumbers: [2] });
    const issue = createScoredIssue({ number: 2, linkedPRs: [1] });

    const matcher = new SemanticMatcher(provider);
    const { matches } = await matcher.matchAll([pr], [issue]);

    expect(matches.length).toBe(0);
  });

  it('includes diff summary in prompt when available', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      matchQuality: 'full', confidence: 0.9, reason: 'ok',
    });

    const diffMap = new Map<number, DiffAnalysis>();
    diffMap.set(1, {
      prNumber: 1,
      codeQuality: 80,
      riskAssessment: 'low',
      changeType: 'modifying',
      affectedAreas: ['auth'],
      summary: 'Fixes Safari touch handling',
    });

    const pr = createScoredPR({ number: 1, issueNumbers: [2] });
    const issue = createScoredIssue({ number: 2, linkedPRs: [1] });

    const matcher = new SemanticMatcher(provider);
    await matcher.matchAll([pr], [issue], diffMap);

    const prompt = provider.generateTextCalls[0].prompt;
    expect(prompt).toContain('Fixes Safari touch handling');
  });
});
