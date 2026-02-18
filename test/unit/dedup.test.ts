import { DedupEngine } from '../../src/core/dedup';
import type { LLMProvider } from '../../src/core/provider';
import { createScoredPR } from '../fixtures/pr-factory';

describe('DedupEngine', () => {
  it('returns empty clusters for fewer than 2 PRs', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      generateText: jest.fn(),
      generateEmbedding: jest.fn().mockResolvedValue([1, 0, 0]),
    };
    const engine = new DedupEngine(0.85, 0.8, provider);

    const clusters = await engine.findDuplicates([createScoredPR({ number: 1 })]);

    expect(clusters).toEqual([]);
  });

  it('clusters semantically similar PRs and picks highest score as best', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      generateText: jest.fn(),
      generateEmbedding: jest.fn().mockImplementation(async (text: string) => {
        if (text.includes('login')) return [1, 0, 0];
        if (text.includes('auth')) return [0.99, 0.01, 0];
        return [0, 1, 0];
      }),
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login bug', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth login regression fix', totalScore: 92 });
    const pr3 = createScoredPR({ number: 12, title: 'docs: update README', totalScore: 70 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2, pr3]);

    expect(clusters.length).toBe(1);
    expect(clusters[0].bestPR).toBe(11);
    expect(clusters[0].prs.map(p => p.number).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(pr1.duplicateGroup).toBe(0);
    expect(pr2.duplicateGroup).toBe(0);
    expect(pr3.duplicateGroup).toBeUndefined();
  });

  it('stops embedding after 5 consecutive failures', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      generateText: jest.fn(),
      generateEmbedding: jest.fn().mockRejectedValue(new Error('embedding failed')),
    };

    const prs = [1, 2, 3, 4, 5, 6].map(n => createScoredPR({ number: n, title: `PR ${n}` }));
    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates(prs);

    expect(clusters).toEqual([]);
    expect(provider.generateEmbedding).toHaveBeenCalledTimes(5);
  });
});
