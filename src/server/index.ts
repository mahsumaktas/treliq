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
  console.error('🚀 Starting Treliq Server...\n');

  // Initialize notifications if configured
  let notifications: NotificationDispatcher | undefined;
  if (config.slackWebhook || config.discordWebhook) {
    notifications = new NotificationDispatcher({
      slackWebhook: config.slackWebhook,
      discordWebhook: config.discordWebhook,
    });
    console.error('📢 Notifications enabled');
    if (config.slackWebhook) console.error('   - Slack webhook configured');
    if (config.discordWebhook) console.error('   - Discord webhook configured');
  }

  // Create and start Fastify server
  const fastify = await createServer(config);

  try {
    await fastify.listen({
      port: config.port,
      host: config.host,
    });

    console.error(`\n✅ Server listening on http://${config.host}:${config.port}`);
    console.error(`   Health check: http://${config.host}:${config.port}/health`);

    if (config.webhookSecret) {
      console.error(`   Webhook endpoint: http://${config.host}:${config.port}/webhooks`);
    }
  } catch (error: any) {
    console.error('❌ Failed to start server:', error);
    throw error;
  }

  // Start scheduler if configured
  let schedulerHandle: SchedulerHandle | undefined;
  if (config.scheduledRepos && config.scheduledRepos.length > 0) {
    if (!config.cronExpression) {
      console.error('⚠️  scheduledRepos provided but no cronExpression - scheduler not started');
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
        console.error('❌ Failed to start scheduler:', error.message);
        // Continue without scheduler
      }
    }
  }

  // Log startup summary
  console.error('\n📋 Server Configuration:');
  console.error(`   Port: ${config.port}`);
  console.error(`   Host: ${config.host}`);
  console.error(`   Database: ${config.dbPath}`);
  console.error(`   Repository: ${config.treliqConfig.repo}`);
  console.error(`   Webhooks: ${config.webhookSecret ? 'Enabled' : 'Disabled'}`);
  console.error(`   Scheduler: ${schedulerHandle ? 'Enabled' : 'Disabled'}`);
  console.error(`   Notifications: ${notifications?.hasChannels ? 'Enabled' : 'Disabled'}`);

  console.error('\n🎯 Server ready to accept requests\n');

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.error(`\n🛑 Received ${signal}, shutting down...`);

    if (schedulerHandle) {
      schedulerHandle.stop();
    }

    try {
      await fastify.close();
      console.error('✅ Server shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
