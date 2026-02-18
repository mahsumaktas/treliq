/**
 * Unit tests for webhook signature verification and route handling.
 */

import { createHmac } from 'crypto';
import type { TreliqConfig } from '../../src/core/types';

const mockFetchPRDetails = jest.fn();
const mockScore = jest.fn();

jest.mock('../../src/core/scanner', () => ({
  TreliqScanner: jest.fn().mockImplementation(() => ({
    fetchPRDetails: mockFetchPRDetails,
    scoring: {
      score: mockScore,
    },
  })),
}));

jest.mock('../../src/core/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Keep mocks for Octokit ESM modules to avoid import issues in this test runtime.
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/graphql', () => ({ graphql: jest.fn() }));

import { registerWebhooks, verifySignature } from '../../src/server/webhooks';

function computeSignature(payload: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(payload, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

function createReply() {
  return {
    code: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
}

function makeConfig(overrides: Partial<any> = {}) {
  const db = {
    upsertRepository: jest.fn().mockReturnValue(1),
    updatePRState: jest.fn(),
    upsertPR: jest.fn(),
    upsertInstallation: jest.fn(),
    linkInstallationRepo: jest.fn(),
    deleteInstallation: jest.fn(),
    suspendInstallation: jest.fn(),
    getRepositories: jest.fn().mockReturnValue([{ id: 1, owner: 'acme', repo: 'repo' }]),
    unlinkInstallationRepo: jest.fn(),
    ...overrides.db,
  };
  const broadcaster = {
    broadcast: jest.fn(),
    ...overrides.broadcaster,
  };
  const treliqConfig: TreliqConfig = {
    repo: 'acme/repo',
    token: 'ghs_token',
    provider: undefined,
    duplicateThreshold: 0.85,
    relatedThreshold: 0.8,
    maxPRs: 100,
    outputFormat: 'json',
    comment: false,
    trustContributors: false,
    useCache: false,
    cacheFile: '.treliq-cache.json',
  };

  return {
    secret: 'test-webhook-secret',
    treliqConfig,
    db,
    broadcaster,
  };
}

async function getWebhookHandler(config: any) {
  const fastify = {
    post: jest.fn(),
  } as any;
  registerWebhooks(fastify, config);
  const [, handler] = fastify.post.mock.calls[0];
  return handler;
}

describe('verifySignature', () => {
  const secret = 'test-webhook-secret';
  const payload = '{"action":"opened","number":1}';

  it('returns true for valid signature', () => {
    const valid = computeSignature(payload, secret);
    expect(verifySignature(payload, valid, secret)).toBe(true);
  });

  it('returns false for invalid signature', () => {
    expect(verifySignature(payload, 'sha256=invalidhexstring', secret)).toBe(false);
  });

  it('returns false for empty signature', () => {
    expect(verifySignature(payload, '', secret)).toBe(false);
  });

  it('returns false for tampered payload', () => {
    const valid = computeSignature(payload, secret);
    const tampered = '{"action":"closed","number":1}';
    expect(verifySignature(tampered, valid, secret)).toBe(false);
  });

  it('returns false for wrong secret', () => {
    const valid = computeSignature(payload, secret);
    expect(verifySignature(payload, valid, 'wrong-secret')).toBe(false);
  });

  it('returns false for malformed signature', () => {
    const hmac = createHmac('sha256', secret);
    hmac.update(payload, 'utf8');
    const invalid = hmac.digest('hex');
    expect(verifySignature(payload, invalid, secret)).toBe(false);
  });
});

describe('registerWebhooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchPRDetails.mockReset();
    mockScore.mockReset();
  });

  it('registers POST /webhooks', async () => {
    const config = makeConfig();
    const fastify = { post: jest.fn() } as any;

    registerWebhooks(fastify, config);

    expect(fastify.post).toHaveBeenCalledTimes(1);
    expect(fastify.post.mock.calls[0][0]).toBe('/webhooks');
  });

  it('returns 401 for invalid signature', async () => {
    const config = makeConfig();
    const handler = await getWebhookHandler(config);
    const reply = createReply();
    const body = { action: 'opened' };

    await handler({
      headers: {
        'x-hub-signature-256': 'sha256=invalid',
        'x-github-event': 'pull_request',
      },
      body,
    } as any, reply as any);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Invalid signature' });
  });

  it('returns 400 when payload cannot be stringified', async () => {
    const config = makeConfig();
    const handler = await getWebhookHandler(config);
    const reply = createReply();
    const body = { value: BigInt(1) };

    await handler({
      headers: {
        'x-hub-signature-256': 'sha256=anything',
        'x-github-event': 'pull_request',
      },
      body,
    } as any, reply as any);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Invalid JSON payload' });
  });

  it('handles ping event', async () => {
    const config = makeConfig();
    const handler = await getWebhookHandler(config);
    const reply = createReply();
    const body = { zen: 'keep it logically awesome' };
    const signature = computeSignature(JSON.stringify(body), config.secret);

    await handler({
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'ping',
      },
      body,
    } as any, reply as any);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ status: 'pong' });
  });

  it('handles pull_request opened event and stores score', async () => {
    const config = makeConfig();
    const handler = await getWebhookHandler(config);
    const reply = createReply();

    const payload = {
      action: 'opened',
      repository: {
        owner: { login: 'acme' },
        name: 'repo',
        full_name: 'acme/repo',
      },
      pull_request: {
        number: 15,
        title: 'feat: test',
        state: 'open',
        merged: false,
        html_url: 'https://github.com/acme/repo/pull/15',
        base: {
          repo: {
            owner: { login: 'acme' },
            name: 'repo',
          },
        },
      },
    };

    mockFetchPRDetails.mockResolvedValue([
      {
        number: 15,
        title: 'feat: test',
      },
    ]);
    mockScore.mockResolvedValue({
      number: 15,
      totalScore: 91,
      isSpam: false,
    });

    const signature = computeSignature(JSON.stringify(payload), config.secret);

    await handler({
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'pull_request',
      },
      body: payload,
    } as any, reply as any);

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ status: 'processed' });
    expect(mockFetchPRDetails).toHaveBeenCalledWith([15]);
    expect(config.db.upsertPR).toHaveBeenCalled();
    expect(config.broadcaster.broadcast).toHaveBeenCalledWith(
      'pr_scored',
      expect.objectContaining({ repo: 'acme/repo', prNumber: 15, totalScore: 91 }),
    );
  });

  it('handles pull_request closed event', async () => {
    const config = makeConfig();
    const handler = await getWebhookHandler(config);
    const reply = createReply();

    const payload = {
      action: 'closed',
      repository: {
        owner: { login: 'acme' },
        name: 'repo',
        full_name: 'acme/repo',
      },
      pull_request: {
        number: 99,
        title: 'fix: done',
        state: 'closed',
        merged: true,
        html_url: 'https://github.com/acme/repo/pull/99',
        base: {
          repo: {
            owner: { login: 'acme' },
            name: 'repo',
          },
        },
      },
    };
    const signature = computeSignature(JSON.stringify(payload), config.secret);

    await handler({
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'pull_request',
      },
      body: payload,
    } as any, reply as any);

    expect(config.db.updatePRState).toHaveBeenCalledWith(1, 99, 'merged');
    expect(config.broadcaster.broadcast).toHaveBeenCalledWith(
      'pr_closed',
      expect.objectContaining({ repo: 'acme/repo', prNumber: 99, state: 'merged' }),
    );
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it('handles installation created and links repositories', async () => {
    const config = makeConfig();
    const handler = await getWebhookHandler(config);
    const reply = createReply();

    const payload = {
      action: 'created',
      installation: {
        id: 33,
        account: {
          login: 'acme',
          type: 'Organization',
        },
      },
      repositories: [
        { id: 1, full_name: 'acme/repo-a' },
        { id: 2, full_name: 'acme/repo-b' },
      ],
    };
    const signature = computeSignature(JSON.stringify(payload), config.secret);

    await handler({
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'installation',
      },
      body: payload,
    } as any, reply as any);

    expect(config.db.upsertInstallation).toHaveBeenCalledWith(33, 'Organization', 'acme');
    expect(config.db.linkInstallationRepo).toHaveBeenCalledTimes(2);
    expect(config.broadcaster.broadcast).toHaveBeenCalledWith(
      'installation_created',
      expect.objectContaining({ installationId: 33, repoCount: 2 }),
    );
    expect(reply.code).toHaveBeenCalledWith(200);
  });

  it('returns 500 when pull_request scoring fails', async () => {
    const config = makeConfig();
    const handler = await getWebhookHandler(config);
    const reply = createReply();

    const payload = {
      action: 'opened',
      repository: {
        owner: { login: 'acme' },
        name: 'repo',
        full_name: 'acme/repo',
      },
      pull_request: {
        number: 123,
        title: 'feat: break',
        state: 'open',
        merged: false,
        html_url: 'https://github.com/acme/repo/pull/123',
        base: {
          repo: {
            owner: { login: 'acme' },
            name: 'repo',
          },
        },
      },
    };

    mockFetchPRDetails.mockResolvedValue([]);
    const signature = computeSignature(JSON.stringify(payload), config.secret);

    await handler({
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'pull_request',
      },
      body: payload,
    } as any, reply as any);

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Webhook processing failed' }),
    );
  });
});
