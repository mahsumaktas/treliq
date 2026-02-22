/**
 * ActionExecutor — Executes planned actions via GitHub API
 * Re-fetches current state before each action to avoid stale operations.
 * Separated from ActionEngine so planning remains pure/testable.
 */

import type { Octokit } from '@octokit/rest';
import type { ActionItem } from './actions';
import { createLogger } from './logger';

const log = createLogger('action-executor');

export interface ExecutionResult {
  executed: number;
  skipped: number;
  failed: number;
  details: Array<{
    target: number;
    action: string;
    status: 'executed' | 'skipped' | 'failed';
    reason?: string;
  }>;
}

export class ActionExecutor {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(octokit: Octokit, owner: string, repo: string) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
  }

  async execute(actions: ActionItem[]): Promise<ExecutionResult> {
    const result: ExecutionResult = {
      executed: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };

    for (const action of actions) {
      try {
        const stale = await this.isStale(action);
        if (stale) {
          result.skipped++;
          result.details.push({
            target: action.target,
            action: action.action,
            status: 'skipped',
            reason: 'State changed',
          });
          log.info({ target: action.target, action: action.action }, 'Skipped (state changed)');
          continue;
        }

        await this.executeOne(action);
        result.executed++;
        result.details.push({
          target: action.target,
          action: action.action,
          status: 'executed',
        });
        log.info({ target: action.target, action: action.action }, 'Executed');
      } catch (err) {
        result.failed++;
        result.details.push({
          target: action.target,
          action: action.action,
          status: 'failed',
          reason: String(err),
        });
        log.warn({ target: action.target, action: action.action, err }, 'Failed to execute action');
      }
    }

    return result;
  }

  private async isStale(action: ActionItem): Promise<boolean> {
    try {
      if (action.type === 'pr') {
        const { data } = await this.octokit.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: action.target,
        });
        if (data.state === 'closed' || data.merged) return true;
      } else {
        const { data } = await this.octokit.issues.get({
          owner: this.owner,
          repo: this.repo,
          issue_number: action.target,
        });
        if (data.state === 'closed') return true;
      }
    } catch {
      // If we can't fetch, assume not stale — will fail on execute if truly gone
    }
    return false;
  }

  private async executeOne(action: ActionItem): Promise<void> {
    switch (action.action) {
      case 'close':
        await this.executeClose(action);
        break;
      case 'merge':
        await this.executeMerge(action);
        break;
      case 'label':
        await this.executeLabel(action);
        break;
    }
  }

  private async executeClose(action: ActionItem): Promise<void> {
    if (action.comment) {
      await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: action.target,
        body: action.comment,
      });
    }

    if (action.type === 'pr') {
      await this.octokit.pulls.update({
        owner: this.owner,
        repo: this.repo,
        pull_number: action.target,
        state: 'closed',
      });
    } else {
      await this.octokit.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: action.target,
        state: 'closed',
      });
    }
  }

  private async executeMerge(action: ActionItem): Promise<void> {
    await this.octokit.pulls.merge({
      owner: this.owner,
      repo: this.repo,
      pull_number: action.target,
      merge_method: action.mergeMethod ?? 'squash',
    });
  }

  private async executeLabel(action: ActionItem): Promise<void> {
    if (!action.label) return;
    await this.octokit.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: action.target,
      labels: [action.label],
    });
  }
}
