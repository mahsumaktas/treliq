/**
 * Integration tests for ScoringEngine
 */

import { ScoringEngine } from '../../src/core/scoring';
import { createPRData } from '../fixtures/pr-factory';
import { MockLLMProvider, dualChecklistResponse } from '../fixtures/mock-provider';

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

  describe('LLM dual scoring', () => {
    it('should produce idea + implementation scores', async () => {
      const provider = new MockLLMProvider();
      // 7*8 + bonus 14 = 70, 4/5 impl → 80
      provider.generateTextResponse = dualChecklistResponse(7, 4, 'low', 'Good implementation', 14);

      const engine = new ScoringEngine(provider);
      const pr = createPRData({
        title: 'feat: add authentication',
        body: 'This PR adds JWT authentication to the API',
        ciStatus: 'success',
        additions: 150,
        hasTests: true,
      });

      const scored = await engine.score(pr);

      expect(scored.llmScore).toBe(70);  // backward compat = ideaScore
      expect(scored.ideaScore).toBe(70);
      expect(scored.implementationScore).toBe(80);
      expect(scored.llmRisk).toBe('low');
      expect(scored.llmReason).toBe('Good implementation');

      // totalScore = 0.7 * idea + 0.3 * implementation
      expect(scored.totalScore).toBe(Math.round(0.7 * 70 + 0.3 * 80));

      // Verify provider was called with hybrid checklist prompt
      expect(provider.generateTextCalls.length).toBe(1);
      expect(provider.generateTextCalls[0].prompt).toContain('feat: add authentication');
      expect(provider.generateTextCalls[0].prompt).toContain('PART A');
      expect(provider.generateTextCalls[0].prompt).toContain('PART B');
      expect(provider.generateTextCalls[0].prompt).toContain('PART C');
    });

    it('should use weighted average formula', async () => {
      const provider = new MockLLMProvider();
      // 8*8 + bonus 16 = 80, 5/5 impl → 100
      provider.generateTextResponse = dualChecklistResponse(8, 5, 'low', 'Test', 16);

      const engine = new ScoringEngine(provider);
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

      expect(scored.ideaScore).toBe(80);
      expect(scored.implementationScore).toBe(100);
      expect(scored.llmScore).toBe(80); // backward compat
      // totalScore = round(0.7 * 80 + 0.3 * 100) = round(56 + 30) = 86
      expect(scored.totalScore).toBe(86);
    });

    it('should handle different LLM risk levels', async () => {
      const provider = new MockLLMProvider();

      // Test low risk
      provider.generateTextResponse = dualChecklistResponse(9, 5, 'low', 'Safe change');
      let engine = new ScoringEngine(provider);
      let scored = await engine.score(createPRData());
      expect(scored.llmRisk).toBe('low');

      // Test medium risk
      provider.reset();
      provider.generateTextResponse = dualChecklistResponse(5, 3, 'medium', 'Some concerns');
      engine = new ScoringEngine(provider);
      scored = await engine.score(createPRData());
      expect(scored.llmRisk).toBe('medium');

      // Test high risk
      provider.reset();
      provider.generateTextResponse = dualChecklistResponse(3, 1, 'high', 'Breaking changes');
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
      // v0.8: scoreMany sorts by totalScore for percentile rank
      const numbers = results.map(r => r.number).sort();
      expect(numbers).toEqual([1, 2, 3]);
      results.forEach(pr => {
        expect(pr.totalScore).toBeGreaterThan(0);
        expect(pr.signals.length).toBeGreaterThan(0);
        expect(pr.percentileRank).toBeDefined();
      });
    });

    it('should handle empty array', async () => {
      const engine = new ScoringEngine();
      const results = await engine.scoreMany([]);
      expect(results).toHaveLength(0);
    });

    it('should process PRs with LLM provider', async () => {
      const provider = new MockLLMProvider();
      // 7*8 + bonus 14 = 70, 4/5 impl → 80
      provider.generateTextResponse = dualChecklistResponse(7, 4, 'low', 'Good', 14);

      const engine = new ScoringEngine(provider);
      const prs = [
        createPRData({ number: 1 }),
        createPRData({ number: 2 }),
      ];

      const results = await engine.scoreMany(prs);

      expect(results).toHaveLength(2);
      expect(results[0].llmScore).toBe(70); // 7*8 + 14
      expect(results[1].llmScore).toBe(70);
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
      expect(scored.llmReason).toBe('LLM failed: LLM API error');
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
      provider.generateTextResponse = '{"invalid": "response"}'; // Missing idea/implementation arrays

      const engine = new ScoringEngine(provider);
      const pr = createPRData();

      const scored = await engine.score(pr);

      // Malformed response: idea=0/10, impl=0/5, both scores are 0
      // totalScore = 0.7*0 + 0.3*0 = 0 — but scoring still completes
      expect(scored.totalScore).toBeGreaterThanOrEqual(0);
      expect(scored.ideaScore).toBe(0);
      expect(scored.implementationScore).toBe(0);
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
        authorAssociation: 'FIRST_TIME_CONTRIBUTOR', // 25 base score (v0.8)
      });

      const scored = await engine.score(pr);

      const contributorSignal = scored.signals.find(s => s.name === 'contributor');
      expect(contributorSignal!.score).toBe(25); // No reputation blend
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

  describe('Diff-enriched scoring blend', () => {
    it('blends implementationScore with diff codeQuality when diff analysis available', async () => {
      const provider = new MockLLMProvider();
      // 8*8 + bonus 16 = 80, 4/5 impl → 80
      provider.generateTextResponse = dualChecklistResponse(8, 4, 'low', 'Good PR', 16);

      const engine = new ScoringEngine(provider);
      engine.setDiffAnalysis(1, {
        prNumber: 1,
        codeQuality: 90,
        riskAssessment: 'low',
        changeType: 'modifying',
        affectedAreas: ['core'],
        summary: 'Improves error handling',
      });

      const pr = createPRData({ number: 1, title: 'fix: improve error handling' });
      const scored = await engine.score(pr);

      // v0.8: implementationScore = 0.6 * checklist + 0.4 * diffQuality = 0.6 * 80 + 0.4 * 90 = 84
      expect(scored.diffAnalysis).toBeDefined();
      expect(scored.diffAnalysis!.codeQuality).toBe(90);
      expect(scored.implementationScore).toBe(Math.round(0.6 * 80 + 0.4 * 90));
      expect(scored.ideaScore).toBe(80); // ideaScore unchanged

      // totalScore = round(0.7 * 80 + 0.3 * 84) = round(56 + 25.2) = 81
      expect(scored.totalScore).toBe(Math.round(0.7 * 80 + 0.3 * 84));
    });

    it('overrides llmRisk from diff riskAssessment', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = dualChecklistResponse(8, 4, 'low', 'ok');

      const engine = new ScoringEngine(provider);
      engine.setDiffAnalysis(1, {
        prNumber: 1,
        codeQuality: 50,
        riskAssessment: 'high',
        changeType: 'removing',
        affectedAreas: ['database'],
        summary: 'Drops migration table',
      });

      const pr = createPRData({ number: 1 });
      const scored = await engine.score(pr);

      expect(scored.llmRisk).toBe('high'); // Overridden by diff
    });

    it('does not override risk when diff says medium', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = dualChecklistResponse(8, 4, 'low', 'ok');

      const engine = new ScoringEngine(provider);
      engine.setDiffAnalysis(1, {
        prNumber: 1,
        codeQuality: 70,
        riskAssessment: 'medium',
        changeType: 'modifying',
        affectedAreas: [],
        summary: 'Normal change',
      });

      const pr = createPRData({ number: 1 });
      const scored = await engine.score(pr);

      expect(scored.llmRisk).toBe('low'); // Not overridden (diff says medium = default)
    });

    it('maps critical diff risk to high llmRisk', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = dualChecklistResponse(8, 4, 'low', 'ok');

      const engine = new ScoringEngine(provider);
      engine.setDiffAnalysis(1, {
        prNumber: 1,
        codeQuality: 30,
        riskAssessment: 'critical',
        changeType: 'removing',
        affectedAreas: ['auth'],
        summary: 'Removes auth middleware',
      });

      const pr = createPRData({ number: 1 });
      const scored = await engine.score(pr);

      expect(scored.llmRisk).toBe('high'); // critical -> high
    });
  });

  describe('Signal coverage', () => {
    it('should generate all 18 signals', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData();

      const scored = await engine.score(pr);

      expect(scored.signals).toHaveLength(21);

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
      expect(signalNames).toContain('intent');
    });

    it('should have valid weights that sum to reasonable total', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData();

      const scored = await engine.score(pr);

      // Filter out intent signal (weight=0 by design in v0.8)
      const activeSignals = scored.signals.filter(s => s.name !== 'intent');
      const totalWeight = activeSignals.reduce((sum, s) => sum + s.weight, 0);

      // Total weight can exceed 1.0 — signals are normalized by total weight in score()
      expect(totalWeight).toBeGreaterThan(0.9);
      expect(totalWeight).toBeLessThan(2.0);

      // Each active signal should have positive weight
      activeSignals.forEach(s => {
        expect(s.weight).toBeGreaterThan(0);
        expect(s.weight).toBeLessThanOrEqual(1);
      });

      // Intent signal should have weight 0 (only affects via profiles)
      const intentSignal = scored.signals.find(s => s.name === 'intent');
      expect(intentSignal?.weight).toBe(0);
    });
  });

  describe('Cascade integration', () => {
    it('cascade reduces LLM calls for mixed-quality batch', async () => {
      const haiku = new MockLLMProvider();
      const sonnet = new MockLLMProvider();

      // Haiku response varies per call: low score for junk, high for quality
      let haikuCallCount = 0;
      haiku.generateTextResponse = (prompt: string) => {
        haikuCallCount++;
        // Quality PRs get high scores, junk gets low
        if (prompt.includes('Quality PR')) {
          return dualChecklistResponse(7, 4, 'low', 'Good PR', 12); // 68 >= 40
        }
        return dualChecklistResponse(1, 1, 'low', 'Junk', 2); // 10 < 40
      };
      sonnet.generateTextResponse = dualChecklistResponse(6, 3, 'medium', 'Sonnet refined', 10);

      const engine = new ScoringEngine({
        provider: haiku,
        cascade: { enabled: true, reScoreProvider: sonnet, haikuThreshold: 40 },
      });

      const prs = [
        createPRData({ number: 1, title: 'Quality PR: auth system', ciStatus: 'success' }),
        createPRData({
          number: 2, title: 'fix typo', body: 'x',
          additions: 1, deletions: 0, hasIssueRef: false, hasTests: false,
          changedFiles: ['README.md'], authorAssociation: 'NONE',
        }),
        createPRData({ number: 3, title: 'Quality PR: security fix', ciStatus: 'success' }),
      ];

      const results = await engine.scoreMany(prs);
      expect(results.length).toBe(3);

      // PR #2 is spam → pre-filtered, no LLM calls
      const spamPR = results.find(r => r.number === 2);
      expect(spamPR?.scoredBy).toBe('heuristic');

      // Quality PRs → Haiku + Sonnet
      const qualityPRs = results.filter(r => r.number !== 2);
      for (const pr of qualityPRs) {
        expect(pr.scoredBy).toBe('sonnet');
      }

      // Sonnet only called for quality PRs (2 calls), not for spam
      expect(sonnet.generateTextCalls.length).toBe(2);
    });

    it('Sonnet prompt identical to Haiku prompt', async () => {
      const haiku = new MockLLMProvider();
      const sonnet = new MockLLMProvider();
      // Haiku above threshold → triggers Sonnet
      haiku.generateTextResponse = dualChecklistResponse(7, 4, 'low', 'Above threshold', 12);
      sonnet.generateTextResponse = dualChecklistResponse(6, 3, 'low', 'Sonnet', 10);

      const engine = new ScoringEngine({
        provider: haiku,
        cascade: { enabled: true, reScoreProvider: sonnet, haikuThreshold: 40 },
      });

      const pr = createPRData({ title: 'feat: new auth module' });
      await engine.score(pr);

      expect(haiku.generateTextCalls.length).toBe(1);
      expect(sonnet.generateTextCalls.length).toBe(1);
      // Both should receive the exact same prompt
      expect(sonnet.generateTextCalls[0].prompt).toBe(haiku.generateTextCalls[0].prompt);
    });

    it('cascade with options-based constructor preserves all settings', async () => {
      const haiku = new MockLLMProvider();
      const sonnet = new MockLLMProvider();
      haiku.generateTextResponse = dualChecklistResponse(3, 2, 'low', 'Below threshold', 4);

      const engine = new ScoringEngine({
        provider: haiku,
        trustContributors: true,
        maxConcurrent: 3,
        cascade: {
          enabled: true,
          reScoreProvider: sonnet,
          preFilterThreshold: 10,
          haikuThreshold: 50,
        },
      });

      const pr = createPRData({ authorAssociation: 'CONTRIBUTOR' });
      const scored = await engine.score(pr);

      // haiku ideaScore = 3*8+4 = 28 < 50 threshold → stays as haiku
      expect(scored.scoredBy).toBe('haiku');
      expect(scored.ideaScore).toBe(28);
      expect(sonnet.generateTextCalls.length).toBe(0);

      // Verify trustContributors works
      const spamSignal = scored.signals.find(s => s.name === 'spam');
      expect(spamSignal?.reason).toContain('Trusted contributor');
    });
  });
});
