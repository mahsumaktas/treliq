const mockGraphqlClient = jest.fn();
const mockGraphqlDefaults = jest.fn(() => mockGraphqlClient);

const mockOctokitInstance = {
  pulls: {
    list: jest.fn(),
    get: jest.fn(),
    listFiles: jest.fn(),
    listReviews: jest.fn(),
  },
  checks: {
    listForRef: jest.fn(),
  },
  repos: {
    getCombinedStatusForRef: jest.fn(),
    getContent: jest.fn(),
  },
  users: {
    getByUsername: jest.fn(),
  },
};

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => mockOctokitInstance),
}));

jest.mock('@octokit/graphql', () => ({
  graphql: {
    defaults: mockGraphqlDefaults,
  },
}));

jest.mock('../../src/core/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import type { LLMProvider } from '../../src/core/provider';
import type { TreliqConfig, PRData } from '../../src/core/types';
import { TreliqScanner } from '../../src/core/scanner';
import { createPRData, createScoredPR } from '../fixtures/pr-factory';

function baseConfig(overrides: Partial<TreliqConfig> = {}): TreliqConfig {
  return {
    repo: 'acme/repo',
    token: 'ghs_test',
    provider: undefined,
    duplicateThreshold: 0.85,
    relatedThreshold: 0.8,
    maxPRs: 100,
    outputFormat: 'json',
    comment: false,
    trustContributors: false,
    useCache: false,
    cacheFile: '.treliq-cache.json',
    ...overrides,
  };
}

function withMockRateLimit(scanner: TreliqScanner) {
  const rateLimit = {
    waitIfNeeded: jest.fn().mockResolvedValue(undefined),
    updateFromHeaders: jest.fn(),
  };
  (scanner as any).rateLimit = rateLimit;
  return rateLimit;
}

function makeRestPR(number: number, overrides: Record<string, any> = {}) {
  return {
    number,
    title: `feat: PR ${number}`,
    body: 'Fixes #77',
    user: { login: `user${number}` },
    author_association: 'CONTRIBUTOR',
    created_at: '2026-02-10T10:00:00.000Z',
    updated_at: '2026-02-11T10:00:00.000Z',
    head: { ref: `feature-${number}`, sha: `sha-${number}` },
    base: { ref: 'main' },
    labels: [{ name: 'enhancement' }],
    diff_url: `https://github.com/acme/repo/pull/${number}.diff`,
    draft: false,
    milestone: null,
    requested_reviewers: [{ login: 'reviewer1' }],
    changed_files: 2,
    additions: 12,
    deletions: 3,
    commits: 1,
    mergeable_state: 'clean',
    comments: 2,
    ...overrides,
  };
}

describe('TreliqScanner', () => {
  beforeEach(() => {
    mockGraphqlDefaults.mockClear();
    mockGraphqlClient.mockReset();

    mockOctokitInstance.pulls.list.mockReset();
    mockOctokitInstance.pulls.get.mockReset();
    mockOctokitInstance.pulls.listFiles.mockReset();
    mockOctokitInstance.pulls.listReviews.mockReset();
    mockOctokitInstance.checks.listForRef.mockReset();
    mockOctokitInstance.repos.getCombinedStatusForRef.mockReset();
    mockOctokitInstance.repos.getContent.mockReset();
    mockOctokitInstance.users.getByUsername.mockReset();
  });

  it('fetches PRs via GraphQL when available', async () => {
    const scanner = new TreliqScanner(baseConfig({ maxPRs: 5 }));
    const rateLimit = withMockRateLimit(scanner);

    mockGraphqlClient.mockResolvedValueOnce({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 3,
              title: 'feat: graphql path',
              body: 'Fixes #12',
              isDraft: false,
              createdAt: '2026-02-10T10:00:00.000Z',
              updatedAt: '2026-02-11T10:00:00.000Z',
              author: { login: 'alice' },
              authorAssociation: 'MEMBER',
              headRefName: 'feat/graphql',
              baseRefName: 'main',
              headRefOid: 'sha-3',
              additions: 20,
              deletions: 5,
              changedFiles: 2,
              milestone: null,
              labels: { nodes: [{ name: 'high-priority' }] },
              reviewRequests: { nodes: [{ requestedReviewer: { login: 'reviewer1' } }] },
              reviews: { nodes: [{ state: 'APPROVED' }], totalCount: 1 },
              comments: { totalCount: 1 },
              mergeable: 'MERGEABLE',
              files: { nodes: [{ path: 'src/main.ts' }, { path: 'test/main.test.ts' }] },
              commits: {
                nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }],
                totalCount: 2,
              },
            },
          ],
        },
      },
    });

    const prs = await scanner.fetchPRs();

    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(3);
    expect(prs[0].ciStatus).toBe('success');
    expect(prs[0].reviewState).toBe('approved');
    expect(prs[0].hasTests).toBe(true);
    expect(scanner.shaMap.get(3)).toBe('sha-3');
    expect(rateLimit.waitIfNeeded).toHaveBeenCalled();
  });

  it('falls back to REST when GraphQL fetch fails', async () => {
    const scanner = new TreliqScanner(baseConfig({ maxPRs: 5 }));
    const rateLimit = withMockRateLimit(scanner);

    mockGraphqlClient.mockRejectedValueOnce(new Error('GraphQL unavailable'));
    mockOctokitInstance.pulls.list
      .mockResolvedValueOnce({ data: [makeRestPR(1)], headers: {} })
      .mockResolvedValueOnce({ data: [], headers: {} });
    mockOctokitInstance.pulls.get.mockResolvedValue({ data: makeRestPR(1), headers: {} });
    mockOctokitInstance.pulls.listFiles.mockResolvedValue({
      data: [{ filename: 'src/main.ts' }, { filename: 'test/main.test.ts' }],
    });
    mockOctokitInstance.checks.listForRef.mockRejectedValue(new Error('Checks unavailable'));
    mockOctokitInstance.repos.getCombinedStatusForRef.mockResolvedValue({
      data: { state: 'success' },
    });
    mockOctokitInstance.pulls.listReviews.mockResolvedValue({
      data: [{ state: 'COMMENTED' }],
    });

    const prs = await scanner.fetchPRs();

    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(1);
    expect(prs[0].ciStatus).toBe('success');
    expect(prs[0].reviewState).toBe('commented');
    expect(prs[0].hasIssueRef).toBe(true);
    expect(scanner.shaMap.get(1)).toBe('sha-1');
    expect(rateLimit.updateFromHeaders).toHaveBeenCalled();
  });

  it('falls back to REST for PR list when GraphQL list fails', async () => {
    const scanner = new TreliqScanner(baseConfig({ maxPRs: 3 }));
    withMockRateLimit(scanner);

    mockGraphqlClient.mockRejectedValue(new Error('List query failed'));
    mockOctokitInstance.pulls.list
      .mockResolvedValueOnce({
        data: [makeRestPR(10), makeRestPR(11)],
        headers: {},
      })
      .mockResolvedValueOnce({ data: [], headers: {} });

    const items = await (scanner as any).fetchPRList();

    expect(items).toEqual([
      { number: 10, updatedAt: '2026-02-11T10:00:00.000Z', headSha: 'sha-10' },
      { number: 11, updatedAt: '2026-02-11T10:00:00.000Z', headSha: 'sha-11' },
    ]);
  });

  it('fetches specific PR details via GraphQL and records sha map', async () => {
    const scanner = new TreliqScanner(baseConfig());
    withMockRateLimit(scanner);

    mockGraphqlClient.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          number: 88,
          title: 'fix: race condition',
          body: 'addresses #21',
          isDraft: false,
          createdAt: '2026-02-10T10:00:00.000Z',
          updatedAt: '2026-02-11T10:00:00.000Z',
          author: { login: 'contributor' },
          authorAssociation: 'CONTRIBUTOR',
          headRefName: 'fix/race',
          baseRefName: 'main',
          headRefOid: 'sha-88',
          additions: 5,
          deletions: 2,
          changedFiles: 1,
          milestone: null,
          labels: { nodes: [] },
          reviewRequests: { nodes: [] },
          reviews: { nodes: [], totalCount: 0 },
          comments: { totalCount: 0 },
          mergeable: 'MERGEABLE',
          files: { nodes: [{ path: 'src/race.ts' }] },
          commits: {
            nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }],
            totalCount: 1,
          },
        },
      },
    });

    const prs = await scanner.fetchPRDetails([88]);

    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(88);
    expect(prs[0].ciStatus).toBe('pending');
    expect(scanner.shaMap.get(88)).toBe('sha-88');
  });

  it('fetches PR details via REST helper', async () => {
    const scanner = new TreliqScanner(baseConfig());
    withMockRateLimit(scanner);

    mockOctokitInstance.pulls.get.mockResolvedValue({ data: makeRestPR(44), headers: {} });
    mockOctokitInstance.pulls.listFiles.mockResolvedValue({
      data: [{ filename: 'src/service.ts' }, { filename: 'spec/service.spec.ts' }],
    });
    mockOctokitInstance.checks.listForRef.mockResolvedValue({
      data: {
        total_count: 1,
        check_runs: [{ conclusion: 'failure' }],
      },
    });
    mockOctokitInstance.pulls.listReviews.mockResolvedValue({
      data: [{ state: 'CHANGES_REQUESTED' }],
    });

    const prs = await (scanner as any).fetchPRDetailsREST('acme', 'repo', [44]);

    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(44);
    expect(prs[0].ciStatus).toBe('failure');
    expect(prs[0].reviewState).toBe('changes_requested');
    expect(prs[0].hasTests).toBe(true);
  });

  it('parses CODEOWNERS and matches owners against changed files', async () => {
    const scanner = new TreliqScanner(baseConfig());

    mockOctokitInstance.repos.getContent
      .mockRejectedValueOnce(new Error('Missing .github/CODEOWNERS'))
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from('src/* @alice\ndocs/* @docs-team\n', 'utf-8').toString('base64'),
        },
      });

    const codeowners = await (scanner as any).fetchCodeowners('acme', 'repo');
    const matched = (scanner as any).matchCodeowners(
      ['src/index.ts', 'docs/readme.md', 'package.json'],
      codeowners,
    );

    expect(codeowners.get('src/*')).toEqual(['alice']);
    expect(codeowners.get('docs/*')).toEqual(['docs-team']);
    expect(new Set(matched)).toEqual(new Set(['alice', 'docs-team']));
  });

  it('fetches vision doc from fallback file names', async () => {
    const scanner = new TreliqScanner(baseConfig());

    mockOctokitInstance.repos.getContent
      .mockRejectedValueOnce(new Error('No VISION.md'))
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from('Project roadmap and north star', 'utf-8').toString('base64'),
        },
      });

    const doc = await (scanner as any).fetchVisionDoc('acme', 'repo');

    expect(doc).toBe('Project roadmap and north star');
  });

  it('runs scan end-to-end in heuristic mode', async () => {
    const scanner = new TreliqScanner(baseConfig({ useCache: false }));

    const pr1 = createPRData({
      number: 1,
      title: 'feat: add API validation',
      author: 'alice',
      changedFiles: ['src/api.ts'],
    });
    const pr2 = createPRData({
      number: 2,
      title: 'docs: update README',
      author: 'bob',
      changedFiles: ['README.md'],
    });

    jest.spyOn(scanner as any, 'fetchCodeowners').mockResolvedValue(new Map([['src/*', ['alice']]]));
    jest.spyOn(scanner as any, 'fetchPRs').mockResolvedValue([pr1, pr2]);
    jest.spyOn(scanner as any, 'fetchReputations').mockResolvedValue(undefined);

    const scoreMany = jest.fn(async (prs: PRData[]) => prs.map(pr => createScoredPR({
      ...pr,
      totalScore: pr.number === 1 ? 90 : 45,
      isSpam: false,
      spamReasons: [],
    })));
    (scanner as any).scoring = {
      scoreMany,
      setReputation: jest.fn(),
    };

    const result = await scanner.scan();
    const scoredInput = scoreMany.mock.calls[0][0] as PRData[];

    expect(result.totalPRs).toBe(2);
    expect(result.rankedPRs[0].number).toBe(1);
    expect(result.duplicateClusters).toEqual([]);
    expect(result.summary).toContain('Scanned 2 PRs in acme/repo');
    expect(scoredInput[0].codeowners).toEqual(['alice']);
    expect(scoredInput[1].codeowners).toEqual([]);
  });

  it('runs scan with provider and applies vision alignment when vision doc exists', async () => {
    const provider: LLMProvider = {
      name: 'mock-provider',
      generateText: jest.fn().mockResolvedValue('{"score": 79, "alignment": "aligned", "reason": "Matches roadmap"}'),
      generateEmbedding: jest.fn().mockResolvedValue([1, 0, 0]),
    };

    const scanner = new TreliqScanner(baseConfig({
      provider,
      useCache: false,
    }));

    const pr = createPRData({
      number: 5,
      title: 'feat: roadmap-aligned change',
      body: 'Implements roadmap item',
      changedFiles: ['src/feature.ts'],
    });

    jest.spyOn(scanner as any, 'fetchCodeowners').mockResolvedValue(new Map());
    jest.spyOn(scanner as any, 'fetchPRs').mockResolvedValue([pr]);
    jest.spyOn(scanner as any, 'fetchReputations').mockResolvedValue(undefined);
    jest.spyOn(scanner as any, 'fetchVisionDoc').mockResolvedValue('Roadmap: improve DX and stability');

    (scanner as any).scoring = {
      scoreMany: jest.fn(async (prs: PRData[]) => prs.map(p => createScoredPR({
        ...p,
        totalScore: 80,
        isSpam: false,
      }))),
      setReputation: jest.fn(),
    };

    const result = await scanner.scan();

    expect(result.totalPRs).toBe(1);
    expect(result.duplicateClusters).toEqual([]);
    expect(result.rankedPRs[0].visionAlignment).toBe('aligned');
    expect(result.rankedPRs[0].visionScore).toBe(79);
    expect(provider.generateText).toHaveBeenCalled();
  });
});
