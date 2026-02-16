/**
 * GitHub Webhook Handler for Treliq
 *
 * Handles incoming webhook events from GitHub:
 * - pull_request.opened: Score new PRs
 * - pull_request.synchronize: Re-score updated PRs
 * - pull_request.closed: Update PR state in DB
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac } from 'crypto';
import { TreliqScanner } from '../core/scanner';
import { TreliqDB } from '../core/db';
import type { TreliqConfig } from '../core/types';
import type { SSEBroadcaster } from './sse';

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
}

/**
 * Verify GitHub webhook signature using HMAC-SHA256
 */
function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (!signature) return false;

  const hmac = createHmac('sha256', secret);
  hmac.update(payload, 'utf8');
  const digest = `sha256=${hmac.digest('hex')}`;

  // Constant-time comparison to prevent timing attacks
  if (signature.length !== digest.length) return false;

  return signature === digest;
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
    {
      config: {
        // Raw body needed for signature verification
        rawBody: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      const event = request.headers['x-github-event'] as string | undefined;
      const deliveryId = request.headers['x-github-delivery'] as string | undefined;

      console.error(`📨 Webhook received: ${event} (delivery: ${deliveryId})`);

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
        console.error('⚠️  Invalid webhook signature');
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
        } else if (event === 'ping') {
          console.error('🏓 Webhook ping received');
          return reply.code(200).send({ status: 'pong' });
        } else {
          console.error(`⏭️  Ignoring event: ${event}`);
          return reply.code(200).send({ status: 'ignored' });
        }
      } catch (error: any) {
        console.error(`❌ Webhook processing error:`, error);
        return reply.code(500).send({
          error: 'Webhook processing failed',
          message: error.message,
        });
      }
    }
  );

  console.error('✅ Webhook endpoint registered at POST /webhooks');
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
    console.error('⚠️  Missing pull_request or repository in payload');
    return;
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const prNumber = pull_request.number;
  const repoFullName = `${owner}/${repo}`;

  console.error(`📋 Processing ${action} for ${repoFullName}#${prNumber}`);

  const repoId = config.db.upsertRepository(owner, repo);

  try {
    switch (action) {
      case 'opened':
        // New PR opened - score it
        await scorePR(repoFullName, prNumber, config);
        console.error(`✅ Scored new PR ${repoFullName}#${prNumber}`);
        break;

      case 'synchronize':
        // PR updated (new commits) - re-score
        await scorePR(repoFullName, prNumber, config);
        console.error(`✅ Re-scored updated PR ${repoFullName}#${prNumber}`);
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
        console.error(`✅ Updated PR ${repoFullName}#${prNumber} state to ${newState}`);
        break;

      case 'reopened':
        // PR reopened - update state and re-score
        config.db.updatePRState(repoId, prNumber, 'open');
        await scorePR(repoFullName, prNumber, config);
        console.error(`✅ Re-opened and re-scored PR ${repoFullName}#${prNumber}`);
        break;

      default:
        console.error(`⏭️  Ignoring action: ${action}`);
    }
  } catch (error: any) {
    console.error(`❌ Failed to process PR ${repoFullName}#${prNumber}:`, error.message);
    throw error;
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

  console.error(`   Score: ${scoredPR.totalScore}/100 ${scoredPR.isSpam ? '(SPAM)' : ''}`);

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
