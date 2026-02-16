/**
 * Scheduled Repository Scanner for Treliq
 *
 * Uses node-cron to periodically scan multiple repositories,
 * save results to database, and optionally send notifications.
 */

import cron from 'node-cron';
import { TreliqScanner } from '../core/scanner';
import { TreliqDB } from '../core/db';
import { NotificationDispatcher } from '../core/notifications';
import type { TreliqConfig } from '../core/types';
import { createLogger } from '../core/logger';

const log = createLogger('scheduler');

export interface SchedulerConfig {
  cronExpression: string;
  repos: string[];
  treliqConfig: TreliqConfig;
  db: TreliqDB;
  notifications?: NotificationDispatcher;
}

export interface SchedulerHandle {
  stop: () => void;
  isRunning: () => boolean;
}

/**
 * Start a cron scheduler that scans repositories on schedule
 * Returns a handle to stop the scheduler
 */
export function startScheduler(config: SchedulerConfig): SchedulerHandle {
  if (config.repos.length === 0) {
    throw new Error('No repositories configured for scheduled scanning');
  }

  // Validate cron expression
  if (!cron.validate(config.cronExpression)) {
    throw new Error(`Invalid cron expression: ${config.cronExpression}`);
  }

  log.info({
    repoCount: config.repos.length,
    cron: config.cronExpression,
    repos: config.repos,
  }, 'Scheduler configured');

  let isRunning = false;

  const task = cron.schedule(
    config.cronExpression,
    async () => {
      if (isRunning) {
        log.warn('Previous scan still running, skipping this cycle');
        return;
      }

      isRunning = true;
      const startTime = Date.now();

      log.info('Starting scheduled scan');

      try {
        await scanAllRepositories(config);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        log.info({ durationSec: parseFloat(duration) }, 'Scheduled scan complete');
      } catch (error: any) {
        log.error({ err: error }, 'Scheduled scan failed');
      } finally {
        isRunning = false;
      }
    },
    {
      timezone: 'UTC',
    }
  );

  task.start();
  log.info('Scheduler started');

  return {
    stop: () => {
      task.stop();
      log.info('Scheduler stopped');
    },
    isRunning: () => isRunning,
  };
}

/**
 * Scan all configured repositories sequentially
 */
async function scanAllRepositories(config: SchedulerConfig): Promise<void> {
  const results = {
    successful: 0,
    failed: 0,
    totalPRs: 0,
    totalSpam: 0,
  };

  for (const repo of config.repos) {
    try {
      log.info({ repo }, 'Scanning repository');

      const scanConfig: TreliqConfig = {
        ...config.treliqConfig,
        repo,
        dbPath: config.db instanceof TreliqDB ? (config.db as any).db.name : undefined,
      };

      const scanner = new TreliqScanner(scanConfig);
      const result = await scanner.scan();

      results.successful++;
      results.totalPRs += result.totalPRs;
      results.totalSpam += result.spamCount;

      // Send scan completion notification
      if (config.notifications?.hasChannels) {
        await config.notifications.send({
          type: 'scan_complete',
          repo,
          message: `Scanned ${result.totalPRs} PRs, found ${result.spamCount} spam, ${result.duplicateClusters.length} duplicate clusters`,
        });
      }

      // Send notifications for high-priority PRs (score >= 90)
      if (config.notifications?.hasChannels) {
        const highPriorityPRs = result.rankedPRs.filter(
          pr => pr.totalScore >= 90 && !pr.isSpam
        );

        for (const pr of highPriorityPRs.slice(0, 3)) {
          // Limit to top 3 to avoid spam
          await config.notifications.send({
            type: 'high_priority_pr',
            repo,
            message: `High priority PR: ${pr.title}`,
            prNumber: pr.number,
            score: Math.round(pr.totalScore),
            url: `https://github.com/${repo}/pull/${pr.number}`,
          });
        }
      }
    } catch (error: any) {
      log.error({ repo, err: error }, 'Failed to scan repository');
      results.failed++;

      // Send error notification
      if (config.notifications?.hasChannels) {
        try {
          await config.notifications.send({
            type: 'spam_detected', // Reuse spam type for errors (red color)
            repo,
            message: `Scan failed: ${error.message}`,
          });
        } catch (notifError: any) {
          log.warn({ err: notifError }, 'Failed to send error notification');
        }
      }
    }
  }

  // Log summary
  log.info({
    successful: results.successful,
    failed: results.failed,
    totalPRs: results.totalPRs,
    totalSpam: results.totalSpam,
  }, 'Scan summary');
}
