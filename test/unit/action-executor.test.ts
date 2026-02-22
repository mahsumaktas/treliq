jest.mock('../../src/core/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { ActionExecutor } from '../../src/core/action-executor';
import type { ActionItem } from '../../src/core/actions';

function createMockOctokit() {
  return {
    pulls: {
      get: jest.fn().mockResolvedValue({ data: { state: 'open', merged: false } }),
      update: jest.fn().mockResolvedValue({}),
      merge: jest.fn().mockResolvedValue({}),
    },
    issues: {
      get: jest.fn().mockResolvedValue({ data: { state: 'open' } }),
      update: jest.fn().mockResolvedValue({}),
      createComment: jest.fn().mockResolvedValue({}),
      addLabels: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('ActionExecutor', () => {
  let octokit: ReturnType<typeof createMockOctokit>;
  let executor: ActionExecutor;

  beforeEach(() => {
    octokit = createMockOctokit();
    executor = new ActionExecutor(octokit, 'owner', 'repo');
  });

  describe('close PR', () => {
    it('closes a PR with comment', async () => {
      const actions: ActionItem[] = [{
        action: 'close', target: 1, type: 'pr', reason: 'duplicate', comment: 'Closing as dupe',
      }];
      const result = await executor.execute(actions);
      expect(result.executed).toBe(1);
      expect(octokit.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 1, body: 'Closing as dupe' })
      );
      expect(octokit.pulls.update).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 1, state: 'closed' })
      );
    });

    it('closes a PR without comment', async () => {
      const actions: ActionItem[] = [{
        action: 'close', target: 5, type: 'pr', reason: 'stale',
      }];
      const result = await executor.execute(actions);
      expect(result.executed).toBe(1);
      expect(octokit.issues.createComment).not.toHaveBeenCalled();
      expect(octokit.pulls.update).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 5, state: 'closed' })
      );
    });
  });

  describe('close Issue', () => {
    it('closes an issue with comment', async () => {
      const actions: ActionItem[] = [{
        action: 'close', target: 10, type: 'issue', reason: 'spam', comment: 'Spam detected',
      }];
      const result = await executor.execute(actions);
      expect(result.executed).toBe(1);
      expect(octokit.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 10, body: 'Spam detected' })
      );
      expect(octokit.issues.update).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 10, state: 'closed' })
      );
    });
  });

  describe('merge PR', () => {
    it('merges a PR with squash', async () => {
      const actions: ActionItem[] = [{
        action: 'merge', target: 1, type: 'pr', reason: 'high score', mergeMethod: 'squash',
      }];
      const result = await executor.execute(actions);
      expect(result.executed).toBe(1);
      expect(octokit.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 1, merge_method: 'squash' })
      );
    });

    it('defaults to squash when mergeMethod not specified', async () => {
      const actions: ActionItem[] = [{
        action: 'merge', target: 3, type: 'pr', reason: 'approved',
      }];
      const result = await executor.execute(actions);
      expect(result.executed).toBe(1);
      expect(octokit.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({ pull_number: 3, merge_method: 'squash' })
      );
    });

    it('respects rebase merge method', async () => {
      const actions: ActionItem[] = [{
        action: 'merge', target: 7, type: 'pr', reason: 'test', mergeMethod: 'rebase',
      }];
      await executor.execute(actions);
      expect(octokit.pulls.merge).toHaveBeenCalledWith(
        expect.objectContaining({ merge_method: 'rebase' })
      );
    });
  });

  describe('label', () => {
    it('adds a label to an issue', async () => {
      const actions: ActionItem[] = [{
        action: 'label', target: 10, type: 'issue', reason: 'intent:bugfix', label: 'intent:bugfix',
      }];
      const result = await executor.execute(actions);
      expect(result.executed).toBe(1);
      expect(octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 10, labels: ['intent:bugfix'] })
      );
    });

    it('adds a label to a PR (via issues API)', async () => {
      const actions: ActionItem[] = [{
        action: 'label', target: 3, type: 'pr', reason: 'intent:feature', label: 'intent:feature',
      }];
      const result = await executor.execute(actions);
      expect(result.executed).toBe(1);
      expect(octokit.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ issue_number: 3, labels: ['intent:feature'] })
      );
    });

    it('skips label action when label field is missing', async () => {
      const actions: ActionItem[] = [{
        action: 'label', target: 10, type: 'issue', reason: 'no label',
      }];
      const result = await executor.execute(actions);
      expect(result.executed).toBe(1);
      expect(octokit.issues.addLabels).not.toHaveBeenCalled();
    });
  });

  describe('stale check', () => {
    it('skips already-closed PR', async () => {
      octokit.pulls.get.mockResolvedValue({ data: { state: 'closed', merged: false } });
      const actions: ActionItem[] = [{
        action: 'close', target: 1, type: 'pr', reason: 'duplicate',
      }];
      const result = await executor.execute(actions);
      expect(result.skipped).toBe(1);
      expect(result.executed).toBe(0);
      expect(octokit.pulls.update).not.toHaveBeenCalled();
    });

    it('skips already-merged PR', async () => {
      octokit.pulls.get.mockResolvedValue({ data: { state: 'closed', merged: true } });
      const actions: ActionItem[] = [{
        action: 'merge', target: 1, type: 'pr', reason: 'high score',
      }];
      const result = await executor.execute(actions);
      expect(result.skipped).toBe(1);
    });

    it('skips already-closed issue', async () => {
      octokit.issues.get.mockResolvedValue({ data: { state: 'closed' } });
      const actions: ActionItem[] = [{
        action: 'close', target: 10, type: 'issue', reason: 'spam',
      }];
      const result = await executor.execute(actions);
      expect(result.skipped).toBe(1);
    });

    it('proceeds when stale check fetch fails', async () => {
      octokit.pulls.get.mockRejectedValue(new Error('Network error'));
      const actions: ActionItem[] = [{
        action: 'close', target: 1, type: 'pr', reason: 'stale', comment: 'Closing',
      }];
      const result = await executor.execute(actions);
      // Should NOT be skipped — isStale returns false on fetch error
      expect(result.executed).toBe(1);
    });
  });

  describe('error handling', () => {
    it('counts failed actions', async () => {
      octokit.pulls.merge.mockRejectedValue(new Error('Merge conflict'));
      const actions: ActionItem[] = [{
        action: 'merge', target: 1, type: 'pr', reason: 'test',
      }];
      const result = await executor.execute(actions);
      expect(result.failed).toBe(1);
      expect(result.details[0].status).toBe('failed');
      expect(result.details[0].reason).toContain('Merge conflict');
    });

    it('continues after failure', async () => {
      octokit.pulls.merge.mockRejectedValue(new Error('fail'));
      const actions: ActionItem[] = [
        { action: 'merge', target: 1, type: 'pr', reason: 'test' },
        { action: 'label', target: 2, type: 'pr', reason: 'test', label: 'intent:bugfix' },
      ];
      const result = await executor.execute(actions);
      expect(result.failed).toBe(1);
      expect(result.executed).toBe(1);
    });
  });

  describe('execution result', () => {
    it('returns detailed results for each action', async () => {
      const actions: ActionItem[] = [
        { action: 'label', target: 1, type: 'pr', reason: 'test', label: 'intent:bugfix' },
        { action: 'label', target: 2, type: 'pr', reason: 'test', label: 'intent:feature' },
      ];
      const result = await executor.execute(actions);
      expect(result.details).toHaveLength(2);
      expect(result.details[0]).toEqual({
        target: 1, action: 'label', status: 'executed',
      });
      expect(result.details[1]).toEqual({
        target: 2, action: 'label', status: 'executed',
      });
    });

    it('returns empty result for empty actions', async () => {
      const result = await executor.execute([]);
      expect(result.executed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.details).toHaveLength(0);
    });

    it('tracks mixed results correctly', async () => {
      octokit.pulls.get
        .mockResolvedValueOnce({ data: { state: 'closed', merged: false } }) // stale
        .mockResolvedValueOnce({ data: { state: 'open', merged: false } }); // fresh
      octokit.pulls.merge.mockRejectedValue(new Error('conflict'));

      const actions: ActionItem[] = [
        { action: 'close', target: 1, type: 'pr', reason: 'dup' },   // skipped (stale)
        { action: 'merge', target: 2, type: 'pr', reason: 'score' }, // failed
        { action: 'label', target: 3, type: 'issue', reason: 'x', label: 'bug' }, // executed
      ];
      const result = await executor.execute(actions);
      expect(result.skipped).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.executed).toBe(1);
    });
  });
});
