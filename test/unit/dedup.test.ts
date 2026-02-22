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

  it('handles individual embedding failures gracefully', async () => {
    const provider: LLMProvider = {
      name: 'mock',
      generateText: jest.fn(),
      generateEmbedding: jest.fn().mockRejectedValue(new Error('embedding failed')),
    };

    const prs = [1, 2, 3, 4, 5, 6].map(n => createScoredPR({ number: n, title: `PR ${n}` }));
    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates(prs);

    expect(clusters).toEqual([]);
    // All 6 PRs attempted; ConcurrencyController retries each 2 times (3 calls per PR)
    expect(provider.generateEmbedding).toHaveBeenCalledTimes(18);
  });

  it('uses batch embedding when provider supports it', async () => {
    const batchFn = jest.fn().mockResolvedValue([
      [1, 0, 0],
      [0.99, 0.01, 0],
      [0, 1, 0],
    ]);
    const provider: any = {
      name: 'mock-batch',
      generateText: jest.fn(),
      generateEmbedding: jest.fn(),
      generateEmbeddingBatch: batchFn,
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login bug', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth fix', totalScore: 92 });
    const pr3 = createScoredPR({ number: 12, title: 'docs update', totalScore: 70 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2, pr3]);

    expect(batchFn).toHaveBeenCalledTimes(1);
    expect(provider.generateEmbedding).not.toHaveBeenCalled();
    expect(clusters.length).toBe(1);
  });

  it('falls back to parallel individual embedding when batch not supported', async () => {
    const provider: LLMProvider = {
      name: 'mock-no-batch',
      generateText: jest.fn(),
      generateEmbedding: jest.fn().mockImplementation(async (text: string) => {
        if (text.includes('login')) return [1, 0, 0];
        return [0, 1, 0];
      }),
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login bug', totalScore: 65 });
    const pr2 = createScoredPR({ number: 12, title: 'docs update', totalScore: 70 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    await engine.findDuplicates([pr1, pr2]);

    expect(provider.generateEmbedding).toHaveBeenCalledTimes(2);
  });

  it('falls back to parallel when batch fails', async () => {
    const batchFn = jest.fn().mockRejectedValue(new Error('batch failed'));
    const provider: any = {
      name: 'mock-batch-fail',
      generateText: jest.fn(),
      generateEmbedding: jest.fn().mockResolvedValue([0.5, 0.5, 0]),
      generateEmbeddingBatch: batchFn,
    };

    const pr1 = createScoredPR({ number: 10, title: 'PR A', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'PR B', totalScore: 70 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    await engine.findDuplicates([pr1, pr2]);

    expect(batchFn).toHaveBeenCalledTimes(1);
    // Should fall back to individual
    expect(provider.generateEmbedding).toHaveBeenCalledTimes(2);
  });
});
