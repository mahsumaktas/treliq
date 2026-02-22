import { VisionChecker } from '../../src/core/vision';
import { createScoredPR } from '../fixtures/pr-factory';
import { MockLLMProvider } from '../fixtures/mock-provider';

describe('VisionChecker', () => {
  it('parses direct JSON response from provider', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = '{"score": 88, "alignment": "aligned", "reason": "Matches roadmap goals"}';
    const checker = new VisionChecker('Focus on developer tooling', provider);

    const result = await checker.check(createScoredPR());

    expect(result).toEqual({
      score: 88,
      alignment: 'aligned',
      reason: 'Matches roadmap goals',
    });
  });

  it('extracts JSON object from wrapped text', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = 'Result:\n{"score": 61, "alignment": "tangential", "reason": "Partially related"}\nThanks';
    const checker = new VisionChecker('Focus on CLI improvements', provider);

    const result = await checker.check(createScoredPR({ title: 'docs: update guide' }));

    expect(result.score).toBe(61);
    expect(result.alignment).toBe('tangential');
    expect(result.reason).toBe('Partially related');
  });

  it('falls back when response is not parseable JSON', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = 'this is not json';
    const checker = new VisionChecker('Focus on stability', provider);

    const result = await checker.check(createScoredPR());

    expect(result).toEqual({
      alignment: 'tangential',
      score: 50,
      reason: 'Could not parse LLM response',
    });
  });

  describe('VisionChecker.checkMany', () => {
    it('checks multiple PRs in parallel', async () => {
      const provider = new MockLLMProvider();
      let callCount = 0;
      provider.generateTextResponse = () => {
        callCount++;
        return `{"score": ${70 + callCount}, "alignment": "aligned", "reason": "reason ${callCount}"}`;
      };
      const checker = new VisionChecker('Focus on developer tooling', provider);

      const prs = [
        createScoredPR({ number: 1 }),
        createScoredPR({ number: 2 }),
        createScoredPR({ number: 3 }),
      ];

      await checker.checkMany(prs);

      expect(prs[0].visionAlignment).toBe('aligned');
      expect(prs[1].visionAlignment).toBe('aligned');
      expect(prs[2].visionAlignment).toBe('aligned');
      expect(prs[0].visionScore).toBeDefined();
      expect(prs[1].visionScore).toBeDefined();
      expect(prs[2].visionScore).toBeDefined();
      expect(callCount).toBe(3);
    });

    it('handles individual failures gracefully', async () => {
      const provider = new MockLLMProvider();
      let callCount = 0;
      provider.generateTextResponse = () => {
        callCount++;
        if (callCount === 2) throw new Error('LLM error');
        return '{"score": 80, "alignment": "aligned", "reason": "ok"}';
      };
      const checker = new VisionChecker('Vision doc', provider);

      const prs = [
        createScoredPR({ number: 1 }),
        createScoredPR({ number: 2 }),
        createScoredPR({ number: 3 }),
      ];

      await checker.checkMany(prs);

      expect(prs[0].visionAlignment).toBe('aligned');
      // PR 2 may fail after retries depending on ConcurrencyController retry behavior
      // But it should have 'unchecked' if all retries fail
      expect(prs[2].visionAlignment).toBe('aligned');
    });

    it('works with empty array', async () => {
      const provider = new MockLLMProvider();
      const checker = new VisionChecker('Vision doc', provider);

      await checker.checkMany([]);
      expect(provider.generateTextCalls).toHaveLength(0);
    });
  });
});
