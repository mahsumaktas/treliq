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
});
