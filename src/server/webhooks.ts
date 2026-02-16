/**
 * GitHub Webhook Handler for Treliq
 *
 * Handles incoming webhook events from GitHub:
 * - pull_request.opened: Score new PRs
 * - pull_request.synchronize: Re-score updated PRs
 * - pull_request.closed: Update PR state in DB
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { TreliqScanner } from '../core/scanner';
import { TreliqDB } from '../core/db';
import type { TreliqConfig } from '../core/types';
import type { SSEBroadcaster } from './sse';
import { getAuthMode, getAppConfig } from '../core/app-config';
import { createAppOctokit, clearTokenCache } from '../core/auth';
import { createLogger } from '../core/logger';

const log = createLogger('webhooks');

export interface WebhookConfig {
  secret: string;
  treliqConfig: TreliqConfig;
  db: TreliqDB;
  broadcaster?: SSEBroadcaster;
}

interface WebhookPayload {
  action?: string;
  pull_request?: {
    number: number;
    title: string;
    state: string;
    merged: boolean;
    html_url: string;
    base: {
      repo: {
        owner: { login: string };
        name: string;
      };
    };
  };
  repository?: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
  installation?: {
    id: number;
    account: {
      login: string;
      type: string;
    };
  };
  repositories?: Array<{
    id: number;
    full_name: string;
  }>;
  repositories_added?: Array<{
    id: number;
    full_name: string;
  }>;
  repositories_removed?: Array<{
    id: number;
    full_name: string;
  }>;
}

/**
 * Verify GitHub webhook signature using HMAC-SHA256
 */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (!signature) return false;

  const hmac = createHmac('sha256', secret);
  hmac.update(payload, 'utf8');
  const expected = `sha256=${hmac.digest('hex')}`;

  if (signature.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Register webhook endpoint with GitHub signature verification
 */
export function registerWebhooks(
  fastify: FastifyInstance,
  config: WebhookConfig
): void {
  fastify.post(
    '/webhooks',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      const event = request.headers['x-github-event'] as string | undefined;
      const deliveryId = request.headers['x-github-delivery'] as string | undefined;

      log.info({ event, deliveryId }, 'Webhook received');

      // Get raw body for signature verification
      let rawBody: string;
      try {
        rawBody = JSON.stringify(request.body);
      } catch {
        return reply.code(400).send({
          error: 'Invalid JSON payload',
        });
      }

      // Verify signature
      if (!signature || !verifySignature(rawBody, signature, config.secret)) {
        log.warn('Invalid webhook signature');
        return reply.code(401).send({
          error: 'Invalid signature',
        });
      }

      const payload = request.body as WebhookPayload;

      // Handle different webhook events
      try {
        if (event === 'pull_request') {
          await handlePullRequestEvent(payload, config);
          return reply.code(200).send({ status: 'processed' });
        } else if (event === 'installation') {
          await handleInstallationEvent(payload, config);
          return reply.code(200).send({ status: 'processed' });
        } else if (event === 'installation_repositories') {
          await handleInstallationReposEvent(payload, config);
          return reply.code(200).send({ status: 'processed' });
        } else if (event === 'ping') {
          log.info('Webhook ping received');
          return reply.code(200).send({ status: 'pong' });
        } else {
          log.debug({ event }, 'Ignoring event');
          return reply.code(200).send({ status: 'ignored' });
        }
      } catch (error: any) {
        log.error({ err: error }, 'Webhook processing error');
        return reply.code(500).send({
          error: 'Webhook processing failed',
          message: error.message,
        });
      }
    }
  );

  log.info('Webhook endpoint registered at POST /webhooks');
  log.info('Listening for: pull_request, installation, installation_repositories, ping');
}

/**
 * Handle pull_request webhook events
 */
