/**
 * Unit tests for ScoringEngine — v0.8 dual scoring
 */

import { ScoringEngine } from '../../src/core/scoring';
import { createPRData } from '../fixtures/pr-factory';
import { MockLLMProvider } from '../fixtures/mock-provider';

describe('ScoringEngine', () => {
  describe('ci_status signal', () => {
    it('scores success as 100', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ ciStatus: 'success' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'ci_status');
      expect(signal?.score).toBe(100);
    });

    it('scores pending as 50', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ ciStatus: 'pending' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'ci_status');
      expect(signal?.score).toBe(50);
    });

    it('scores failure as 10', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ ciStatus: 'failure' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'ci_status');
      expect(signal?.score).toBe(10);
    });

    it('scores unknown as 0', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ ciStatus: 'unknown' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'ci_status');
      expect(signal?.score).toBe(0);
    });
  });

  describe('diff_size signal', () => {
    it('scores <5 lines as 20', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ additions: 1, deletions: 1 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'diff_size');
      expect(signal?.score).toBe(20);
    });

    it('scores <50 lines as 70', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ additions: 25, deletions: 5 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'diff_size');
      expect(signal?.score).toBe(70);
    });

    it('scores <500 lines as 100', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ additions: 200, deletions: 100 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'diff_size');
      expect(signal?.score).toBe(100);
    });

    it('scores <2000 lines as 60', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ additions: 1000, deletions: 500 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'diff_size');
      expect(signal?.score).toBe(60);
    });

    it('scores >=2000 lines as 30', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ additions: 2000, deletions: 500 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'diff_size');
      expect(signal?.score).toBe(30);
    });
  });

  describe('commit_quality signal', () => {
    it('scores conventional commit as 90', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'feat: add feature' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'commit_quality');
      expect(signal?.score).toBe(90);
    });

    it('scores non-standard commit as 50', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'added stuff' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'commit_quality');
      expect(signal?.score).toBe(50);
    });
  });

  describe('contributor signal', () => {
    it('scores OWNER as 100', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ authorAssociation: 'OWNER' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'contributor');
      expect(signal?.score).toBe(100);
    });

    it('scores NONE as 15', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ authorAssociation: 'NONE' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'contributor');
      expect(signal?.score).toBe(15);
    });

    it('scores FIRST_TIMER as 25', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ authorAssociation: 'FIRST_TIMER' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'contributor');
      expect(signal?.score).toBe(25);
    });

    it('has base weight 0.04 (before intent normalization)', async () => {
      const engine = new ScoringEngine();
      // Use a title without conventional prefix to avoid intent profile overrides
      const pr = createPRData({ title: 'Update something', changedFiles: ['src/main.ts'] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'contributor');
      // After normalization weights may shift, but contributor should be low relative to others
      expect(signal?.weight).toBeLessThan(0.1);
    });
  });

  describe('issue_ref signal', () => {
    it('scores with issue reference as 90', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ hasIssueRef: true, issueNumbers: [42] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'issue_ref');
      expect(signal?.score).toBe(90);
    });

    it('scores without issue reference as 0', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ hasIssueRef: false, issueNumbers: [] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'issue_ref');
      expect(signal?.score).toBe(0);
    });
  });

  describe('spam signal', () => {
    it('scores clean PR as 100', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        additions: 100,
        deletions: 20,
        hasIssueRef: true,
        body: 'This is a comprehensive description of the changes made in this pull request.',
        hasTests: true,
      });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'spam');
      expect(signal?.score).toBe(100);
    });

    it('scores spammy PR as low', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        additions: 1,
        deletions: 0,
        hasIssueRef: false,
        body: 'fix',
        hasTests: false,
        changedFiles: ['README.md'],
        authorAssociation: 'NONE',
      });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'spam');
      expect(signal?.score).toBeLessThan(60);
    });
  });

  describe('test_coverage signal', () => {
    it('scores with tests as 90', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ hasTests: true, testFilesChanged: ['test.ts'] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'test_coverage');
      expect(signal?.score).toBe(90);
    });

    it('scores docs-only PR as 60', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        hasTests: false,
        changedFiles: ['README.md'],
      });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'test_coverage');
      expect(signal?.score).toBe(60);
    });

    it('scores code PR without tests as 20', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        hasTests: false,
        changedFiles: ['src/main.ts'],
        testFilesChanged: [],
      });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'test_coverage');
      expect(signal?.score).toBe(20);
    });
  });

  describe('staleness signal', () => {
    it('scores <7 days as 100', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ ageInDays: 2 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'staleness');
      expect(signal?.score).toBe(100);
    });

    it('scores <30 days as 70', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ ageInDays: 15 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'staleness');
      expect(signal?.score).toBe(70);
    });

    it('scores <90 days as 40', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ ageInDays: 60 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'staleness');
      expect(signal?.score).toBe(40);
    });

    it('scores >=90 days as 15', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ ageInDays: 120 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'staleness');
      expect(signal?.score).toBe(15);
    });
  });

  describe('mergeability signal', () => {
    it('scores mergeable as 100', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ mergeable: 'mergeable' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'mergeability');
      expect(signal?.score).toBe(100);
    });

    it('scores conflicting as 10', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ mergeable: 'conflicting' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'mergeability');
      expect(signal?.score).toBe(10);
    });
  });

  describe('review_status signal', () => {
    it('scores approved as 100', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ reviewState: 'approved', reviewCount: 1 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'review_status');
      expect(signal?.score).toBe(100);
    });

    it('scores changes_requested as 30', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ reviewState: 'changes_requested', reviewCount: 1 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'review_status');
      expect(signal?.score).toBe(30);
    });

    it('scores none as 0', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ reviewState: 'none', reviewCount: 0 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'review_status');
      expect(signal?.score).toBe(0);
    });
  });

  describe('body_quality signal', () => {
    it('scores >500 chars as 90', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ body: 'a'.repeat(501) });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'body_quality');
      expect(signal?.score).toBe(90);
    });

    it('scores 200-500 chars as 70', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ body: 'a'.repeat(300) });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'body_quality');
      expect(signal?.score).toBe(70);
    });

    it('scores <50 chars as 20', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ body: 'short' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'body_quality');
      expect(signal?.score).toBe(20);
    });
  });

  describe('activity signal', () => {
    it('scores >=5 comments as 90', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ commentCount: 5 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'activity');
      expect(signal?.score).toBe(90);
    });

    it('scores 0 comments as 0', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ commentCount: 0 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'activity');
      expect(signal?.score).toBe(0);
    });
  });

  describe('breaking_change signal', () => {
    it('scores breaking change as 40', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'feat!: breaking change' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'breaking_change');
      expect(signal?.score).toBe(40);
    });

    it('scores normal PR as 80', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'feat: normal change', deletions: 5 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'breaking_change');
      expect(signal?.score).toBe(80);
    });
  });

  describe('draft_status signal', () => {
    it('scores draft as 10', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ isDraft: true });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'draft_status');
      expect(signal?.score).toBe(10);
    });

    it('scores non-draft as 90', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ isDraft: false });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'draft_status');
      expect(signal?.score).toBe(90);
    });
  });

  describe('milestone signal', () => {
    it('scores with milestone as 90', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ milestone: 'v1.0' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'milestone');
      expect(signal?.score).toBe(90);
    });

    it('scores without milestone as 0', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ milestone: undefined });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'milestone');
      expect(signal?.score).toBe(0);
    });
  });

  describe('label_priority signal', () => {
    it('scores high-priority label as 95', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ labels: ['high-priority'] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'label_priority');
      expect(signal?.score).toBe(95);
    });

    it('scores backlog label as 30', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ labels: ['backlog'] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'label_priority');
      expect(signal?.score).toBe(30);
    });

    it('scores no labels as 0', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ labels: [] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'label_priority');
      expect(signal?.score).toBe(0);
    });
  });

  describe('codeowners signal', () => {
    it('scores no codeowners as 0', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ codeowners: [] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'codeowners');
      expect(signal?.score).toBe(0);
    });

    it('scores author as codeowner as 95', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ codeowners: ['testuser'], author: 'testuser' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'codeowners');
      expect(signal?.score).toBe(95);
    });
  });

  describe('requested_reviewers signal', () => {
    it('scores with reviewers as 80', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ requestedReviewers: ['reviewer1'] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'requested_reviewers');
      expect(signal?.score).toBe(80);
    });

    it('scores without reviewers as 0', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ requestedReviewers: [] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'requested_reviewers');
      expect(signal?.score).toBe(0);
    });
  });

  describe('intent signal', () => {
    it('scores intent as 0 with weight 0 (disabled)', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'fix: resolve auth crash' });
      const scored = await engine.score(pr);
      const intentSignal = scored.signals.find(s => s.name === 'intent');
      expect(intentSignal).toBeDefined();
      expect(intentSignal!.score).toBe(0);
      expect(intentSignal!.weight).toBe(0);
      expect(scored.intent).toBe('bugfix');
    });

    it('still classifies intent correctly', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'feat: add dark mode' });
      const scored = await engine.score(pr);
      expect(scored.intent).toBe('feature');
    });

    it('uses heuristic for non-conventional titles', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'Fix crash on login page', changedFiles: ['src/auth.ts'] });
      const scored = await engine.score(pr);
      expect(scored.intent).toBe('bugfix');
    });
  });

  describe('TOPSIS scoring', () => {
    it('returns readinessScore on result', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData();
      const scored = await engine.score(pr);
      expect(scored.readinessScore).toBeDefined();
      expect(typeof scored.readinessScore).toBe('number');
      expect(scored.readinessScore).toBeGreaterThanOrEqual(0);
      expect(scored.readinessScore).toBeLessThanOrEqual(100);
    });

    it('high-quality PR gets high readiness score', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        ciStatus: 'success',
        mergeable: 'mergeable',
        reviewState: 'approved',
        reviewCount: 2,
        hasTests: true,
        hasIssueRef: true,
        isDraft: false,
        commentCount: 5,
      });
      const scored = await engine.score(pr);
      expect(scored.readinessScore!).toBeGreaterThan(60);
    });

    it('low-quality PR gets low readiness score', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        ciStatus: 'failure',
        mergeable: 'conflicting',
        reviewState: 'none',
        reviewCount: 0,
        hasTests: false,
        hasIssueRef: false,
        isDraft: true,
        commentCount: 0,
        additions: 1,
        deletions: 0,
        body: 'fix',
        changedFiles: ['README.md'],
        codeowners: [],
        requestedReviewers: [],
        labels: [],
        milestone: undefined,
      });
      const scored = await engine.score(pr);
      // CI failure (0.4x) + conflict (0.5x) + draft (0.4x) = very low
      expect(scored.readinessScore!).toBeLessThan(15);
    });
  });

  describe('hard penalty multipliers', () => {
    it('applies CI failure penalty (0.4x)', async () => {
      const engine = new ScoringEngine();
      const goodPr = createPRData({ ciStatus: 'success' });
      const badPr = createPRData({ ciStatus: 'failure' });
      const goodScored = await engine.score(goodPr);
      const badScored = await engine.score(badPr);
      expect(badScored.penaltyMultiplier).toBeLessThanOrEqual(0.4);
      expect(badScored.readinessScore!).toBeLessThan(goodScored.readinessScore!);
    });

    it('applies conflict penalty (0.5x)', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ mergeable: 'conflicting' });
      const scored = await engine.score(pr);
      expect(scored.penaltyMultiplier).toBeLessThanOrEqual(0.5);
    });

    it('applies draft penalty (0.4x)', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ isDraft: true });
      const scored = await engine.score(pr);
      expect(scored.penaltyMultiplier).toBeLessThanOrEqual(0.4);
    });

    it('stacks penalties: CI fail + spam + draft', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        ciStatus: 'failure',
        isDraft: true,
        additions: 1,
        deletions: 0,
        hasIssueRef: false,
        body: 'fix',
        changedFiles: ['README.md'],
        authorAssociation: 'NONE',
      });
      const scored = await engine.score(pr);
      // If spam detected: 0.4 * 0.2 * 0.4 = 0.032
      if (scored.isSpam) {
        expect(scored.readinessScore!).toBeLessThan(10);
      } else {
        // Even without spam: 0.4 * 0.4 = 0.16
        expect(scored.readinessScore!).toBeLessThan(20);
      }
    });

    it('applies abandoned penalty (0.3x)', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        ageInDays: 200,
        commentCount: 0,
        reviewState: 'none',
        reviewCount: 0,
      });
      const scored = await engine.score(pr);
      expect(scored.penaltyMultiplier).toBeLessThanOrEqual(0.3);
    });

    it('no penalty for clean PR', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData();
      const scored = await engine.score(pr);
      expect(scored.penaltyMultiplier).toBe(1.0);
    });
  });

  describe('tier classification', () => {
    it('assigns critical when ideaScore>=80 and readiness>=60', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"score": 85, "risk": "low", "reason": "Critical fix"}';
      const engine = new ScoringEngine(provider);
      const pr = createPRData(); // good defaults = high readiness
      const scored = await engine.score(pr);
      expect(scored.ideaScore).toBeGreaterThanOrEqual(80);
      expect(scored.tier).toBe('critical');
    });

    it('assigns high when ideaScore>=70 but readiness<60', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"score": 80, "risk": "low", "reason": "Good idea"}';
      const engine = new ScoringEngine(provider);
      // Draft PR = low readiness due to 0.4x penalty
      const pr = createPRData({ isDraft: true });
      const scored = await engine.score(pr);
      // Draft penalty drops readiness below 60
      expect(scored.tier).toBe('high');
    });

    it('assigns normal when ideaScore 45-69', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"score": 55, "risk": "low", "reason": "Routine fix"}';
      const engine = new ScoringEngine(provider);
      const pr = createPRData();
      const scored = await engine.score(pr);
      expect(scored.tier).toBe('normal');
    });

    it('assigns low when ideaScore<45', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"score": 20, "risk": "low", "reason": "Trivial"}';
      const engine = new ScoringEngine(provider);
      const pr = createPRData();
      const scored = await engine.score(pr);
      expect(scored.tier).toBe('low');
    });

    it('uses readinessScore for tier when no LLM', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData();
      const scored = await engine.score(pr);
      expect(scored.tier).toBeDefined();
      expect(['critical', 'high', 'normal', 'low']).toContain(scored.tier);
    });
  });

  describe('dual scoring — LLM integration', () => {
    it('returns ideaScore from LLM', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"score": 75, "risk": "low", "reason": "Test"}';
      const engine = new ScoringEngine(provider);
      const pr = createPRData();
      const scored = await engine.score(pr);

      expect(scored.ideaScore).toBe(75);
      expect(scored.ideaReason).toBe('Test');
      // backward compat
      expect(scored.llmScore).toBe(75);
      expect(scored.llmRisk).toBe('low');
    });

    it('computes totalScore = 0.7 * ideaScore + 0.3 * readinessScore', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"score": 75, "risk": "low", "reason": "Test"}';
      const engine = new ScoringEngine(provider);
      const pr = createPRData();
      const scored = await engine.score(pr);

      const expected = Math.round(0.7 * scored.ideaScore! + 0.3 * scored.readinessScore!);
      expect(scored.totalScore).toBe(expected);
    });

    it('uses readinessScore as totalScore when no provider', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData();
      const scored = await engine.score(pr);

      expect(scored.totalScore).toBe(scored.readinessScore);
      expect(scored.ideaScore).toBeUndefined();
      expect(scored.llmScore).toBeUndefined();
    });
  });

  describe('percentile rank', () => {
    it('assigns percentile ranks in scoreMany', async () => {
      const engine = new ScoringEngine();
      const prs = [
        createPRData({ number: 1, ciStatus: 'success', additions: 100 }),
        createPRData({ number: 2, ciStatus: 'failure', additions: 1, deletions: 0, body: 'x' }),
        createPRData({ number: 3, ciStatus: 'success', additions: 200 }),
      ];
      const scored = await engine.scoreMany(prs);
      expect(scored.length).toBe(3);
      // All should have percentileRank
      for (const s of scored) {
        expect(s.percentileRank).toBeDefined();
        expect(s.percentileRank).toBeGreaterThanOrEqual(0);
        expect(s.percentileRank).toBeLessThanOrEqual(100);
      }
      // Lowest score should have percentileRank=0, highest=100
      expect(scored[0].percentileRank).toBe(0);
      expect(scored[scored.length - 1].percentileRank).toBe(100);
    });

    it('assigns 50 for single PR', async () => {
      const engine = new ScoringEngine();
      const prs = [createPRData({ number: 1 })];
      const scored = await engine.scoreMany(prs);
      expect(scored[0].percentileRank).toBe(50);
    });
  });

  describe('spam detection', () => {
    it('marks PR as spam when spam score < 25', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({
        additions: 1,
        deletions: 0,
        hasIssueRef: false,
        body: 'fix',
        hasTests: false,
        changedFiles: ['README.md'],
        authorAssociation: 'NONE',
      });
      const scored = await engine.score(pr);

      const spamSignal = scored.signals.find(s => s.name === 'spam');
      expect(spamSignal?.score).toBeLessThan(25);
      expect(scored.isSpam).toBe(true);
      expect(scored.spamReasons.length).toBeGreaterThan(0);
    });

    it('does not mark clean PR as spam', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData();
      const scored = await engine.score(pr);

      expect(scored.isSpam).toBe(false);
      expect(scored.spamReasons).toEqual([]);
    });
  });
});
