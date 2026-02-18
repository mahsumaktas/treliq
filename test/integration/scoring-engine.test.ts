/**
 * Integration tests for ScoringEngine
 */

import { ScoringEngine } from '../../src/core/scoring';
import { createPRData } from '../fixtures/pr-factory';
import { MockLLMProvider } from '../fixtures/mock-provider';

describe('ScoringEngine', () => {
  describe('Heuristic-only scoring (no LLM)', () => {
    it('should score PR using heuristics only', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        number: 1,
        title: 'feat: add new feature',
        ciStatus: 'success',
        additions: 100,
        deletions: 20,
        hasIssueRef: true,
        hasTests: true,
      });

      const scored = await engine.score(pr);

      expect(scored.totalScore).toBeGreaterThan(0);
      expect(scored.totalScore).toBeLessThanOrEqual(100);
      expect(scored.signals.length).toBeGreaterThan(0);
      expect(scored.llmScore).toBeUndefined();
      expect(scored.llmRisk).toBeUndefined();
      expect(scored.llmReason).toBeUndefined();
    });

    it('should calculate weighted heuristic score correctly', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        ciStatus: 'success',        // 100 * 0.15 = 15.0
        additions: 100,             // ~100 * 0.07 = 7.0
        deletions: 20,
        hasIssueRef: true,          // 90 * 0.07 = 6.3
        hasTests: true,             // 90 * 0.12 = 10.8
        mergeable: 'mergeable',     // 100 * 0.12 = 12.0
      });

      const scored = await engine.score(pr);

      expect(scored.signals).toBeDefined();
      expect(scored.totalScore).toBeGreaterThan(50); // Should be high quality PR
    });
  });

  describe('LLM blend scoring', () => {
    it('should blend heuristic and LLM scores', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"score": 75, "risk": "low", "reason": "Good implementation"}';

      const engine = new ScoringEngine(provider);
      const pr = createPRData({
        title: 'feat: add authentication',
        body: 'This PR adds JWT authentication to the API',
        ciStatus: 'success',
        additions: 150,
        hasTests: true,
      });

      const scored = await engine.score(pr);

      expect(scored.llmScore).toBe(75);
      expect(scored.llmRisk).toBe('low');
      expect(scored.llmReason).toBe('Good implementation');

      // totalScore = 0.4 * heuristic + 0.6 * 75
      expect(scored.totalScore).toBeGreaterThan(0);
      expect(scored.totalScore).toBeLessThanOrEqual(100);

      // Verify provider was called
      expect(provider.generateTextCalls.length).toBe(1);
      expect(provider.generateTextCalls[0].prompt).toContain('feat: add authentication');
    });

    it('should use exact blend formula: 0.4 * heuristic + 0.6 * LLM', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"score": 80, "risk": "low", "reason": "Test"}';

      const engine = new ScoringEngine(provider);

      // Create a PR that should score exactly 100 heuristically
      const pr = createPRData({
        ciStatus: 'success',
        additions: 200,
        deletions: 50,
        hasIssueRef: true,
        hasTests: true,
        mergeable: 'mergeable',
        reviewState: 'approved',
        reviewCount: 2,
      });

      const scored = await engine.score(pr);

      // Calculate expected weighted heuristic score
      const heuristicScore = scored.signals.reduce((sum, s) => sum + s.score * s.weight, 0) /
                            scored.signals.reduce((sum, s) => sum + s.weight, 0);

      // Expected: 0.4 * heuristic + 0.6 * 80
      const expected = Math.round(0.4 * heuristicScore + 0.6 * 80);

      expect(scored.llmScore).toBe(80);
      expect(scored.totalScore).toBe(expected);
    });

    it('should handle different LLM risk levels', async () => {
      const provider = new MockLLMProvider();

      // Test low risk
      provider.generateTextResponse = '{"score": 90, "risk": "low", "reason": "Safe change"}';
      let engine = new ScoringEngine(provider);
      let scored = await engine.score(createPRData());
      expect(scored.llmRisk).toBe('low');

      // Test medium risk
      provider.reset();
      provider.generateTextResponse = '{"score": 60, "risk": "medium", "reason": "Some concerns"}';
      engine = new ScoringEngine(provider);
      scored = await engine.score(createPRData());
      expect(scored.llmRisk).toBe('medium');

      // Test high risk
      provider.reset();
      provider.generateTextResponse = '{"score": 30, "risk": "high", "reason": "Breaking changes"}';
      engine = new ScoringEngine(provider);
      scored = await engine.score(createPRData());
      expect(scored.llmRisk).toBe('high');
    });
  });

  describe('scoreMany - batch scoring', () => {
    it('should score multiple PRs successfully', async () => {
      const engine = new ScoringEngine();
      const prs = [
        createPRData({ number: 1, title: 'PR 1' }),
        createPRData({ number: 2, title: 'PR 2' }),
        createPRData({ number: 3, title: 'PR 3' }),
      ];

      const results = await engine.scoreMany(prs);

      expect(results).toHaveLength(3);
      expect(results[0].number).toBe(1);
      expect(results[1].number).toBe(2);
      expect(results[2].number).toBe(3);
      results.forEach(pr => {
        expect(pr.totalScore).toBeGreaterThan(0);
        expect(pr.signals.length).toBeGreaterThan(0);
      });
    });

    it('should handle empty array', async () => {
      const engine = new ScoringEngine();
      const results = await engine.scoreMany([]);
      expect(results).toHaveLength(0);
    });

    it('should process PRs with LLM provider', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"score": 75, "risk": "low", "reason": "Good"}';

      const engine = new ScoringEngine(provider);
      const prs = [
        createPRData({ number: 1 }),
        createPRData({ number: 2 }),
      ];

      const results = await engine.scoreMany(prs);

      expect(results).toHaveLength(2);
      expect(results[0].llmScore).toBe(75);
      expect(results[1].llmScore).toBe(75);
      expect(provider.generateTextCalls.length).toBe(2);
    });
  });

  describe('LLM failure fallback', () => {
    it('should fall back to heuristic-only on LLM error', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = () => {
        throw new Error('LLM API error');
      };

      const engine = new ScoringEngine(provider);
      const pr = createPRData({
        title: 'feat: test PR',
        ciStatus: 'success',
        hasTests: true,
      });

      const scored = await engine.score(pr);

      // Should complete successfully with heuristic-only
      expect(scored.totalScore).toBeGreaterThan(0);
      expect(scored.llmScore).toBeUndefined();
      expect(scored.llmRisk).toBeUndefined();
      expect(scored.llmReason).toBeUndefined();
    });

    it('should fall back on invalid JSON from LLM', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = 'This is not valid JSON';

      const engine = new ScoringEngine(provider);
      const pr = createPRData();

      const scored = await engine.score(pr);

      expect(scored.totalScore).toBeGreaterThan(0);
      expect(scored.llmScore).toBeUndefined();
    });

    it('should fall back on malformed LLM response', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"invalid": "response"}'; // Missing score/risk/reason

      const engine = new ScoringEngine(provider);
      const pr = createPRData();

      const scored = await engine.score(pr);

      // Should still work, potentially with default/clamped values
      expect(scored.totalScore).toBeGreaterThan(0);
    });
  });

  describe('Spam detection', () => {
    it('should detect spam PR with low additions and no issue ref', async () => {
      const engine = new ScoringEngine();
      const spamPR = createPRData({
        number: 1,
        title: 'fix typo',
        body: 'typo',
        additions: 2,           // Very low
        deletions: 0,
        hasIssueRef: false,     // No issue reference
        hasTests: false,
        changedFiles: ['README.md'],
      });

      const scored = await engine.score(spamPR);

      expect(scored.isSpam).toBe(true);
      expect(scored.spamReasons.length).toBeGreaterThan(0);

      // Find spam signal
      const spamSignal = scored.signals.find(s => s.name === 'spam');
      expect(spamSignal).toBeDefined();
      expect(spamSignal!.score).toBeLessThan(25); // Spam threshold
    });

    it('should not mark quality PR as spam', async () => {
      const engine = new ScoringEngine();
      const qualityPR = createPRData({
        title: 'feat: add authentication system',
        body: 'This PR implements JWT-based authentication with proper error handling and tests.',
        additions: 200,
        deletions: 10,
        hasIssueRef: true,
        hasTests: true,
        changedFiles: ['src/auth.ts', 'test/auth.test.ts'],
      });

      const scored = await engine.score(qualityPR);

      expect(scored.isSpam).toBe(false);

      const spamSignal = scored.signals.find(s => s.name === 'spam');
      expect(spamSignal!.score).toBeGreaterThanOrEqual(25);
    });

    it('should detect docs-only trivial changes as spam', async () => {
      const engine = new ScoringEngine();
      const trivialDocsPR = createPRData({
        title: 'fix typo',
        body: 'Fixed a typo',
        additions: 1,
        deletions: 1,
        hasIssueRef: false,
        changedFiles: ['README.md'],
      });

      const scored = await engine.score(trivialDocsPR);

      expect(scored.isSpam).toBe(true);

      const spamSignal = scored.signals.find(s => s.name === 'spam');
      expect(spamSignal?.reason).toContain('lines');
    });

    it('should detect AI-generated spam markers', async () => {
      const engine = new ScoringEngine();
      const aiSpamPR = createPRData({
        title: 'fix: update code',
        body: "Certainly! I'd be happy to help you with this change. Here's the corrected version.",
        additions: 5,
        deletions: 2,
        hasIssueRef: false,
      });

      const scored = await engine.score(aiSpamPR);

      const spamSignal = scored.signals.find(s => s.name === 'spam');
      expect(spamSignal?.score).toBeLessThan(100); // Should detect AI language
    });
  });

  describe('Reputation blending', () => {
    it('should blend contributor association with reputation score', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        author: 'trusted-dev',
        authorAssociation: 'CONTRIBUTOR', // 70 base score
      });

      // Set reputation score
      engine.setReputation('trusted-dev', 90); // High reputation

      const scored = await engine.score(pr);

      const contributorSignal = scored.signals.find(s => s.name === 'contributor');
      expect(contributorSignal).toBeDefined();

      // Score should be: 0.7 * 70 + 0.3 * 90 = 49 + 27 = 76
      expect(contributorSignal!.score).toBe(76);
      expect(contributorSignal!.reason).toContain('rep: 90');
    });

    it('should use pure association score when no reputation set', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        author: 'new-contributor',
        authorAssociation: 'FIRST_TIME_CONTRIBUTOR', // 40 base score
      });

      const scored = await engine.score(pr);

      const contributorSignal = scored.signals.find(s => s.name === 'contributor');
      expect(contributorSignal!.score).toBe(40); // No reputation blend
      expect(contributorSignal!.reason).not.toContain('rep:');
    });

    it('should handle different reputation scores', async () => {
      const engine = new ScoringEngine();

      // Low reputation
      engine.setReputation('low-rep-user', 20);
      let pr = createPRData({
        author: 'low-rep-user',
        authorAssociation: 'CONTRIBUTOR', // 70
      });

      let scored = await engine.score(pr);
      let signal = scored.signals.find(s => s.name === 'contributor');
      // 0.7 * 70 + 0.3 * 20 = 49 + 6 = 55
      expect(signal!.score).toBe(55);

      // High reputation
      engine.setReputation('high-rep-user', 100);
      pr = createPRData({
        author: 'high-rep-user',
        authorAssociation: 'CONTRIBUTOR', // 70
      });

      scored = await engine.score(pr);
      signal = scored.signals.find(s => s.name === 'contributor');
      // 0.7 * 70 + 0.3 * 100 = 49 + 30 = 79
      expect(signal!.score).toBe(79);
    });

    it('should handle OWNER with reputation', async () => {
      const engine = new ScoringEngine();
      engine.setReputation('owner-user', 95);

      const pr = createPRData({
        author: 'owner-user',
        authorAssociation: 'OWNER', // 100 base
      });

      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'contributor');

      // 0.7 * 100 + 0.3 * 95 = 70 + 28.5 = 98.5 -> Math.round(98.5) = 99
      expect(signal!.score).toBe(99);
    });
  });

  describe('Signal coverage', () => {
    it('should generate all 18 signals', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData();

      const scored = await engine.score(pr);

      expect(scored.signals).toHaveLength(20);

      const signalNames = scored.signals.map(s => s.name);
      expect(signalNames).toContain('ci_status');
      expect(signalNames).toContain('diff_size');
      expect(signalNames).toContain('commit_quality');
      expect(signalNames).toContain('contributor');
      expect(signalNames).toContain('issue_ref');
      expect(signalNames).toContain('spam');
      expect(signalNames).toContain('test_coverage');
      expect(signalNames).toContain('staleness');
      expect(signalNames).toContain('mergeability');
      expect(signalNames).toContain('review_status');
      expect(signalNames).toContain('body_quality');
      expect(signalNames).toContain('activity');
      expect(signalNames).toContain('breaking_change');
      expect(signalNames).toContain('draft_status');
      expect(signalNames).toContain('milestone');
      expect(signalNames).toContain('label_priority');
      expect(signalNames).toContain('codeowners');
      expect(signalNames).toContain('requested_reviewers');
      expect(signalNames).toContain('scope_coherence');
      expect(signalNames).toContain('complexity');
    });

    it('should have valid weights that sum to reasonable total', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData();

      const scored = await engine.score(pr);

      const totalWeight = scored.signals.reduce((sum, s) => sum + s.weight, 0);

      // Total weight can exceed 1.0 — signals are normalized by total weight in score()
      expect(totalWeight).toBeGreaterThan(0.9);
      expect(totalWeight).toBeLessThan(2.0);

      // Each signal should have positive weight
      scored.signals.forEach(s => {
        expect(s.weight).toBeGreaterThan(0);
        expect(s.weight).toBeLessThanOrEqual(1);
      });
    });
  });
});