async function handlePullRequestEvent(
  payload: WebhookPayload,
  config: WebhookConfig
): Promise<void> {
  const { action, pull_request, repository } = payload;

  if (!pull_request || !repository) {
    log.warn('Missing pull_request or repository in payload');
    return;
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pull_request.number;
  const repoFullName = `${owner}/${repo}`;

  log.info({ action, repo: repoFullName, pr: prNumber }, 'Processing PR event');

  const repoId = config.db.upsertRepository(owner, repo);

  try {
    switch (action) {
      case 'opened':
        // New PR opened - score it
        await scorePR(repoFullName, prNumber, config);
        log.info({ repo: repoFullName, pr: prNumber }, 'Scored new PR');
        break;

      case 'synchronize':
        // PR updated (new commits) - re-score
        await scorePR(repoFullName, prNumber, config);
        log.info({ repo: repoFullName, pr: prNumber }, 'Re-scored updated PR');
        break;

      case 'closed':
        // PR closed - update state
        const newState = pull_request.merged ? 'merged' : 'closed';
        config.db.updatePRState(repoId, prNumber, newState);
        config.broadcaster?.broadcast('pr_closed', {
          repo: repoFullName,
          prNumber,
          state: newState,
          timestamp: new Date().toISOString(),
        });
        log.info({ repo: repoFullName, pr: prNumber, state: newState }, 'Updated PR state');
        break;

      case 'reopened':
        // PR reopened - update state and re-score
        config.db.updatePRState(repoId, prNumber, 'open');
        await scorePR(repoFullName, prNumber, config);
        log.info({ repo: repoFullName, pr: prNumber }, 'Re-opened and re-scored PR');
        break;

      default:
        log.debug({ action }, 'Ignoring PR action');
    }
  } catch (error: any) {
    log.error({ repo: repoFullName, pr: prNumber, err: error }, 'Failed to process PR');
    throw error;
  }
}

/**
 * Handle installation lifecycle events (created, deleted, suspend, unsuspend)
 */
async function handleInstallationEvent(
  payload: WebhookPayload,
  config: WebhookConfig
): Promise<void> {
  const { action, installation, repositories } = payload;

  if (!installation) {
    log.warn('Missing installation in payload');
    return;
  }

  const { id, account } = installation;

  switch (action) {
    case 'created':
      log.info({ installationId: id, account: account.login, accountType: account.type }, 'New installation');
      config.db.upsertInstallation(id, account.type, account.login);

      // Link accessible repositories
      if (repositories) {
        for (const repo of repositories) {
          const [owner, name] = repo.full_name.split('/');
          const repoId = config.db.upsertRepository(owner, name);
          config.db.linkInstallationRepo(id, repoId);
        }
        log.info({ installationId: id, repoCount: repositories.length }, 'Linked repositories');
      }

      config.broadcaster?.broadcast('installation_created', {
        installationId: id,
        account: account.login,
        accountType: account.type,
        repoCount: repositories?.length ?? 0,
        timestamp: new Date().toISOString(),
      });
      break;

    case 'deleted':
      log.info({ installationId: id, account: account.login }, 'Installation removed');
      clearTokenCache(id);
      config.db.deleteInstallation(id);

      config.broadcaster?.broadcast('installation_deleted', {
        installationId: id,
        account: account.login,
        timestamp: new Date().toISOString(),
      });
      break;

    case 'suspend':
      log.info({ installationId: id, account: account.login }, 'Installation suspended');
      config.db.suspendInstallation(id, true);
      clearTokenCache(id);
      break;

    case 'unsuspend':
      log.info({ installationId: id, account: account.login }, 'Installation unsuspended');
      config.db.suspendInstallation(id, false);
      break;

    default:
      log.debug({ action }, 'Ignoring installation action');
  }
}

/**
 * Handle installation_repositories events (repos added/removed from installation)
 */
async function handleInstallationReposEvent(
  payload: WebhookPayload,
  config: WebhookConfig
): Promise<void> {
  const { action, installation, repositories_added, repositories_removed } = payload;

  if (!installation) {
    log.warn('Missing installation in payload');
    return;
  }

  const installationId = installation.id;

  if (action === 'added' && repositories_added) {
    for (const repo of repositories_added) {
      const [owner, name] = repo.full_name.split('/');
      const repoId = config.db.upsertRepository(owner, name);
      config.db.linkInstallationRepo(installationId, repoId);
    }
    log.info({ installationId, repoCount: repositories_added.length }, 'Added repos to installation');
  }

  if (action === 'removed' && repositories_removed) {
    for (const repo of repositories_removed) {
      const [owner, name] = repo.full_name.split('/');
      // Find repo ID and unlink
      const repos = config.db.getRepositories();
      const found = repos.find(r => r.owner === owner && r.repo === name);
      if (found) {
        config.db.unlinkInstallationRepo(installationId, found.id);
      }
    }
    log.info({ installationId, repoCount: repositories_removed.length }, 'Removed repos from installation');
  }
}

/**
 * Score a specific PR and save to database
 */
async function scorePR(
  repoFullName: string,
  prNumber: number,
  config: WebhookConfig
): Promise<void> {
  const [owner, repo] = repoFullName.split('/');

  // Create scanner with repository-specific config
  const scanConfig: TreliqConfig = {
    ...config.treliqConfig,
    repo: repoFullName,
    dbPath: config.db instanceof TreliqDB ? (config.db as any).db.name : undefined,
  };

  const scanner = new TreliqScanner(scanConfig);

  // Fetch and score the specific PR
  const prs = await scanner.fetchPRDetails([prNumber]);

  if (prs.length === 0) {
    throw new Error(`PR #${prNumber} not found`);
  }

  const pr = prs[0];

  // Score the PR
  const scoredPR = await scanner.scoring.score(pr);

  // Save to database
  const repoId = config.db.upsertRepository(owner, repo);
  const configHash = 'webhook'; // Use a special hash for webhook-triggered scores
  config.db.upsertPR(repoId, scoredPR, configHash);

  log.info({ score: scoredPR.totalScore, isSpam: scoredPR.isSpam }, 'PR scored');

  // Broadcast to connected dashboard clients
  config.broadcaster?.broadcast('pr_scored', {
    repo: repoFullName,
    prNumber,
    title: pr.title,
    totalScore: scoredPR.totalScore,
    isSpam: scoredPR.isSpam,
    timestamp: new Date().toISOString(),
  });
}
