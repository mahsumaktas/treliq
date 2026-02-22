import { DedupEngine } from '../../src/core/dedup';
import { MockLLMProvider } from '../fixtures/mock-provider';
import { createScoredPR } from '../fixtures/pr-factory';

describe('DedupEngine LLM Verification', () => {
  it('dissolves cluster when LLM says not duplicate', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      isDuplicate: false,
      reason: 'Different problems',
      subgroups: [],
    });
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('login')) return [1, 0, 0];
      if (text.includes('auth')) return [0.99, 0.01, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login bug', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth fix', totalScore: 92 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2], undefined, true);

    expect(clusters.length).toBe(0);
  });

  it('keeps cluster and updates bestPR from LLM recommendation', async () => {
    const provider = new MockLLMProvider();
    let callCount = 0;
    provider.generateTextResponse = () => {
      callCount++;
      if (callCount === 1) return JSON.stringify({ isDuplicate: true, reason: 'Same fix', subgroups: [] });
      return JSON.stringify({ bestPR: 10, reason: 'Better tests' });
    };
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('login')) return [1, 0, 0];
      if (text.includes('auth')) return [0.99, 0.01, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login bug', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth login fix', totalScore: 92 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2], undefined, true);

    expect(clusters.length).toBe(1);
    expect(clusters[0].bestPR).toBe(10); // LLM picked 10 over score-higher 11
  });

  it('splits cluster into subgroups', async () => {
    const provider = new MockLLMProvider();
    let callCount = 0;
    provider.generateTextResponse = () => {
      callCount++;
      if (callCount === 1) return JSON.stringify({ isDuplicate: true, reason: 'Partial match', subgroups: [[10, 11], [12]] });
      return JSON.stringify({ bestPR: 11, reason: 'More complete' });
    };
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('PR 10')) return [1, 0, 0];
      if (text.includes('PR 11')) return [0.99, 0.01, 0];
      if (text.includes('PR 12')) return [0.98, 0.02, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'PR 10 fix', totalScore: 60 });
    const pr2 = createScoredPR({ number: 11, title: 'PR 11 fix', totalScore: 80 });
    const pr3 = createScoredPR({ number: 12, title: 'PR 12 fix', totalScore: 70 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2, pr3], undefined, true);

    // Subgroup [10,11] becomes cluster, [12] alone is dissolved
    expect(clusters.length).toBe(1);
    expect(clusters[0].prs.map(p => p.number).sort()).toEqual([10, 11]);
  });

  it('skips verification when verifyWithLLM is false', async () => {
    const provider = new MockLLMProvider();
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('login')) return [1, 0, 0];
      if (text.includes('auth')) return [0.99, 0.01, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth login fix', totalScore: 92 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2], undefined, false);

    expect(clusters.length).toBe(1);
    expect(clusters[0].bestPR).toBe(11); // score-based, not LLM
    // generateText should NOT have been called
    expect(provider.generateTextCalls.length).toBe(0);
  });

  it('falls back to score-based best when LLM best selection fails', async () => {
    const provider = new MockLLMProvider();
    let callCount = 0;
    provider.generateTextResponse = () => {
      callCount++;
      if (callCount === 1) return JSON.stringify({ isDuplicate: true, reason: 'Same', subgroups: [] });
      return 'invalid json';
    };
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('login')) return [1, 0, 0];
      if (text.includes('auth')) return [0.99, 0.01, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth login fix', totalScore: 92 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2], undefined, true);

    expect(clusters.length).toBe(1);
    expect(clusters[0].bestPR).toBe(11); // score-based fallback
  });

  it('handles verification LLM failure gracefully', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = () => { throw new Error('LLM down'); };
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('login')) return [1, 0, 0];
      if (text.includes('auth')) return [0.99, 0.01, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login bug', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth login fix', totalScore: 92 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2], undefined, true);

    // Should keep original cluster when verification fails
    expect(clusters.length).toBe(1);
  });
});
