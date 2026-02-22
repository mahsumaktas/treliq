/**
 * Unit tests for ScoringEngine
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

    it('scores unknown as 40', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ ciStatus: 'unknown' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'ci_status');
      expect(signal?.score).toBe(40);
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

    it('scores NONE as 30', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ authorAssociation: 'NONE' });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'contributor');
      expect(signal?.score).toBe(30);
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

    it('scores without issue reference as 30', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ hasIssueRef: false, issueNumbers: [] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'issue_ref');
      expect(signal?.score).toBe(30);
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

    it('scores 0 comments as 30', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ commentCount: 0 });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'activity');
      expect(signal?.score).toBe(30);
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

    it('scores without milestone as 40', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ milestone: undefined });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'milestone');
      expect(signal?.score).toBe(40);
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

    it('scores no labels as 50', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ labels: [] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'label_priority');
      expect(signal?.score).toBe(50);
    });
  });

  describe('codeowners signal', () => {
    it('scores no codeowners as 40', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ codeowners: [] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'codeowners');
      expect(signal?.score).toBe(40);
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

    it('scores without reviewers as 40', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ requestedReviewers: [] });
      const scored = await engine.score(pr);
      const signal = scored.signals.find(s => s.name === 'requested_reviewers');
      expect(signal?.score).toBe(40);
    });
  });

  describe('intent signal', () => {
    it('scores bugfix intent as 90', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'fix: resolve auth crash' });
      const scored = await engine.score(pr);
      const intentSignal = scored.signals.find(s => s.name === 'intent');
      expect(intentSignal).toBeDefined();
      expect(intentSignal!.score).toBe(90);
      expect(scored.intent).toBe('bugfix');
    });

    it('scores feature intent as 85', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'feat: add dark mode' });
      const scored = await engine.score(pr);
      const intentSignal = scored.signals.find(s => s.name === 'intent');
      expect(intentSignal!.score).toBe(85);
      expect(scored.intent).toBe('feature');
    });

    it('scores dependency intent as 35', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'chore(deps): bump lodash' });
      const scored = await engine.score(pr);
      const intentSignal = scored.signals.find(s => s.name === 'intent');
      expect(intentSignal!.score).toBe(35);
      expect(scored.intent).toBe('dependency');
    });

    it('scores docs intent as 30', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'docs: update API reference' });
      const scored = await engine.score(pr);
      const intentSignal = scored.signals.find(s => s.name === 'intent');
      expect(intentSignal!.score).toBe(30);
      expect(scored.intent).toBe('docs');
    });

    it('scores chore intent as 25', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'ci: fix GitHub Actions workflow' });
      const scored = await engine.score(pr);
      const intentSignal = scored.signals.find(s => s.name === 'intent');
      expect(intentSignal!.score).toBe(25);
      expect(scored.intent).toBe('chore');
    });

    it('uses heuristic for non-conventional titles', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData({ title: 'Fix crash on login page', changedFiles: ['src/auth.ts'] });
      const scored = await engine.score(pr);
      expect(scored.intent).toBe('bugfix');
    });
  });

  describe('LLM integration', () => {
    it('blends heuristic and LLM scores with 0.4/0.6 ratio', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"score": 75, "risk": "low", "reason": "Test"}';
      const engine = new ScoringEngine(provider);

      const pr = createPRData();
      const scored = await engine.score(pr);

      // Calculate heuristic score
      const totalWeight = scored.signals.reduce((sum, s) => sum + s.weight, 0);
      const heuristicScore = scored.signals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight;

      // Expected: 0.4 * heuristic + 0.6 * 75
      const expected = Math.round(0.4 * heuristicScore + 0.6 * 75);
      expect(scored.totalScore).toBe(expected);
      expect(scored.llmScore).toBe(75);
      expect(scored.llmRisk).toBe('low');
    });

    it('uses heuristic-only score when no provider', async () => {
      const engine = new ScoringEngine();
      const pr = createPRData();
      const scored = await engine.score(pr);

      // Calculate heuristic score
      const totalWeight = scored.signals.reduce((sum, s) => sum + s.weight, 0);
      const heuristicScore = scored.signals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight;

      expect(scored.totalScore).toBe(Math.round(heuristicScore));
      expect(scored.llmScore).toBeUndefined();
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
