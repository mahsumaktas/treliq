/**
 * Treliq Server Module
 *
 * Provides REST API, webhook handling, and scheduled scanning
 * for continuous PR monitoring and triage.
 *
 * Usage:
 *   import { startServer } from './server';
 *   await startServer({ port: 8000, ... });
 */

export { createServer, type ServerConfig } from './app';
export { registerWebhooks } from './webhooks';
export { startScheduler, type SchedulerConfig, type SchedulerHandle } from './scheduler';

import type { ServerConfig } from './app';
import type { SchedulerConfig, SchedulerHandle } from './scheduler';
import { createServer } from './app';
import { startScheduler } from './scheduler';
import { NotificationDispatcher } from '../core/notifications';
import { TreliqDB } from '../core/db';
import { createLogger } from '../core/logger';

const log = createLogger('server');

export interface StartServerConfig extends ServerConfig {
  scheduledRepos?: string[];
  cronExpression?: string;
  slackWebhook?: string;
  discordWebhook?: string;
}

/**
 * Start Treliq server with all components:
 * - REST API
 * - Webhook handler (if webhookSecret provided)
 * - Scheduler (if scheduledRepos provided)
 * - Notifications (if webhook URLs provided)
 */
export async function startServer(config: StartServerConfig): Promise<void> {
  log.info('Starting Treliq Server');

  // Initialize notifications if configured
  let notifications: NotificationDispatcher | undefined;
  if (config.slackWebhook || config.discordWebhook) {
    notifications = new NotificationDispatcher({
      slackWebhook: config.slackWebhook,
      discordWebhook: config.discordWebhook,
    });
    log.info('Notifications enabled');
    if (config.slackWebhook) log.info('Slack webhook configured');
    if (config.discordWebhook) log.info('Discord webhook configured');
  }

  // Create and start Fastify server
  const fastify = await createServer(config);

  try {
    await fastify.listen({
      port: config.port,
      host: config.host,
    });

    log.info({ host: config.host, port: config.port }, 'Server listening');
    log.info({ url: `http://${config.host}:${config.port}/health` }, 'Health check available');

    if (config.webhookSecret) {
      log.info({ url: `http://${config.host}:${config.port}/webhooks` }, 'Webhook endpoint registered');
    }
  } catch (error: any) {
    log.error({ err: error }, 'Failed to start server');
    throw error;
  }

  // Start scheduler if configured
  let schedulerHandle: SchedulerHandle | undefined;
  if (config.scheduledRepos && config.scheduledRepos.length > 0) {
    if (!config.cronExpression) {
      log.warn('scheduledRepos provided but no cronExpression');
    } else {
      try {
        const db = new TreliqDB(config.dbPath);

        const schedulerConfig: SchedulerConfig = {
          cronExpression: config.cronExpression,
          repos: config.scheduledRepos,
          treliqConfig: config.treliqConfig,
          db,
          notifications,
        };

        schedulerHandle = startScheduler(schedulerConfig);
      } catch (error: any) {
        log.error({ err: error }, 'Failed to start scheduler');
        // Continue without scheduler
      }
    }
  }

  // Log startup summary
  log.info({
    port: config.port,
    host: config.host,
    dbPath: config.dbPath,
    repo: config.treliqConfig.repo,
    webhooks: !!config.webhookSecret,
    scheduler: !!schedulerHandle,
    notifications: !!notifications?.hasChannels,
  }, 'Server configuration');

  log.info('Server ready to accept requests');

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down');

    if (schedulerHandle) {
      schedulerHandle.stop();
    }

    try {
      await fastify.close();
      log.info('Server shutdown complete');
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
