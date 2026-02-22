/**
 * Test fixture factories for PR data
 */

import type { PRData, ScoredPR, SignalScore, IssueData, ScoredIssue } from '../../src/core/types';

/**
 * Create a PRData object with sensible defaults and optional overrides
 */
export function createPRData(overrides: Partial<PRData> = {}): PRData {
  const defaults: PRData = {
    number: 1,
    title: 'feat: add new feature',
    body: 'This PR adds a new feature that improves the codebase. It includes tests and documentation.',
    author: 'testuser',
    authorAssociation: 'CONTRIBUTOR',
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(), // 3 days ago
    updatedAt: new Date(Date.now() - 86400000 * 1).toISOString(), // 1 day ago
    headRef: 'feature-branch',
    baseRef: 'main',
    filesChanged: 5,
    additions: 100,
    deletions: 20,
    commits: 3,
    labels: [],
    ciStatus: 'success',
    hasIssueRef: true,
    issueNumbers: [42],
    changedFiles: ['src/main.ts', 'src/utils.ts', 'test/main.test.ts'],
    diffUrl: 'https://github.com/owner/repo/pull/1.diff',
    hasTests: true,
    testFilesChanged: ['test/main.test.ts'],
    ageInDays: 3,
    mergeable: 'mergeable',
    reviewState: 'approved',
    reviewCount: 2,
    commentCount: 5,
    isDraft: false,
    milestone: undefined,
    requestedReviewers: ['reviewer1'],
    codeowners: ['testuser'],
  };

  return { ...defaults, ...overrides };
}

/**
 * Create a ScoredPR object with sensible defaults and optional overrides
 */
export function createScoredPR(overrides: Partial<ScoredPR> = {}): ScoredPR {
  const basePR = createPRData(overrides);

  const defaultSignals: SignalScore[] = [
    { name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' },
    { name: 'diff_size', score: 100, weight: 0.07, reason: '120 lines changed (100+/20-)' },
    { name: 'commit_quality', score: 90, weight: 0.04, reason: 'Conventional commit format' },
    { name: 'contributor', score: 70, weight: 0.12, reason: 'testuser (CONTRIBUTOR)' },
    { name: 'issue_ref', score: 90, weight: 0.07, reason: 'References: #42' },
    { name: 'spam', score: 100, weight: 0.12, reason: 'No spam signals' },
    { name: 'test_coverage', score: 90, weight: 0.12, reason: '1 test file(s) changed' },
    { name: 'staleness', score: 100, weight: 0.07, reason: '3d old (Fresh)' },
    { name: 'mergeability', score: 100, weight: 0.12, reason: 'Merge status: mergeable' },
    { name: 'review_status', score: 100, weight: 0.08, reason: 'Review: approved (2 reviews)' },
    { name: 'body_quality', score: 90, weight: 0.04, reason: 'Body: 89 chars' },
    { name: 'activity', score: 90, weight: 0.04, reason: '5 comments' },
    { name: 'breaking_change', score: 80, weight: 0.04, reason: 'No breaking change signals' },
    { name: 'draft_status', score: 90, weight: 0.08, reason: 'Ready for review' },
    { name: 'milestone', score: 40, weight: 0.07, reason: 'No milestone attached' },
    { name: 'label_priority', score: 50, weight: 0.05, reason: 'No priority labels' },
    { name: 'codeowners', score: 95, weight: 0.10, reason: 'Author owns 1 matched pattern(s)' },
    { name: 'requested_reviewers', score: 80, weight: 0.05, reason: '1 reviewer(s): reviewer1' },
  ];

  const defaults: ScoredPR = {
    ...basePR,
    totalScore: 92,
    signals: defaultSignals,
    embedding: undefined,
    visionAlignment: 'unchecked',
    llmScore: undefined,
    llmRisk: undefined,
    llmReason: undefined,
    duplicateGroup: undefined,
    isSpam: false,
    spamReasons: [],
    visionScore: undefined,
    visionReason: undefined,
    intent: overrides.intent,
  };

  const signals = overrides.signals ?? defaultSignals;
  const isSpam = overrides.isSpam ?? (signals.find(s => s.name === 'spam')?.score ?? 100) < 25;

  return {
    ...defaults,
    ...overrides,
    signals,
    isSpam,
  };
}

export function createIssueData(overrides: Partial<IssueData> = {}): IssueData {
  return {
    number: 1,
    title: 'Bug: login fails on Safari',
    body: 'Steps to reproduce:\n1. Open Safari\n2. Click login\n3. Nothing happens',
    author: 'testuser',
    authorAssociation: 'CONTRIBUTOR',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    labels: [],
    commentCount: 0,
    reactionCount: 0,
    state: 'open',
    isLocked: false,
    assignees: [],
    linkedPRs: [],
    ...overrides,
  };
}

export function createScoredIssue(overrides: Partial<ScoredIssue> = {}): ScoredIssue {
  const baseIssue = createIssueData(overrides);

  const defaults: ScoredIssue = {
    ...baseIssue,
    totalScore: 50,
    signals: [],
    isSpam: false,
    spamReasons: [],
  };

  return {
    ...defaults,
    ...overrides,
  };
}
