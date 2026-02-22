import { mapGraphQLToIssueData, ISSUE_DETAILS_QUERY, ISSUE_LIST_QUERY } from '../../src/core/graphql';

describe('Issue GraphQL', () => {
  it('exports ISSUE_DETAILS_QUERY as a string', () => {
    expect(typeof ISSUE_DETAILS_QUERY).toBe('string');
    expect(ISSUE_DETAILS_QUERY).toContain('issues');
  });

  it('exports ISSUE_LIST_QUERY as a string', () => {
    expect(typeof ISSUE_LIST_QUERY).toBe('string');
    expect(ISSUE_LIST_QUERY).toContain('issues');
  });

  it('maps GraphQL issue node to IssueData', () => {
    const node = {
      number: 42,
      title: 'Bug: login fails',
      body: 'Steps to reproduce...',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      author: { login: 'alice' },
      authorAssociation: 'MEMBER',
      labels: { nodes: [{ name: 'bug' }] },
      milestone: { title: 'v1.0' },
      comments: { totalCount: 3 },
      reactions: { totalCount: 5 },
      state: 'OPEN',
      stateReason: null,
      locked: false,
      assignees: { nodes: [{ login: 'bob' }] },
    };

    const issue = mapGraphQLToIssueData(node);
    expect(issue.number).toBe(42);
    expect(issue.title).toBe('Bug: login fails');
    expect(issue.author).toBe('alice');
    expect(issue.labels).toEqual(['bug']);
    expect(issue.milestone).toBe('v1.0');
    expect(issue.commentCount).toBe(3);
    expect(issue.reactionCount).toBe(5);
    expect(issue.state).toBe('open');
    expect(issue.assignees).toEqual(['bob']);
    expect(issue.linkedPRs).toEqual([]);
  });

  it('handles null fields gracefully', () => {
    const node = {
      number: 1,
      title: 'Test',
      body: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      author: null,
      authorAssociation: 'NONE',
      labels: { nodes: [] },
      milestone: null,
      comments: { totalCount: 0 },
      reactions: { totalCount: 0 },
      state: 'OPEN',
      stateReason: null,
      locked: false,
      assignees: { nodes: [] },
    };

    const issue = mapGraphQLToIssueData(node);
    expect(issue.body).toBe('');
    expect(issue.author).toBe('unknown');
    expect(issue.milestone).toBeUndefined();
  });

  it('maps closed issue state and stateReason', () => {
    const node = {
      number: 2,
      title: 'Closed issue',
      body: 'Done',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      author: { login: 'dev' },
      authorAssociation: 'CONTRIBUTOR',
      labels: { nodes: [] },
      milestone: null,
      comments: { totalCount: 0 },
      reactions: { totalCount: 0 },
      state: 'CLOSED',
      stateReason: 'completed',
      locked: true,
      assignees: { nodes: [] },
    };

    const issue = mapGraphQLToIssueData(node);
    expect(issue.state).toBe('closed');
    expect(issue.stateReason).toBe('completed');
    expect(issue.isLocked).toBe(true);
  });
});
