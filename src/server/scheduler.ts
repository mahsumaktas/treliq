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

  console.error(`⏰ Scheduler configured for ${config.repos.length} repositories`);
  console.error(`   Schedule: ${config.cronExpression}`);
  console.error(`   Repositories: ${config.repos.join(', ')}`);

  let isRunning = false;

  const task = cron.schedule(
    config.cronExpression,
    async () => {
      if (isRunning) {
        console.error('⏭️  Previous scan still running, skipping this cycle');
        return;
      }

      isRunning = true;
      const startTime = Date.now();

      console.error(`\n🕐 ${new Date().toISOString()} - Starting scheduled scan...`);

      try {
        await scanAllRepositories(config);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`✅ Scheduled scan complete (${duration}s)\n`);
      } catch (error: any) {
        console.error(`❌ Scheduled scan failed:`, error.message);
      } finally {
        isRunning = false;
      }
    },
    {
      timezone: 'UTC',
    }
  );

  task.start();
  console.error('✅ Scheduler started');

  return {
    stop: () => {
      task.stop();
      console.error('🛑 Scheduler stopped');
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
      console.error(`\n📡 Scanning ${repo}...`);

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
      console.error(`❌ Failed to scan ${repo}:`, error.message);
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
          console.error(`⚠️  Failed to send error notification:`, notifError.message);
        }
      }
    }
  }

  // Log summary
  console.error(`\n📊 Scan Summary:`);
  console.error(`   Successful: ${results.successful}`);
  console.error(`   Failed: ${results.failed}`);
  console.error(`   Total PRs: ${results.totalPRs}`);
  console.error(`   Total Spam: ${results.totalSpam}`);
}
