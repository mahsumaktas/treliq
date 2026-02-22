import { DiffAnalyzer } from '../../src/core/diff-analyzer';
import { MockLLMProvider } from '../fixtures/mock-provider';
import type { Octokit } from '@octokit/rest';

function mockOctokit(diffText: string): Octokit {
  return {
    request: jest.fn().mockResolvedValue({
      data: diffText,
    }),
  } as any;
}

describe('DiffAnalyzer', () => {
  it('fetches diff and returns LLM analysis', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      codeQuality: 85,
      riskAssessment: 'low',
      changeType: 'modifying',
      affectedAreas: ['auth', 'api'],
      summary: 'Fixes auth timeout handling',
    });

    const octokit = mockOctokit('diff --git a/src/auth.ts\n+fix timeout');
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    const results = await analyzer.analyzeMany([42]);

    expect(results.length).toBe(1);
    expect(results[0].prNumber).toBe(42);
    expect(results[0].codeQuality).toBe(85);
    expect(results[0].riskAssessment).toBe('low');
    expect(results[0].affectedAreas).toEqual(['auth', 'api']);
  });

  it('truncates diffs longer than 10000 chars', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      codeQuality: 50,
      riskAssessment: 'medium',
      changeType: 'mixed',
      affectedAreas: [],
      summary: 'Large diff',
    });

    const longDiff = 'x'.repeat(20000);
    const octokit = mockOctokit(longDiff);
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    await analyzer.analyzeMany([1]);

    const promptUsed = provider.generateTextCalls[0].prompt;
    expect(promptUsed.length).toBeLessThanOrEqual(12000); // 10k diff + prompt overhead
  });

  it('handles diff fetch failure gracefully', async () => {
    const provider = new MockLLMProvider();
    const octokit = {
      request: jest.fn().mockRejectedValue(new Error('404 Not Found')),
    } as any;

    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    const results = await analyzer.analyzeMany([99]);

    expect(results).toEqual([]);
  });

  it('handles LLM failure gracefully', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = 'not valid json at all';

    const octokit = mockOctokit('diff content');
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    const results = await analyzer.analyzeMany([42]);

    expect(results).toEqual([]);
  });

  it('handles invalid JSON fields with defaults', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      codeQuality: 200,
      riskAssessment: 'extreme',
      changeType: 'unknown',
    });

    const octokit = mockOctokit('diff content');
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    const results = await analyzer.analyzeMany([1]);

    expect(results[0].codeQuality).toBe(100); // clamped
    expect(results[0].riskAssessment).toBe('medium'); // invalid -> default
    expect(results[0].changeType).toBe('mixed'); // invalid -> default
  });

  it('analyzes multiple PRs in parallel', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      codeQuality: 70,
      riskAssessment: 'low',
      changeType: 'additive',
      affectedAreas: ['core'],
      summary: 'OK',
    });

    const octokit = mockOctokit('diff');
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    const results = await analyzer.analyzeMany([1, 2, 3]);

    expect(results.length).toBe(3);
    expect(results.map(r => r.prNumber)).toEqual([1, 2, 3]);
  });

  it('works without LLM provider (returns empty)', async () => {
    const octokit = mockOctokit('diff');
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo');
    const results = await analyzer.analyzeMany([1]);

    expect(results).toEqual([]);
  });
});
