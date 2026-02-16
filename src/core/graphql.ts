/**
 * GitHub GraphQL queries and response mappers for Treliq.
 *
 * Replaces multiple REST API calls with single GraphQL queries,
 * reducing API call count by ~80% per scan.
 */

import type { PRData } from './types';

// ─── Issue Reference Patterns (shared with scanner) ───

const ISSUE_REF_PATTERN = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|related\s+to|addresses|refs?)\s+#(\d+)/gi;
const LOOSE_ISSUE_REF = /#(\d+)/g;

function extractIssueNumbers(text: string): number[] {
  const issueNumbers: number[] = [];
  for (const match of text.matchAll(ISSUE_REF_PATTERN)) {
    issueNumbers.push(parseInt(match[1], 10));
  }
  if (issueNumbers.length === 0) {
    for (const match of text.matchAll(LOOSE_ISSUE_REF)) {
      const num = parseInt(match[1], 10);
      if (num > 0 && num < 100000) issueNumbers.push(num);
    }
  }
  return issueNumbers;
}

const TEST_PATTERNS = [/test\//, /spec\//, /__test__/, /__tests__/, /\.test\./, /\.spec\./, /_test\.go$/, /Test\.java$/];

// ─── GraphQL Queries ───

/**
 * Lightweight PR list query — for cache comparison only.
 * Fetches number, updatedAt, headSha for each open PR.
 */
export const PR_LIST_QUERY = `
  query($owner: String!, $repo: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: $first, after: $after, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          updatedAt
          headRefOid
        }
      }
    }
  }
`;

/**
 * Full PR details query — fetches all fields needed for scoring in one call.
 * Replaces: pulls.get + pulls.listFiles + checks.listForRef + pulls.listReviews
 */
export const PR_DETAILS_QUERY = `
  query($owner: String!, $repo: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: $first, after: $after, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          body
          isDraft
          createdAt
          updatedAt
          author { login }
          authorAssociation
          headRefName
          baseRefName
          headRefOid
          additions
          deletions
          changedFiles
          milestone { title }
          labels(first: 50) { nodes { name } }
          requestedReviewers(first: 20) {
            nodes {
              ... on User { login }
              ... on Team { name }
            }
          }
          reviews(last: 50) {
            nodes { state }
            totalCount
          }
          comments { totalCount }
          mergeable
          files(first: 100) { nodes { path } }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                }
              }
            }
            totalCount
          }
        }
      }
    }
  }
`;

/**
 * Single PR detail query — for webhook scoring and `score` command.
 */
export const SINGLE_PR_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        body
        isDraft
        createdAt
        updatedAt
        author { login }
        authorAssociation
        headRefName
        baseRefName
        headRefOid
        additions
        deletions
        changedFiles
        milestone { title }
        labels(first: 50) { nodes { name } }
        requestedReviewers(first: 20) {
          nodes {
            ... on User { login }
            ... on Team { name }
          }
        }
        reviews(last: 50) {
          nodes { state }
          totalCount
        }
        comments { totalCount }
        mergeable
        files(first: 100) { nodes { path } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
              }
            }
          }
          totalCount
        }
      }
    }
  }
`;

// ─── GraphQL Mergeable Enum → PRData Mapping ───

const GRAPHQL_MERGEABLE_MAP: Record<string, PRData['mergeable']> = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
  UNKNOWN: 'unknown',
};

// ─── CI Status Mapping ───

const GRAPHQL_CI_MAP: Record<string, PRData['ciStatus']> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  EXPECTED: 'success',
  PENDING: 'pending',
};

// ─── Response Mapper ───

/**
 * Maps a GraphQL PR node to the PRData interface.
 * Handles all field transformations and client-side computed fields.
 */
export function mapGraphQLToPRData(node: any, owner: string, repo: string): { pr: PRData; headSha: string } {
  // Changed files list
  const changedFiles: string[] = (node.files?.nodes ?? []).map((f: any) => f.path);

  // CI status from statusCheckRollup
  let ciStatus: PRData['ciStatus'] = 'unknown';
  const lastCommit = node.commits?.nodes?.[0];
  if (lastCommit?.commit?.statusCheckRollup?.state) {
    ciStatus = GRAPHQL_CI_MAP[lastCommit.commit.statusCheckRollup.state] ?? 'unknown';
  }

  // Review state
  let reviewState: PRData['reviewState'] = 'none';
  const reviews = node.reviews?.nodes ?? [];
  const reviewStates = reviews.map((r: any) => r.state);
  if (reviewStates.includes('APPROVED')) reviewState = 'approved';
  else if (reviewStates.includes('CHANGES_REQUESTED')) reviewState = 'changes_requested';
  else if (reviewStates.some((s: string) => s === 'COMMENTED')) reviewState = 'commented';

  // Labels
  const labels: string[] = (node.labels?.nodes ?? []).map((l: any) => l.name);

  // Requested reviewers
  const requestedReviewers: string[] = (node.requestedReviewers?.nodes ?? [])
    .map((r: any) => r.login ?? r.name ?? '')
    .filter(Boolean);

  // Test detection
  const testFilesChanged = changedFiles.filter(f => TEST_PATTERNS.some(p => p.test(f)));
  const hasTests = testFilesChanged.length > 0;

  // Age
  const ageInDays = Math.floor((Date.now() - new Date(node.createdAt).getTime()) / (1000 * 60 * 60 * 24));

  // Issue references
  const text = `${node.title} ${node.body ?? ''}`;
  const issueNumbers = extractIssueNumbers(text);

  // Mergeable
  const mergeable = GRAPHQL_MERGEABLE_MAP[node.mergeable] ?? 'unknown';

  const headSha = node.headRefOid ?? '';

  const pr: PRData = {
    number: node.number,
    title: node.title,
    body: node.body ?? '',
    author: node.author?.login ?? 'unknown',
    authorAssociation: node.authorAssociation ?? 'NONE',
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    headRef: node.headRefName ?? '',
    baseRef: node.baseRefName ?? '',
    filesChanged: node.changedFiles ?? 0,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    commits: node.commits?.totalCount ?? 0,
    labels,
    ciStatus,
    hasIssueRef: issueNumbers.length > 0,
    issueNumbers,
    changedFiles,
    diffUrl: `https://github.com/${owner}/${repo}/pull/${node.number}.diff`,
    hasTests,
    testFilesChanged,
    ageInDays,
    mergeable,
    reviewState,
    reviewCount: node.reviews?.totalCount ?? 0,
    commentCount: node.comments?.totalCount ?? 0,
    isDraft: node.isDraft ?? false,
    milestone: node.milestone?.title ?? undefined,
    requestedReviewers,
    codeowners: [], // Filled separately via CODEOWNERS file
  };

  return { pr, headSha };
}
