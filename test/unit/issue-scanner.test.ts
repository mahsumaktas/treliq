const mockGraphqlClient = jest.fn();
const mockGraphqlDefaults = jest.fn(() => mockGraphqlClient);

const mockOctokitInstance = {
  issues: {
    listForRepo: jest.fn(),
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

import { IssueScanner } from '../../src/core/issue-scanner';
import { createIssueData, createScoredPR } from '../fixtures/pr-factory';

// We test the linkPRsToIssues method and the scoring integration.
// GraphQL/REST fetch methods need real API calls so we test them via mocking.

describe('IssueScanner', () => {
  beforeEach(() => {
    mockGraphqlDefaults.mockClear();
    mockGraphqlClient.mockReset();
    mockOctokitInstance.issues.listForRepo.mockReset();
  });

  describe('linkPRsToIssues', () => {
    it('links PRs to issues via issueNumbers', () => {
      const scanner = new IssueScanner({ repo: 'owner/repo', token: 'test' });
      const issues = [
        createIssueData({ number: 10 }),
        createIssueData({ number: 20 }),
        createIssueData({ number: 30 }),
      ];
      const prs = [
        createScoredPR({ number: 42, issueNumbers: [10, 20] }),
        createScoredPR({ number: 43, issueNumbers: [10] }),
      ];

      scanner.linkPRsToIssues(issues, prs);

      expect(issues[0].linkedPRs).toEqual([42, 43]);
      expect(issues[1].linkedPRs).toEqual([42]);
      expect(issues[2].linkedPRs).toEqual([]);
    });

    it('does not duplicate PR links', () => {
      const scanner = new IssueScanner({ repo: 'owner/repo', token: 'test' });
      const issues = [createIssueData({ number: 10, linkedPRs: [42] })];
      const prs = [createScoredPR({ number: 42, issueNumbers: [10] })];

      scanner.linkPRsToIssues(issues, prs);
      expect(issues[0].linkedPRs).toEqual([42]); // no duplicate
    });

    it('handles empty arrays', () => {
      const scanner = new IssueScanner({ repo: 'owner/repo', token: 'test' });
      scanner.linkPRsToIssues([], []);
      // no error
    });

    it('handles PRs referencing non-existent issues', () => {
      const scanner = new IssueScanner({ repo: 'owner/repo', token: 'test' });
      const issues = [createIssueData({ number: 10 })];
      const prs = [createScoredPR({ number: 42, issueNumbers: [999] })];

      scanner.linkPRsToIssues(issues, prs);
      expect(issues[0].linkedPRs).toEqual([]);
    });
  });

  describe('constructor', () => {
    it('creates scanner with minimal config', () => {
      const scanner = new IssueScanner({ repo: 'owner/repo', token: 'test' });
      expect(scanner).toBeDefined();
    });

    it('accepts maxIssues and provider', () => {
      const scanner = new IssueScanner({ repo: 'owner/repo', token: 'test', maxIssues: 100 });
      expect(scanner).toBeDefined();
    });
  });
});
