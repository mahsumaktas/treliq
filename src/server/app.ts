/**
 * Treliq Server - REST API using Fastify
 *
 * Provides HTTP endpoints for scanning repositories, querying PRs,
 * accessing scan history, and serving the dashboard with real-time SSE updates.
 */

import path from 'path';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { TreliqDB } from '../core/db';
import { TreliqScanner } from '../core/scanner';
import type { TreliqConfig } from '../core/types';
import { registerWebhooks } from './webhooks';
import { SSEBroadcaster } from './sse';
import { getAuthMode, getAppConfig } from '../core/app-config';
import { createLogger } from '../core/logger';

const log = createLogger('server');

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
    logger: false, // We use Pino logger (src/core/logger.ts) for structured logging
    requestTimeout: 120000, // 2 minutes for scan operations
  });

  // CORS — configurable via CORS_ORIGINS env var
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : undefined; // undefined = allow all in development

  await fastify.register(cors, {
    origin: allowedOrigins ?? true,
  });

  // Security headers
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://github.com', 'https://avatars.githubusercontent.com'],
        connectSrc: ["'self'"],
      },
    },
  });

  // Rate limiting
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please retry later.',
    }),
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
  log.info({ dbPath: config.dbPath }, 'Database opened');

  // SSE broadcaster for real-time dashboard updates
  const broadcaster = new SSEBroadcaster();
  // Keepalive ping every 30 seconds
  const keepaliveInterval = setInterval(() => broadcaster.ping(), 30_000);

  // Graceful shutdown
  const closeGracefully = async (signal: string) => {
    log.info({ signal }, 'Received signal, closing server gracefully');
    try {
      clearInterval(keepaliveInterval);
      broadcaster.closeAll();
      db.close();
      await fastify.close();
      log.info('Server closed');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => closeGracefully('SIGTERM'));
  process.on('SIGINT', () => closeGracefully('SIGINT'));

  // Input validation schemas
  const repoParamSchema = {
    type: 'object' as const,
    properties: {
      owner: { type: 'string' as const, pattern: '^[a-zA-Z0-9._-]+$', maxLength: 39 },
      repo: { type: 'string' as const, pattern: '^[a-zA-Z0-9._-]+$', maxLength: 100 },
    },
    required: ['owner', 'repo'] as const,
  };

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
      log.error({ err: error }, 'Failed to list repositories');
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
    { schema: { params: repoParamSchema } },
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
        log.error({ repo: `${owner}/${repo}`, err: error }, 'Failed to list PRs');
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
    { schema: { params: repoParamSchema } },
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
        log.error({ repo: `${owner}/${repo}`, pr: prNumber, err: error }, 'Failed to get PR');
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
    {
      schema: { params: repoParamSchema },
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '5 minutes',
        },
      },
    },
    async (request, reply) => {
      const { owner, repo } = request.params;
      const repoFullName = `${owner}/${repo}`;

      log.info({ repo: repoFullName }, 'Starting scan');
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

        log.info({ repo: repoFullName, totalPRs: result.totalPRs, spamCount: result.spamCount }, 'Scan complete');

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
        log.error({ repo: repoFullName, err: error }, 'Scan failed');
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
    { schema: { params: repoParamSchema } },
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
        log.error({ repo: `${owner}/${repo}`, err: error }, 'Failed to get scan history');
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
    { schema: { params: repoParamSchema } },
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
        log.error({ repo: `${owner}/${repo}`, err: error }, 'Failed to get spam PRs');
        return reply.code(500).send({
          error: 'Failed to get spam PRs',
          message: error.message,
        });
      }
    }
  );

  /**
   * GET /api/repos/:owner/:repo/issues - List issues for a repository
   * Query params: limit, offset, sortBy, state
   */
  fastify.get<{ Params: RepoParams; Querystring: QueryParams }>(
    '/api/repos/:owner/:repo/issues',
    { schema: { params: repoParamSchema } },
    async (request, reply) => {
      const { owner, repo } = request.params;
      const { limit, offset, sortBy, state } = request.query;

      try {
        const repoId = db.upsertRepository(owner, repo);
        const issues = db.getIssues(repoId, {
          limit: limit ? parseInt(limit, 10) : undefined,
          offset: offset ? parseInt(offset, 10) : 0,
          sortBy: sortBy || 'total_score DESC',
          state: state,
        });

        return {
          repo: `${owner}/${repo}`,
          total: issues.length,
          issues,
        };
      } catch (error: any) {
        log.error({ repo: `${owner}/${repo}`, err: error }, 'Failed to list issues');
        return reply.code(500).send({
          error: 'Failed to list issues',
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

  // ========== GitHub App Setup Flow ==========

  /**
   * GET /setup - GitHub App setup page with manifest-based creation
   */
  fastify.get('/setup', async (request: FastifyRequest, reply: FastifyReply) => {
    const proto = request.headers['x-forwarded-proto'] || request.protocol;
    const host = request.headers['x-forwarded-host'] || request.hostname;
    const baseUrl = `${proto}://${host}`;
    const authMode = getAuthMode();

    const manifest = JSON.stringify({
      name: 'Treliq PR Triage',
      description: 'AI-powered PR triage, scoring, and duplicate detection',
      url: 'https://github.com/mahsumaktas/treliq',
      hook_attributes: { url: `${baseUrl}/webhooks`, active: true },
      redirect_url: `${baseUrl}/setup/callback`,
      public: true,
      default_events: ['pull_request', 'installation', 'installation_repositories'],
      default_permissions: {
        pull_requests: 'write',
        contents: 'read',
        checks: 'read',
        issues: 'write',
      },
    });

    reply.type('text/html').send(`<!DOCTYPE html>
<html><head><title>Treliq Setup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0f;color:#e6edf3;min-height:100vh;display:flex;justify-content:center;padding:40px 20px}
.container{max-width:600px;width:100%}
h1{font-size:28px;margin-bottom:8px;color:#fff}
.subtitle{color:#8b949e;margin-bottom:32px;font-size:15px}
.status{background:#12131a;border:1px solid #2a2b36;border-radius:12px;padding:20px;margin-bottom:24px}
.status-label{font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#8b949e;margin-bottom:8px}
.status-value{font-size:16px;font-weight:600}
.status-value.app{color:#2da44e}
.status-value.pat{color:#d29922}
.steps{display:flex;flex-direction:column;gap:16px;margin-bottom:32px}
.step{background:#12131a;border:1px solid #2a2b36;border-radius:12px;padding:20px}
.step-num{display:inline-block;width:28px;height:28px;background:#1a1b26;border-radius:50%;text-align:center;line-height:28px;font-size:13px;font-weight:600;color:#58a6ff;margin-bottom:12px}
.step h3{font-size:15px;margin-bottom:6px;color:#fff}
.step p{color:#8b949e;font-size:14px;line-height:1.5}
code{background:#1a1b26;padding:2px 8px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:13px;color:#58a6ff}
.btn{display:inline-block;background:#238636;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;border:none;cursor:pointer;transition:background 0.15s}
.btn:hover{background:#2ea043}
.btn-secondary{background:#21262d;border:1px solid #30363d}
.btn-secondary:hover{background:#30363d}
form{display:inline}
.back{margin-top:24px;display:block;color:#58a6ff;text-decoration:none;font-size:14px}
</style></head>
<body>
<div class="container">
  <h1>Treliq Setup</h1>
  <p class="subtitle">Configure Treliq as a GitHub App for automatic PR triage</p>

  <div class="status">
    <div class="status-label">Current Mode</div>
    <div class="status-value ${authMode}">${authMode === 'app' ? '● GitHub App Mode' : '● Personal Access Token Mode'}</div>
  </div>

  <div class="steps">
    <div class="step">
      <div class="step-num">1</div>
      <h3>Create GitHub App</h3>
      <p>Click below to create a GitHub App with pre-configured permissions and webhook settings.</p>
      <br>
      <form action="https://github.com/settings/apps/new" method="post">
        <input type="hidden" name="manifest" value='${manifest.replace(/'/g, "&#39;")}'>
        <button type="submit" class="btn">Create GitHub App</button>
      </form>
    </div>

    <div class="step">
      <div class="step-num">2</div>
      <h3>Save Credentials</h3>
      <p>After creation, you'll receive App ID and Private Key. Add them to your environment:</p>
      <br>
      <code>GITHUB_APP_ID=your_app_id</code><br><br>
      <code>GITHUB_PRIVATE_KEY_PATH=./private-key.pem</code><br><br>
      <code>GITHUB_WEBHOOK_SECRET=your_secret</code>
    </div>

    <div class="step">
      <div class="step-num">3</div>
      <h3>Restart Server</h3>
      <p>Restart Treliq server to activate GitHub App mode. The server auto-detects the mode from environment variables.</p>
    </div>

    <div class="step">
      <div class="step-num">4</div>
      <h3>Install on Repositories</h3>
      <p>Go to your GitHub App settings and install it on the repositories you want to triage.</p>
    </div>
  </div>

  <div>
    <a href="/" class="btn btn-secondary">← Back to Dashboard</a>
    &nbsp;&nbsp;
    <a href="https://github.com/mahsumaktas/treliq/blob/main/docs/DEPLOYMENT.md" class="btn btn-secondary" target="_blank">Deployment Guide</a>
  </div>
</div>
</body></html>`);
  });

  /**
   * GET /setup/callback - Handle GitHub App manifest creation callback
   */
  fastify.get<{ Querystring: { code?: string } }>(
    '/setup/callback',
    async (request, reply) => {
      const { code } = request.query;

      if (!code) {
        return reply.code(400).type('text/html').send(`<!DOCTYPE html>
<html><head><title>Treliq Setup - Error</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#e6edf3;display:flex;justify-content:center;padding:40px}
.container{max-width:600px}.error{background:#3d1a1a;border:1px solid #f85149;border-radius:12px;padding:20px;margin:20px 0}
a{color:#58a6ff}</style></head>
<body><div class="container">
<h1>Setup Error</h1>
<div class="error">Missing authorization code. Please try the setup process again.</div>
<a href="/setup">← Back to Setup</a>
</div></body></html>`);
      }

      try {
        // Exchange code for app credentials
        const response = await fetch(
          `https://api.github.com/app-manifests/${code}/conversions`,
          {
            method: 'POST',
            headers: {
              Accept: 'application/vnd.github+json',
            },
          }
        );

        if (!response.ok) {
          throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
        }

        const appData = await response.json() as {
          id: number;
          slug: string;
          name: string;
          client_id: string;
          client_secret: string;
          webhook_secret: string;
          pem: string;
          html_url: string;
        };

        reply.type('text/html').send(`<!DOCTYPE html>
<html><head><title>Treliq Setup - Complete</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#0a0a0f;color:#e6edf3;display:flex;justify-content:center;padding:40px 20px}
.container{max-width:700px;width:100%}
h1{color:#2da44e;margin-bottom:8px}
.subtitle{color:#8b949e;margin-bottom:24px}
.success{background:#1a3d1a;border:1px solid #2da44e;border-radius:12px;padding:20px;margin-bottom:24px}
.env-block{background:#12131a;border:1px solid #2a2b36;border-radius:12px;padding:20px;margin-bottom:24px;position:relative}
.env-block h3{margin-bottom:12px;font-size:15px;color:#fff}
pre{background:#0a0a0f;padding:16px;border-radius:8px;overflow-x:auto;font-family:'JetBrains Mono',monospace;font-size:13px;line-height:1.8;color:#e6edf3}
.copy-btn{position:absolute;top:16px;right:16px;background:#21262d;border:1px solid #30363d;color:#e6edf3;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px}
.copy-btn:hover{background:#30363d}
.warning{background:#3d2f1a;border:1px solid #d29922;border-radius:12px;padding:16px;margin-bottom:24px;font-size:14px;color:#d29922}
a{color:#58a6ff;text-decoration:none}
.btn{display:inline-block;background:#238636;color:#fff;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;margin-top:8px}
</style></head>
<body>
<div class="container">
  <h1>GitHub App Created!</h1>
  <p class="subtitle"><strong>${appData.name}</strong> (ID: ${appData.id})</p>

  <div class="success">App created successfully. Save the credentials below and add them to your environment.</div>

  <div class="warning">
    ⚠️ Save the private key NOW — it won't be shown again.
  </div>

  <div class="env-block">
    <h3>.env Configuration</h3>
    <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('env').textContent)">Copy</button>
    <pre id="env">GITHUB_APP_ID=${appData.id}
GITHUB_WEBHOOK_SECRET=${appData.webhook_secret}
GITHUB_CLIENT_ID=${appData.client_id}
GITHUB_CLIENT_SECRET=${appData.client_secret}

# Save the private key below to a file:
# GITHUB_PRIVATE_KEY_PATH=./private-key.pem</pre>
  </div>

  <div class="env-block">
    <h3>Private Key (save as private-key.pem)</h3>
    <button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('pem').textContent)">Copy</button>
    <pre id="pem">${appData.pem}</pre>
  </div>

  <p>Next steps:</p>
  <ol style="padding-left:20px;margin:12px 0;line-height:2;color:#8b949e">
    <li>Save the .env values and private key</li>
    <li>Restart the server with the new environment variables</li>
    <li><a href="${appData.html_url}/installations/new" target="_blank">Install the app</a> on your repositories</li>
  </ol>

  <a href="${appData.html_url}/installations/new" class="btn" target="_blank">Install on Repositories →</a>
</div>
</body></html>`);

      } catch (error: any) {
        log.error({ err: error }, 'GitHub App creation failed');
        reply.code(500).type('text/html').send(`<!DOCTYPE html>
<html><head><title>Treliq Setup - Error</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#e6edf3;display:flex;justify-content:center;padding:40px}
.container{max-width:600px}.error{background:#3d1a1a;border:1px solid #f85149;border-radius:12px;padding:20px;margin:20px 0}
a{color:#58a6ff}code{background:#1a1b26;padding:2px 6px;border-radius:4px;font-size:13px}</style></head>
<body><div class="container">
<h1>Setup Error</h1>
<div class="error">${error.message}</div>
<p>Please try the setup process again.</p>
<br><a href="/setup">← Back to Setup</a>
</div></body></html>`);
      }
    }
  );

  /**
   * GET /api/installations - List all GitHub App installations
   */
  fastify.get('/api/installations', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const installations = db.getInstallations();
      return { installations, authMode: getAuthMode() };
    } catch (error: any) {
      return reply.code(500).send({ error: 'Failed to list installations', message: error.message });
    }
  });

  // ========== Webhook Registration ==========

  if (config.webhookSecret) {
    log.info('Registering GitHub webhook handler');
    registerWebhooks(fastify, {
      secret: config.webhookSecret,
      treliqConfig: config.treliqConfig,
      db,
      broadcaster,
    });
  }

  // ========== Error Handler ==========

  fastify.setErrorHandler((error: Error, request, reply) => {
    log.error({ err: error }, 'Request error');
    reply.code(500).send({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : error.message,
    });
  });

  return fastify;
}
