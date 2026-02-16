/**
 * Treliq Server - REST API using Fastify
 *
 * Provides HTTP endpoints for scanning repositories, querying PRs,
 * accessing scan history, and serving the dashboard with real-time SSE updates.
 */

import path from 'path';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { TreliqDB } from '../core/db';
import { TreliqScanner } from '../core/scanner';
import type { TreliqConfig } from '../core/types';
import { registerWebhooks } from './webhooks';
import { SSEBroadcaster } from './sse';

export interface ServerConfig {
  port: number;
  host: string;
  dbPath: string;
  treliqConfig: TreliqConfig;
  webhookSecret?: string;
}

interface RepoParams {
  owner: string;
  repo: string;
}

interface RepoPRParams extends RepoParams {
  number: string;
}

interface QueryParams {
  limit?: string;
  offset?: string;
  sortBy?: string;
  state?: string;
}

/**
 * Create and configure Fastify server instance
 * Returns the instance without calling listen() - caller handles startup
 */
export async function createServer(config: ServerConfig): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false, // We use console.error for consistency with CLI
    requestTimeout: 120000, // 2 minutes for scan operations
  });

  // Enable CORS
  await fastify.register(cors, {
    origin: true, // Allow all origins (adjust for production)
  });

  // Serve dashboard static files at root
  const dashboardDir = path.resolve(__dirname, '../../dashboard');
  await fastify.register(fastifyStatic, {
    root: dashboardDir,
    prefix: '/',
    decorateReply: false,
  });

  // Initialize database
  const db = new TreliqDB(config.dbPath);
  console.error(`📂 Database opened: ${config.dbPath}`);

  // SSE broadcaster for real-time dashboard updates
  const broadcaster = new SSEBroadcaster();
  // Keepalive ping every 30 seconds
  const keepaliveInterval = setInterval(() => broadcaster.ping(), 30_000);

  // Graceful shutdown
  const closeGracefully = async (signal: string) => {
    console.error(`\n🛑 Received ${signal}, closing server gracefully...`);
    try {
      clearInterval(keepaliveInterval);
      broadcaster.closeAll();
      db.close();
      await fastify.close();
      console.error('✅ Server closed');
      process.exit(0);
    } catch (err) {
      console.error('❌ Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => closeGracefully('SIGTERM'));
  process.on('SIGINT', () => closeGracefully('SIGINT'));

  // ========== Health Check ==========

  fastify.get('/health', async (request: FastifyRequest, reply: FastifyReply) => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  // ========== Repository Endpoints ==========

  /**
   * GET /api/repos - List all repositories
   */
  fastify.get('/api/repos', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const repos = db.getRepositories();
      return { repos };
    } catch (error: any) {
      console.error('❌ Failed to list repositories:', error);
      return reply.code(500).send({
        error: 'Failed to list repositories',
        message: error.message,
      });
    }
  });

  /**
   * GET /api/repos/:owner/:repo/prs - List PRs for a repository
   * Query params: limit, offset, sortBy, state
   */
  fastify.get<{ Params: RepoParams; Querystring: QueryParams }>(
    '/api/repos/:owner/:repo/prs',
    async (request, reply) => {
      const { owner, repo } = request.params;
      const { limit, offset, sortBy, state } = request.query;

      try {
        const repoId = db.upsertRepository(owner, repo);
        const prs = db.getPRs(repoId, {
          limit: limit ? parseInt(limit, 10) : undefined,
          offset: offset ? parseInt(offset, 10) : 0,
          sortBy: sortBy || 'total_score DESC',
          state: state,
        });

        return {
          repo: `${owner}/${repo}`,
          total: prs.length,
          prs,
        };
      } catch (error: any) {
        console.error(`❌ Failed to list PRs for ${owner}/${repo}:`, error);
        return reply.code(500).send({
          error: 'Failed to list PRs',
          message: error.message,
        });
      }
    }
  );

  /**
   * GET /api/repos/:owner/:repo/prs/:number - Get single PR details
   */
  fastify.get<{ Params: RepoPRParams }>(
    '/api/repos/:owner/:repo/prs/:number',
    async (request, reply) => {
      const { owner, repo, number } = request.params;
      const prNumber = parseInt(number, 10);

      if (isNaN(prNumber)) {
        return reply.code(400).send({
          error: 'Invalid PR number',
          message: 'PR number must be a valid integer',
        });
      }

      try {
        const repoId = db.upsertRepository(owner, repo);
        const pr = db.getPRByNumber(repoId, prNumber);

        if (!pr) {
          return reply.code(404).send({
            error: 'PR not found',
            message: `PR #${prNumber} not found in database`,
          });
        }

        return { pr };
      } catch (error: any) {
        console.error(`❌ Failed to get PR #${prNumber} for ${owner}/${repo}:`, error);
        return reply.code(500).send({
          error: 'Failed to get PR',
          message: error.message,
        });
      }
    }
  );

  /**
   * POST /api/repos/:owner/:repo/scan - Trigger a new scan
   * Scans the repository, saves results to DB, and returns the scan result
   */
  fastify.post<{ Params: RepoParams }>(
    '/api/repos/:owner/:repo/scan',
    async (request, reply) => {
      const { owner, repo } = request.params;
      const repoFullName = `${owner}/${repo}`;

      console.error(`🚀 Starting scan for ${repoFullName}...`);
      broadcaster.broadcast('scan_start', { repo: repoFullName, timestamp: new Date().toISOString() });

      try {
        // Create scanner with configured settings
        const scanConfig: TreliqConfig = {
          ...config.treliqConfig,
          repo: repoFullName,
          dbPath: config.dbPath,
        };

        const scanner = new TreliqScanner(scanConfig);
        const result = await scanner.scan();

        console.error(`✅ Scan complete for ${repoFullName}: ${result.totalPRs} PRs, ${result.spamCount} spam`);

        // Broadcast to connected dashboard clients
        broadcaster.broadcast('scan_complete', {
          repo: repoFullName,
          totalPRs: result.totalPRs,
          spamCount: result.spamCount,
          duplicateClusters: result.duplicateClusters.length,
          timestamp: new Date().toISOString(),
        });

        return result;
      } catch (error: any) {
        console.error(`❌ Scan failed for ${repoFullName}:`, error);
        return reply.code(500).send({
          error: 'Scan failed',
          message: error.message,
        });
      }
    }
  );

  /**
   * GET /api/repos/:owner/:repo/scans - Get scan history
   * Query params: limit (default: 10)
   */
  fastify.get<{ Params: RepoParams; Querystring: { limit?: string } }>(
    '/api/repos/:owner/:repo/scans',
    async (request, reply) => {
      const { owner, repo } = request.params;
      const { limit } = request.query;

      try {
        const repoId = db.upsertRepository(owner, repo);
        const history = db.getScanHistory(repoId, limit ? parseInt(limit, 10) : 10);

        return {
          repo: `${owner}/${repo}`,
          history,
        };
      } catch (error: any) {
        console.error(`❌ Failed to get scan history for ${owner}/${repo}:`, error);
        return reply.code(500).send({
          error: 'Failed to get scan history',
          message: error.message,
        });
      }
    }
  );

  /**
   * GET /api/repos/:owner/:repo/spam - Get spam PRs
   */
  fastify.get<{ Params: RepoParams }>(
    '/api/repos/:owner/:repo/spam',
    async (request, reply) => {
      const { owner, repo } = request.params;

      try {
        const repoId = db.upsertRepository(owner, repo);
        const spamPRs = db.getSpamPRs(repoId);

        return {
          repo: `${owner}/${repo}`,
          total: spamPRs.length,
          spamPRs,
        };
      } catch (error: any) {
        console.error(`❌ Failed to get spam PRs for ${owner}/${repo}:`, error);
        return reply.code(500).send({
          error: 'Failed to get spam PRs',
          message: error.message,
        });
      }
    }
  );

  // ========== SSE Events Endpoint ==========

  /**
   * GET /api/events - Server-Sent Events stream for real-time dashboard updates
   */
  fastify.get('/api/events', async (request: FastifyRequest, reply: FastifyReply) => {
    broadcaster.addClient(reply);
    // Don't return — keep connection open for SSE
    return reply;
  });

  // ========== GitHub App Setup Page ==========

  /**
   * GET /setup - GitHub App installation guide
   */
  fastify.get('/setup', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/html').send(`<!DOCTYPE html>
<html><head><title>Treliq Setup</title>
<style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:20px;background:#0d1117;color:#e6edf3}
a{color:#58a6ff}code{background:#161b22;padding:2px 6px;border-radius:4px}
.step{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin:12px 0}
h1{color:#2da44e}</style></head>
<body>
<h1>Treliq Setup</h1>
<p>Install Treliq as a GitHub App for automatic PR triage.</p>
<div class="step"><strong>Step 1:</strong> Create a GitHub App using the <a href="https://github.com/settings/apps/new">GitHub Developer Settings</a></div>
<div class="step"><strong>Step 2:</strong> Set webhook URL to: <code>${request.protocol}://${request.hostname}/webhooks</code></div>
<div class="step"><strong>Step 3:</strong> Enable <code>pull_request</code> events with <code>read/write</code> permissions</div>
<div class="step"><strong>Step 4:</strong> Install the App on your repositories</div>
<div class="step"><strong>Step 5:</strong> Start the server with <code>--webhook-secret YOUR_SECRET</code></div>
<p style="margin-top:24px"><a href="/">← Back to Dashboard</a></p>
</body></html>`);
  });

  // ========== Webhook Registration ==========

  if (config.webhookSecret) {
    console.error('🔗 Registering GitHub webhook handler...');
    registerWebhooks(fastify, {
      secret: config.webhookSecret,
      treliqConfig: config.treliqConfig,
      db,
      broadcaster,
    });
  }

  // ========== Error Handler ==========

  fastify.setErrorHandler((error: Error, request, reply) => {
    console.error('❌ Request error:', error);
    reply.code(500).send({
      error: 'Internal server error',
      message: error.message,
    });
  });

  return fastify;
}
