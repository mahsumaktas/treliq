import { ActionEngine, type ActionItem } from '../../src/core/actions';
import { createScoredPR, createScoredIssue } from '../fixtures/pr-factory';
import type { DedupCluster, TriageItem } from '../../src/core/types';

describe('ActionEngine', () => {
  describe('planCloseDuplicates', () => {
    it('closes lower-scored items in duplicate cluster', () => {
      const items: TriageItem[] = [
        createScoredPR({ number: 1, totalScore: 90, duplicateGroup: 0 }),
        createScoredPR({ number: 2, totalScore: 70, duplicateGroup: 0 }),
        createScoredPR({ number: 3, totalScore: 50, duplicateGroup: 0 }),
      ];
      const clusters: DedupCluster[] = [{
        id: 0, prs: items, bestPR: 1, similarity: 0.94, reason: 'test',
      }];
      const engine = new ActionEngine();
      const plan = engine.planCloseDuplicates(items, clusters);
      expect(plan).toHaveLength(2);
      expect(plan[0].target).toBe(2);
      expect(plan[1].target).toBe(3);
      expect(plan[0].action).toBe('close');
      expect(plan[0].reason).toContain('duplicate of #1');
    });

    it('respects exclude list', () => {
      const items: TriageItem[] = [
        createScoredPR({ number: 1, totalScore: 90 }),
        createScoredPR({ number: 2, totalScore: 70 }),
      ];
      const clusters: DedupCluster[] = [{
        id: 0, prs: items, bestPR: 1, similarity: 0.94, reason: 'test',
      }];
      const engine = new ActionEngine({ exclude: [2] });
      const plan = engine.planCloseDuplicates(items, clusters);
      expect(plan).toHaveLength(0);
    });

    it('handles mixed PR + Issue clusters', () => {
      const items: TriageItem[] = [
        createScoredPR({ number: 1, totalScore: 90 }),
        createScoredIssue({ number: 10, totalScore: 70 }),
      ];
      const clusters: DedupCluster[] = [{
        id: 0, prs: items, bestPR: 1, similarity: 0.92, reason: 'test', type: 'mixed',
      }];
      const engine = new ActionEngine();
      const plan = engine.planCloseDuplicates(items, clusters);
      expect(plan).toHaveLength(1);
      expect(plan[0].target).toBe(10);
      expect(plan[0].type).toBe('issue');
    });

    it('respects batch limit', () => {
      const items: TriageItem[] = Array.from({ length: 5 }, (_, i) =>
        createScoredPR({ number: i + 1, totalScore: 90 - i * 10 })
      );
      const clusters: DedupCluster[] = [{
        id: 0, prs: items, bestPR: 1, similarity: 0.9, reason: 'test',
      }];
      const engine = new ActionEngine({ batchLimit: 2 });
      const plan = engine.planCloseDuplicates(items, clusters);
      expect(plan).toHaveLength(2);
    });
  });

  describe('planCloseSpam', () => {
    it('plans close for spam items', () => {
      const items: TriageItem[] = [
        createScoredPR({ number: 1, isSpam: true, spamReasons: ['Empty body'] }),
        createScoredPR({ number: 2, isSpam: false }),
      ];
      const engine = new ActionEngine();
      const plan = engine.planCloseSpam(items);
      expect(plan).toHaveLength(1);
      expect(plan[0].target).toBe(1);
      expect(plan[0].action).toBe('close');
      expect(plan[0].reason).toContain('spam');
    });

    it('closes spam issues too', () => {
      const items: TriageItem[] = [
        createScoredIssue({ number: 10, isSpam: true, spamReasons: ['Short title'] }),
      ];
      const engine = new ActionEngine();
      const plan = engine.planCloseSpam(items);
      expect(plan).toHaveLength(1);
      expect(plan[0].type).toBe('issue');
    });

    it('respects exclude list', () => {
      const items: TriageItem[] = [
        createScoredPR({ number: 1, isSpam: true, spamReasons: ['Test'] }),
      ];
      const engine = new ActionEngine({ exclude: [1] });
      expect(engine.planCloseSpam(items)).toHaveLength(0);
    });
  });

  describe('planAutoMerge', () => {
    it('plans merge for high-score approved PRs', () => {
      const prs = [
        createScoredPR({ number: 1, totalScore: 92, reviewState: 'approved', ciStatus: 'success', mergeable: 'mergeable', isDraft: false }),
      ];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      const plan = engine.planAutoMerge(prs);
      expect(plan).toHaveLength(1);
      expect(plan[0].action).toBe('merge');
      expect(plan[0].mergeMethod).toBe('squash');
    });

    it('skips PRs below threshold', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 70, reviewState: 'approved', ciStatus: 'success', mergeable: 'mergeable' })];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      expect(engine.planAutoMerge(prs)).toHaveLength(0);
    });

    it('skips PRs not approved', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 95, reviewState: 'none', ciStatus: 'success', mergeable: 'mergeable' })];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      expect(engine.planAutoMerge(prs)).toHaveLength(0);
    });

    it('skips PRs with failing CI', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 95, reviewState: 'approved', ciStatus: 'failure', mergeable: 'mergeable' })];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      expect(engine.planAutoMerge(prs)).toHaveLength(0);
    });

    it('skips draft PRs', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 95, reviewState: 'approved', ciStatus: 'success', mergeable: 'mergeable', isDraft: true })];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      expect(engine.planAutoMerge(prs)).toHaveLength(0);
    });

    it('skips high-risk PRs', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 95, reviewState: 'approved', ciStatus: 'success', mergeable: 'mergeable', isDraft: false, llmRisk: 'high' })];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      expect(engine.planAutoMerge(prs)).toHaveLength(0);
    });

    it('uses configured merge method', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 95, reviewState: 'approved', ciStatus: 'success', mergeable: 'mergeable', isDraft: false })];
      const engine = new ActionEngine({ mergeThreshold: 85, mergeMethod: 'rebase' });
      const plan = engine.planAutoMerge(prs);
      expect(plan[0].mergeMethod).toBe('rebase');
    });
  });

  describe('planLabelIntent', () => {
    it('plans intent labels for items with intent', () => {
      const items: TriageItem[] = [
        createScoredPR({ number: 1, intent: 'bugfix' }),
        createScoredPR({ number: 2, intent: 'feature' }),
        createScoredPR({ number: 3 }), // no intent
      ];
      const engine = new ActionEngine();
      const plan = engine.planLabelIntent(items);
      expect(plan).toHaveLength(2);
      expect(plan[0].label).toBe('intent:bugfix');
      expect(plan[1].label).toBe('intent:feature');
    });

    it('labels issues too', () => {
      const items: TriageItem[] = [
        createScoredIssue({ number: 10, intent: 'bugfix' }),
      ];
      const engine = new ActionEngine();
      const plan = engine.planLabelIntent(items);
      expect(plan).toHaveLength(1);
      expect(plan[0].type).toBe('issue');
      expect(plan[0].label).toBe('intent:bugfix');
    });
  });

  describe('formatDryRun', () => {
    it('formats action plan as readable text', () => {
      const engine = new ActionEngine();
      const actions: ActionItem[] = [
        { action: 'close', target: 2, type: 'pr', reason: 'duplicate of #1' },
        { action: 'merge', target: 1, type: 'pr', reason: 'score: 92, approved, CI pass' },
        { action: 'label', target: 3, type: 'pr', reason: 'intent: bugfix', label: 'intent:bugfix' },
      ];
      const output = engine.formatDryRun(actions);
      expect(output).toContain('CLOSE');
      expect(output).toContain('MERGE');
      expect(output).toContain('LABEL');
      expect(output).toContain('--confirm');
      expect(output).toContain('3 actions pending');
    });

    it('returns no-action message for empty list', () => {
      const engine = new ActionEngine();
      expect(engine.formatDryRun([])).toBe('No actions to perform.');
    });
  });
});
