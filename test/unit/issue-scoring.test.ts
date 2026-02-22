import { IssueScoringEngine } from '../../src/core/issue-scoring';
import { createIssueData } from '../fixtures/pr-factory';

describe('IssueScoringEngine', () => {
  let engine: IssueScoringEngine;

  beforeEach(() => {
    engine = new IssueScoringEngine();
  });

  it('scores a typical issue', async () => {
    const issue = createIssueData({ commentCount: 3, reactionCount: 5 });
    const scored = await engine.score(issue);
    expect(scored.totalScore).toBeGreaterThan(0);
    expect(scored.totalScore).toBeLessThanOrEqual(100);
    expect(scored.signals.length).toBe(12);
    expect(scored.isSpam).toBe(false);
  });

  it('detects spam issues (empty body, short title)', async () => {
    const issue = createIssueData({ body: '', title: 'hi', labels: [], commentCount: 0 });
    const scored = await engine.score(issue);
    expect(scored.isSpam).toBe(true);
    expect(scored.spamReasons.length).toBeGreaterThan(0);
  });

  it('scores high for popular issues with reactions', async () => {
    const popular = createIssueData({ reactionCount: 20, commentCount: 10, labels: ['bug', 'high-priority'] });
    const boring = createIssueData({ reactionCount: 0, commentCount: 0 });
    const scoredPop = await engine.score(popular);
    const scoredBor = await engine.score(boring);
    expect(scoredPop.totalScore).toBeGreaterThan(scoredBor.totalScore);
  });

  it('includes has_linked_pr signal', async () => {
    const withPR = createIssueData({ linkedPRs: [42] });
    const scored = await engine.score(withPR);
    const signal = scored.signals.find(s => s.name === 'has_linked_pr');
    expect(signal).toBeDefined();
    expect(signal!.score).toBe(90);
  });

  it('includes reproducibility signal', async () => {
    const withSteps = createIssueData({ body: 'Steps to reproduce:\n1. Open app\n2. Click login\n\nExpected: Login works\nActual: Crash' });
    const scored = await engine.score(withSteps);
    const signal = scored.signals.find(s => s.name === 'reproducibility');
    expect(signal).toBeDefined();
    expect(signal!.score).toBeGreaterThanOrEqual(80);
  });

  it('includes assignee signal', async () => {
    const assigned = createIssueData({ assignees: ['alice'] });
    const unassigned = createIssueData({ assignees: [] });
    const scoredA = await engine.score(assigned);
    const scoredU = await engine.score(unassigned);
    const sigA = scoredA.signals.find(s => s.name === 'assignee_status')!;
    const sigU = scoredU.signals.find(s => s.name === 'assignee_status')!;
    expect(sigA.score).toBeGreaterThan(sigU.score);
  });

  it('includes intent signal', async () => {
    const issue = createIssueData({ title: 'fix: crash on startup' });
    const scored = await engine.score(issue);
    expect(scored.intent).toBe('bugfix');
  });

  it('scores many issues in parallel', async () => {
    const issues = Array.from({ length: 10 }, (_, i) => createIssueData({ number: i + 1 }));
    const scored = await engine.scoreMany(issues);
    expect(scored).toHaveLength(10);
  });

  describe('individual signals', () => {
    it('staleness: fresh issues score higher', async () => {
      const fresh = createIssueData({ createdAt: new Date(Date.now() - 86400000).toISOString() });
      const stale = createIssueData({ createdAt: new Date(Date.now() - 86400000 * 120).toISOString() });
      const scoredF = await engine.score(fresh);
      const scoredS = await engine.score(stale);
      const sigF = scoredF.signals.find(s => s.name === 'staleness')!;
      const sigS = scoredS.signals.find(s => s.name === 'staleness')!;
      expect(sigF.score).toBeGreaterThan(sigS.score);
    });

    it('body_quality: long body scores higher', async () => {
      const good = createIssueData({ body: 'a'.repeat(600) });
      const bad = createIssueData({ body: 'hi' });
      const scoredG = await engine.score(good);
      const scoredB = await engine.score(bad);
      const sigG = scoredG.signals.find(s => s.name === 'body_quality')!;
      const sigB = scoredB.signals.find(s => s.name === 'body_quality')!;
      expect(sigG.score).toBeGreaterThan(sigB.score);
    });

    it('label_priority: high priority labels score higher', async () => {
      const high = createIssueData({ labels: ['critical'] });
      const none = createIssueData({ labels: [] });
      const scoredH = await engine.score(high);
      const scoredN = await engine.score(none);
      const sigH = scoredH.signals.find(s => s.name === 'label_priority')!;
      const sigN = scoredN.signals.find(s => s.name === 'label_priority')!;
      expect(sigH.score).toBeGreaterThan(sigN.score);
    });

    it('milestone: issues with milestone score higher', async () => {
      const withMs = createIssueData({ milestone: 'v1.0' });
      const without = createIssueData({ milestone: undefined });
      const scoredW = await engine.score(withMs);
      const scoredWo = await engine.score(without);
      const sigW = scoredW.signals.find(s => s.name === 'milestone')!;
      const sigWo = scoredWo.signals.find(s => s.name === 'milestone')!;
      expect(sigW.score).toBeGreaterThan(sigWo.score);
    });

    it('contributor: OWNER scores higher than NONE', async () => {
      const owner = createIssueData({ authorAssociation: 'OWNER' });
      const anon = createIssueData({ authorAssociation: 'NONE' });
      const scoredO = await engine.score(owner);
      const scoredA = await engine.score(anon);
      const sigO = scoredO.signals.find(s => s.name === 'contributor')!;
      const sigA = scoredA.signals.find(s => s.name === 'contributor')!;
      expect(sigO.score).toBeGreaterThan(sigA.score);
    });

    it('reaction_score: high reactions score higher', async () => {
      const popular = createIssueData({ reactionCount: 15 });
      const quiet = createIssueData({ reactionCount: 0 });
      const scoredP = await engine.score(popular);
      const scoredQ = await engine.score(quiet);
      const sigP = scoredP.signals.find(s => s.name === 'reaction_score')!;
      const sigQ = scoredQ.signals.find(s => s.name === 'reaction_score')!;
      expect(sigP.score).toBeGreaterThan(sigQ.score);
    });
  });
});
