/**
 * ActionEngine — Plans auto-actions for scored PRs and Issues
 * Pure planning module: generates action lists without executing them.
 */

import type { ScoredPR, ScoredIssue, DedupCluster, TriageItem } from './types';
import { createLogger } from './logger';

const log = createLogger('actions');

export interface ActionItem {
  action: 'close' | 'merge' | 'label';
  target: number;
  type: 'pr' | 'issue';
  reason: string;
  label?: string;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  comment?: string;
}

export interface ActionOptions {
  mergeThreshold?: number;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  batchLimit?: number;
  exclude?: number[];
}

function isIssue(item: TriageItem): item is ScoredIssue {
  return !('changedFiles' in item);
}

export class ActionEngine {
  private opts: Required<ActionOptions>;

  constructor(opts: ActionOptions = {}) {
    this.opts = {
      mergeThreshold: opts.mergeThreshold ?? 85,
      mergeMethod: opts.mergeMethod ?? 'squash',
      batchLimit: opts.batchLimit ?? 50,
      exclude: opts.exclude ?? [],
    };
  }

  planCloseDuplicates(items: TriageItem[], clusters: DedupCluster[]): ActionItem[] {
    const actions: ActionItem[] = [];
    for (const cluster of clusters) {
      const sorted = [...cluster.prs].sort((a, b) => b.totalScore - a.totalScore);
      const best = sorted[0];
      for (const item of sorted.slice(1)) {
        if (this.opts.exclude.includes(item.number)) continue;
        actions.push({
          action: 'close',
          target: item.number,
          type: isIssue(item) ? 'issue' : 'pr',
          reason: `duplicate of #${best.number} (sim: ${(cluster.similarity * 100).toFixed(0)}%)`,
          comment: `Closed as duplicate of #${best.number} (similarity: ${(cluster.similarity * 100).toFixed(1)}%). Treliq auto-triage.`,
        });
      }
    }
    return actions.slice(0, this.opts.batchLimit);
  }

  planCloseSpam(items: TriageItem[]): ActionItem[] {
    return items
      .filter(item => item.isSpam && !this.opts.exclude.includes(item.number))
      .map(item => ({
        action: 'close' as const,
        target: item.number,
        type: (isIssue(item) ? 'issue' : 'pr') as 'pr' | 'issue',
        reason: `spam (${item.spamReasons.join(', ')})`,
        comment: `Closed by Treliq: detected as spam (${item.spamReasons.join(', ')}).`,
      }))
      .slice(0, this.opts.batchLimit);
  }

  planAutoMerge(prs: ScoredPR[]): ActionItem[] {
    return prs
      .filter(pr =>
        pr.totalScore >= this.opts.mergeThreshold &&
        pr.mergeable === 'mergeable' &&
        pr.reviewState === 'approved' &&
        pr.ciStatus === 'success' &&
        pr.llmRisk !== 'high' &&
        !pr.isDraft &&
        !this.opts.exclude.includes(pr.number)
      )
      .map(pr => ({
        action: 'merge' as const,
        target: pr.number,
        type: 'pr' as const,
        reason: `score: ${pr.totalScore}, approved, CI pass`,
        mergeMethod: this.opts.mergeMethod,
      }))
      .slice(0, this.opts.batchLimit);
  }

  planLabelIntent(items: TriageItem[]): ActionItem[] {
    return items
      .filter(item => item.intent && !this.opts.exclude.includes(item.number))
      .map(item => ({
        action: 'label' as const,
        target: item.number,
        type: (isIssue(item) ? 'issue' : 'pr') as 'pr' | 'issue',
        reason: `intent: ${item.intent}`,
        label: `intent:${item.intent}`,
      }))
      .slice(0, this.opts.batchLimit);
  }

  formatDryRun(actions: ActionItem[]): string {
    if (actions.length === 0) return 'No actions to perform.';

    const groups = {
      close: actions.filter(a => a.action === 'close'),
      merge: actions.filter(a => a.action === 'merge'),
      label: actions.filter(a => a.action === 'label'),
    };

    const lines: string[] = ['=== Auto-Actions (DRY RUN) ===', ''];

    if (groups.close.length > 0) {
      lines.push('CLOSE:');
      for (const a of groups.close) lines.push(`  #${a.target} (${a.type}) -> ${a.reason}`);
      lines.push('');
    }
    if (groups.merge.length > 0) {
      lines.push('MERGE:');
      for (const a of groups.merge) lines.push(`  #${a.target} -> ${a.reason}`);
      lines.push('');
    }
    if (groups.label.length > 0) {
      lines.push('LABEL:');
      for (const a of groups.label) lines.push(`  #${a.target} -> ${a.label}`);
      lines.push('');
    }

    lines.push(`Run with --confirm to execute. (${actions.length} actions pending)`);
    return lines.join('\n');
  }
}
