import { mapGraphQLToPRData } from '../../src/core/graphql';

describe('mapGraphQLToPRData', () => {
  it('maps a full GraphQL node to PRData', () => {
    const node = {
      number: 42,
      title: 'feat: improve parser',
      body: 'Fixes #101 with better error handling',
      isDraft: false,
      createdAt: '2026-02-10T10:00:00.000Z',
      updatedAt: '2026-02-11T10:00:00.000Z',
      author: { login: 'alice' },
      authorAssociation: 'MEMBER',
      headRefName: 'feat/parser',
      baseRefName: 'main',
      headRefOid: 'abc123',
      additions: 120,
      deletions: 30,
      changedFiles: 2,
      milestone: { title: 'v1.1' },
      labels: { nodes: [{ name: 'high-priority' }] },
      reviewRequests: {
        nodes: [
          { requestedReviewer: { login: 'bob' } },
          { requestedReviewer: { name: 'core-team' } },
        ],
      },
      reviews: {
        nodes: [{ state: 'APPROVED' }],
        totalCount: 1,
      },
      comments: { totalCount: 3 },
      mergeable: 'MERGEABLE',
      files: { nodes: [{ path: 'src/parser.ts' }, { path: 'test/parser.test.ts' }] },
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }],
        totalCount: 4,
      },
    };

    const { pr, headSha } = mapGraphQLToPRData(node, 'owner', 'repo');

    expect(headSha).toBe('abc123');
    expect(pr.number).toBe(42);
    expect(pr.author).toBe('alice');
    expect(pr.ciStatus).toBe('success');
    expect(pr.mergeable).toBe('mergeable');
    expect(pr.reviewState).toBe('approved');
    expect(pr.requestedReviewers).toEqual(['bob', 'core-team']);
    expect(pr.hasIssueRef).toBe(true);
    expect(pr.issueNumbers).toEqual([101]);
    expect(pr.hasTests).toBe(true);
    expect(pr.testFilesChanged).toEqual(['test/parser.test.ts']);
    expect(pr.diffUrl).toBe('https://github.com/owner/repo/pull/42.diff');
  });

  it('maps fallbacks for missing optional fields', () => {
    const node = {
      number: 7,
      title: 'docs: update README #55',
      body: 'see #55',
      createdAt: '2026-02-12T10:00:00.000Z',
      updatedAt: '2026-02-13T10:00:00.000Z',
      author: null,
      authorAssociation: null,
      headRefName: null,
      baseRefName: null,
      headRefOid: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      milestone: null,
      labels: null,
      reviewRequests: null,
      reviews: {
        nodes: [{ state: 'COMMENTED' }],
        totalCount: 1,
      },
      comments: { totalCount: 0 },
      mergeable: 'UNKNOWN',
      files: { nodes: [{ path: 'README.md' }] },
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }],
        totalCount: 1,
      },
      isDraft: undefined,
    };

    const { pr, headSha } = mapGraphQLToPRData(node, 'acme', 'app');

    expect(headSha).toBe('');
    expect(pr.author).toBe('unknown');
    expect(pr.authorAssociation).toBe('NONE');
    expect(pr.headRef).toBe('');
    expect(pr.baseRef).toBe('');
    expect(pr.ciStatus).toBe('pending');
    expect(pr.mergeable).toBe('unknown');
    expect(pr.reviewState).toBe('commented');
    expect(pr.requestedReviewers).toEqual([]);
    expect(pr.hasTests).toBe(false);
    expect(pr.hasIssueRef).toBe(true);
    expect(pr.issueNumbers).toEqual([55, 55]);
    expect(pr.ageInDays).toBeGreaterThanOrEqual(0);
  });

  it('maps CHANGES_REQUESTED to changes_requested', () => {
    const node = {
      number: 9,
      title: 'refactor: cleanup',
      body: '',
      createdAt: '2026-02-12T10:00:00.000Z',
      updatedAt: '2026-02-13T10:00:00.000Z',
      author: { login: 'dev' },
      authorAssociation: 'CONTRIBUTOR',
      headRefName: 'refactor',
      baseRefName: 'main',
      headRefOid: 'sha9',
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      reviews: {
        nodes: [{ state: 'CHANGES_REQUESTED' }],
        totalCount: 1,
      },
      comments: { totalCount: 0 },
      mergeable: 'CONFLICTING',
      files: { nodes: [{ path: 'src/a.ts' }] },
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }],
        totalCount: 1,
      },
      labels: { nodes: [] },
      reviewRequests: { nodes: [] },
      isDraft: false,
    };

    const { pr } = mapGraphQLToPRData(node, 'owner', 'repo');

    expect(pr.reviewState).toBe('changes_requested');
    expect(pr.ciStatus).toBe('failure');
    expect(pr.mergeable).toBe('conflicting');
  });
});
