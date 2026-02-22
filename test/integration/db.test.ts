/**
 * Integration tests for TreliqDB
 */

import { TreliqDB } from '../../src/core/db';
import { createScoredPR, createScoredIssue } from '../fixtures/pr-factory';

describe('TreliqDB', () => {
  let db: TreliqDB;

  beforeEach(() => {
    db = new TreliqDB(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('Repository CRUD', () => {
    it('should insert repository and return ID', () => {
      const id = db.upsertRepository('owner', 'repo');
      expect(id).toBeGreaterThan(0);
    });

    it('should return same ID for duplicate repository', () => {
      const id1 = db.upsertRepository('owner', 'repo');
      const id2 = db.upsertRepository('owner', 'repo');
      expect(id1).toBe(id2);
    });

    it('should list all repositories', () => {
      db.upsertRepository('owner1', 'repo1');
      db.upsertRepository('owner2', 'repo2');

      const repos = db.getRepositories();
      expect(repos).toHaveLength(2);
      expect(repos.find(r => r.owner === 'owner1' && r.repo === 'repo1')).toBeDefined();
      expect(repos.find(r => r.owner === 'owner2' && r.repo === 'repo2')).toBeDefined();
    });

    it('should return all repositories', () => {
      const id1 = db.upsertRepository('owner1', 'repo1');
      const id2 = db.upsertRepository('owner2', 'repo2');

      const repos = db.getRepositories();
      expect(repos).toHaveLength(2);
      const ids = repos.map(r => r.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });
  });

  describe('PR CRUD', () => {
    it('should insert PR and retrieve by number', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const pr = createScoredPR({
        number: 1,
        title: 'Test PR',
        signals: [
          { name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' },
          { name: 'diff_size', score: 80, weight: 0.07, reason: '120 lines changed' },
        ],
      });

      db.upsertPR(repoId, pr, 'test-config-hash');

      const retrieved = db.getPRByNumber(repoId, 1);
      expect(retrieved).toBeDefined();
      expect(retrieved?.number).toBe(1);
      expect(retrieved?.title).toBe('Test PR');
      expect(retrieved?.signals).toHaveLength(2);
      expect(retrieved?.signals[0].name).toBe('ci_status');
    });

    it('should update existing PR on upsert', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const pr1 = createScoredPR({
        number: 1,
        title: 'Original Title',
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      });

      db.upsertPR(repoId, pr1, 'hash1');

      const pr2 = createScoredPR({
        number: 1,
        title: 'Updated Title',
        totalScore: 95,
        signals: [{ name: 'ci_status', score: 90, weight: 0.15, reason: 'CI: pending' }],
      });

      db.upsertPR(repoId, pr2, 'hash2');

      const retrieved = db.getPRByNumber(repoId, 1);
      expect(retrieved?.title).toBe('Updated Title');
      expect(retrieved?.totalScore).toBe(95);
      expect(retrieved?.signals[0].reason).toBe('CI: pending');
    });

    it('should store all signal data correctly', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const pr = createScoredPR({
        number: 1,
        signals: [
          { name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' },
          { name: 'diff_size', score: 80, weight: 0.07, reason: '120 lines changed' },
          { name: 'spam', score: 50, weight: 0.12, reason: 'No issue ref' },
        ],
      });

      db.upsertPR(repoId, pr, 'test-hash');

      const retrieved = db.getPRByNumber(repoId, 1);
      expect(retrieved?.signals).toHaveLength(3);

      const ciSignal = retrieved?.signals.find(s => s.name === 'ci_status');
      expect(ciSignal).toBeDefined();
      expect(ciSignal?.score).toBe(100);
      expect(ciSignal?.weight).toBe(0.15);
      expect(ciSignal?.reason).toBe('CI: success');
    });

    it('should return null for non-existent PR', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const retrieved = db.getPRByNumber(repoId, 999);
      expect(retrieved).toBeNull();
    });
  });

  describe('PR listing', () => {
    beforeEach(() => {
      const repoId = db.upsertRepository('owner', 'repo');

      for (let i = 1; i <= 10; i++) {
        const pr = createScoredPR({
          number: i,
          totalScore: 100 - i * 5,
          signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
        });
        db.upsertPR(repoId, pr, 'hash');
      }
    });

    it('should list all PRs without filters', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const prs = db.getPRs(repoId);
      expect(prs).toHaveLength(10);
    });

    it('should respect limit parameter', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const prs = db.getPRs(repoId, { limit: 5 });
      expect(prs).toHaveLength(5);
    });

    it('should respect offset parameter', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const allPrs = db.getPRs(repoId);
      const firstPage = db.getPRs(repoId, { limit: 5 });
      const secondPage = db.getPRs(repoId, { limit: 5, offset: 5 });
      expect(secondPage).toHaveLength(5);
      // Second page should have different PRs than first page
      const firstPageNumbers = new Set(firstPage.map(p => p.number));
      const secondPageNumbers = secondPage.map(p => p.number);
      secondPageNumbers.forEach(n => expect(firstPageNumbers.has(n)).toBe(false));
    });

    it('should filter by state', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      // Update some PRs to closed state
      db.updatePRState(repoId, 1, 'closed');
      db.updatePRState(repoId, 2, 'merged');

      const openPRs = db.getPRs(repoId, { state: 'open' });
      expect(openPRs).toHaveLength(8);

      const closedPRs = db.getPRs(repoId, { state: 'closed' });
      expect(closedPRs).toHaveLength(1);
    });

    it('should sort by total_score DESC by default', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const prs = db.getPRs(repoId);

      // First PR should have highest score
      expect(prs[0].totalScore).toBe(95); // 100 - 1*5
      expect(prs[prs.length - 1].totalScore).toBe(50); // 100 - 10*5
    });
  });

  describe('PR state updates', () => {
    it('should update PR state', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const pr = createScoredPR({
        number: 1,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      });

      db.upsertPR(repoId, pr, 'hash');
      db.updatePRState(repoId, 1, 'closed');

      const retrieved = db.getPRByNumber(repoId, 1);
      expect(retrieved?.number).toBe(1);

      // Verify state is updated by checking state filter
      const closedPRs = db.getPRs(repoId, { state: 'closed' });
      expect(closedPRs).toHaveLength(1);
      expect(closedPRs[0].number).toBe(1);
    });
  });

  describe('Spam PRs', () => {
    it('should return only spam PRs', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      const spamPR = createScoredPR({
        number: 1,
        isSpam: true,
        spamReasons: ['Low quality'],
        signals: [{ name: 'spam', score: 10, weight: 0.12, reason: 'Low quality' }],
      });

      const normalPR = createScoredPR({
        number: 2,
        isSpam: false,
        signals: [{ name: 'spam', score: 100, weight: 0.12, reason: 'No spam signals' }],
      });

      db.upsertPR(repoId, spamPR, 'hash');
      db.upsertPR(repoId, normalPR, 'hash');

      const spamPRs = db.getSpamPRs(repoId);
      expect(spamPRs).toHaveLength(1);
      expect(spamPRs[0].number).toBe(1);
      expect(spamPRs[0].isSpam).toBe(true);
    });

    it('should return empty array when no spam PRs exist', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const normalPR = createScoredPR({
        number: 1,
        isSpam: false,
        signals: [{ name: 'spam', score: 100, weight: 0.12, reason: 'No spam signals' }],
      });

      db.upsertPR(repoId, normalPR, 'hash');

      const spamPRs = db.getSpamPRs(repoId);
      expect(spamPRs).toHaveLength(0);
    });
  });

  describe('Scan history', () => {
    it('should record scan and retrieve history', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      db.recordScan(repoId, 100, 5, 2, 'config-hash-v1');

      const history = db.getScanHistory(repoId);
      expect(history).toHaveLength(1);
      expect(history[0].totalPRs).toBe(100);
      expect(history[0].spamCount).toBe(5);
      expect(history[0].dupClusters).toBe(2);
      expect(history[0].configHash).toBe('config-hash-v1');
    });

    it('should update repository last_scan timestamp', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      db.recordScan(repoId, 50, 0, 0, 'hash');

      const repos = db.getRepositories();
      const repo = repos.find(r => r.id === repoId);
      expect(repo?.lastScan).toBeDefined();
      expect(repo?.lastScan).not.toBeNull();
    });

    it('should store multiple scans', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      db.recordScan(repoId, 100, 5, 2, 'hash1');
      db.recordScan(repoId, 110, 3, 1, 'hash2');
      db.recordScan(repoId, 120, 4, 3, 'hash3');

      const history = db.getScanHistory(repoId);
      expect(history).toHaveLength(3);
      const totalPRs = history.map(h => h.totalPRs);
      expect(totalPRs).toContain(100);
      expect(totalPRs).toContain(110);
      expect(totalPRs).toContain(120);
    });

    it('should respect limit parameter', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      for (let i = 0; i < 20; i++) {
        db.recordScan(repoId, 100 + i, i, i, `hash${i}`);
      }

      const history = db.getScanHistory(repoId, 5);
      expect(history).toHaveLength(5);
    });
  });

  describe('Statistics', () => {
    it('should return correct repository stats', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      // Add mix of PRs
      db.upsertPR(repoId, createScoredPR({
        number: 1,
        totalScore: 90,
        isSpam: false,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      db.upsertPR(repoId, createScoredPR({
        number: 2,
        totalScore: 80,
        isSpam: true,
        signals: [{ name: 'spam', score: 10, weight: 0.12, reason: 'Low quality' }],
      }), 'hash');

      db.upsertPR(repoId, createScoredPR({
        number: 3,
        totalScore: 70,
        isSpam: false,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      db.updatePRState(repoId, 3, 'closed');

      const stats = db.getRepositoryStats(repoId);
      expect(stats.totalPRs).toBe(3);
      expect(stats.openPRs).toBe(2);
      expect(stats.spamPRs).toBe(1);
      expect(stats.avgScore).toBeCloseTo(80, 0); // (90 + 80 + 70) / 3
    });

    it('should handle repository with no PRs', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      const stats = db.getRepositoryStats(repoId);
      expect(stats.totalPRs).toBe(0);
      expect(stats.openPRs).toBe(0);
      expect(stats.spamPRs).toBe(0);
    });

    it('should count duplicate groups correctly', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      db.upsertPR(repoId, createScoredPR({
        number: 1,
        duplicateGroup: 1,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      db.upsertPR(repoId, createScoredPR({
        number: 2,
        duplicateGroup: 1,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      db.upsertPR(repoId, createScoredPR({
        number: 3,
        duplicateGroup: 2,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      const stats = db.getRepositoryStats(repoId);
      expect(stats.duplicateGroups).toBe(2);
    });
  });

  describe('Installation CRUD', () => {
    it('should insert installation', () => {
      db.upsertInstallation(12345, 'Organization', 'test-org');

      const installations = db.getInstallations();
      expect(installations).toHaveLength(1);
      expect(installations[0].id).toBe(12345);
      expect(installations[0].accountType).toBe('Organization');
      expect(installations[0].accountLogin).toBe('test-org');
    });

    it('should update existing installation on upsert', () => {
      db.upsertInstallation(12345, 'Organization', 'test-org');
      db.upsertInstallation(12345, 'User', 'updated-user');

      const installations = db.getInstallations();
      expect(installations).toHaveLength(1);
      expect(installations[0].accountType).toBe('User');
      expect(installations[0].accountLogin).toBe('updated-user');
    });

    it('should delete installation', () => {
      db.upsertInstallation(12345, 'Organization', 'test-org');
      db.deleteInstallation(12345);

      const installations = db.getInstallations();
      expect(installations).toHaveLength(0);
    });

    it('should suspend installation', () => {
      db.upsertInstallation(12345, 'Organization', 'test-org');
      db.suspendInstallation(12345, true);

      const installations = db.getInstallations();
      expect(installations[0].suspendedAt).not.toBeNull();
    });

    it('should unsuspend installation', () => {
      db.upsertInstallation(12345, 'Organization', 'test-org');
      db.suspendInstallation(12345, true);
      db.suspendInstallation(12345, false);

      const installations = db.getInstallations();
      expect(installations[0].suspendedAt).toBeNull();
    });
  });

  describe('Installation repositories', () => {
    it('should link repository to installation', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      db.upsertInstallation(12345, 'Organization', 'test-org');

      db.linkInstallationRepo(12345, repoId);

      const installationId = db.getRepoInstallation('owner', 'repo');
      expect(installationId).toBe(12345);
    });

    it('should unlink repository from installation', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      db.upsertInstallation(12345, 'Organization', 'test-org');

      db.linkInstallationRepo(12345, repoId);
      db.unlinkInstallationRepo(12345, repoId);

      const installationId = db.getRepoInstallation('owner', 'repo');
      expect(installationId).toBeNull();
    });

    it('should return null for unlinked repository', () => {
      db.upsertRepository('owner', 'repo');

      const installationId = db.getRepoInstallation('owner', 'repo');
      expect(installationId).toBeNull();
    });

    it('should handle idempotent link operations', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      db.upsertInstallation(12345, 'Organization', 'test-org');

      db.linkInstallationRepo(12345, repoId);
      db.linkInstallationRepo(12345, repoId); // Duplicate link

      const installationId = db.getRepoInstallation('owner', 'repo');
      expect(installationId).toBe(12345);
    });

    it('should cascade delete installation_repos on installation delete', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      db.upsertInstallation(12345, 'Organization', 'test-org');
      db.linkInstallationRepo(12345, repoId);

      db.deleteInstallation(12345);

      const installationId = db.getRepoInstallation('owner', 'repo');
      expect(installationId).toBeNull();
    });
  });

  describe('Issue CRUD', () => {
    it('should insert issue and retrieve by number', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      const issue = createScoredIssue({
        number: 10,
        title: 'Bug report',
        signals: [
          { name: 'body_quality', score: 80, weight: 0.08, reason: 'Good description' },
        ],
      });

      db.upsertIssue(repoId, issue, 'test-hash');

      const retrieved = db.getIssueByNumber(repoId, 10);
      expect(retrieved).toBeDefined();
      expect(retrieved?.number).toBe(10);
      expect(retrieved?.title).toBe('Bug report');
      expect(retrieved?.signals).toHaveLength(1);
    });

    it('should update existing issue on upsert', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      db.upsertIssue(repoId, createScoredIssue({ number: 10, title: 'Old' }), 'hash');
      db.upsertIssue(repoId, createScoredIssue({ number: 10, title: 'New' }), 'hash');

      const retrieved = db.getIssueByNumber(repoId, 10);
      expect(retrieved?.title).toBe('New');
    });

    it('should list issues with pagination', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      for (let i = 1; i <= 5; i++) {
        db.upsertIssue(repoId, createScoredIssue({ number: i, totalScore: i * 10 }), 'hash');
      }

      const all = db.getIssues(repoId);
      expect(all).toHaveLength(5);

      const page = db.getIssues(repoId, { limit: 2, offset: 0 });
      expect(page).toHaveLength(2);
    });

    it('should filter issues by state', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      db.upsertIssue(repoId, createScoredIssue({ number: 1, state: 'open' }), 'hash');
      db.upsertIssue(repoId, createScoredIssue({ number: 2, state: 'closed' }), 'hash');

      const open = db.getIssues(repoId, { state: 'open' });
      expect(open).toHaveLength(1);
      expect(open[0].number).toBe(1);
    });

    it('should be cleared with clearRepository', () => {
      const repoId = db.upsertRepository('owner', 'repo');
      db.upsertIssue(repoId, createScoredIssue({ number: 10 }), 'hash');

      const result = db.clearRepository(repoId);
      expect(result.deletedIssues).toBe(1);

      const issues = db.getIssues(repoId);
      expect(issues).toHaveLength(0);
    });
  });

  describe('Data management', () => {
    it('should clear all PR data but keep repository', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      db.upsertPR(repoId, createScoredPR({
        number: 1,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      db.upsertPR(repoId, createScoredPR({
        number: 2,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      db.recordScan(repoId, 2, 0, 0, 'hash');

      const result = db.clearRepository(repoId);

      expect(result.deletedPRs).toBe(2);
      expect(result.deletedScans).toBe(1);

      const prs = db.getPRs(repoId);
      expect(prs).toHaveLength(0);

      const repos = db.getRepositories();
      expect(repos).toHaveLength(1);
      expect(repos[0].id).toBe(repoId);
    });

    it('should reset last_scan timestamp on clear', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      db.recordScan(repoId, 10, 0, 0, 'hash');
      db.clearRepository(repoId);

      const repos = db.getRepositories();
      expect(repos[0].lastScan).toBeNull();
    });

    it('should return zero deletions for empty repository', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      const result = db.clearRepository(repoId);
      expect(result.deletedPRs).toBe(0);
      expect(result.deletedScans).toBe(0);
    });
  });

  describe('Duplicate groups', () => {
    it('should return duplicate groups', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      db.upsertPR(repoId, createScoredPR({
        number: 1,
        duplicateGroup: 1,
        totalScore: 90,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      db.upsertPR(repoId, createScoredPR({
        number: 2,
        duplicateGroup: 1,
        totalScore: 80,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      db.upsertPR(repoId, createScoredPR({
        number: 3,
        duplicateGroup: 2,
        totalScore: 70,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      const groups = db.getDuplicateGroups(repoId);
      expect(groups).toHaveLength(2);
      expect(groups[0].duplicateGroup).toBe(1);
      expect(groups[0].prs).toHaveLength(2);
      expect(groups[1].duplicateGroup).toBe(2);
      expect(groups[1].prs).toHaveLength(1);
    });

    it('should sort PRs within duplicate groups by score DESC', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      db.upsertPR(repoId, createScoredPR({
        number: 1,
        duplicateGroup: 1,
        totalScore: 80,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      db.upsertPR(repoId, createScoredPR({
        number: 2,
        duplicateGroup: 1,
        totalScore: 90,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      const groups = db.getDuplicateGroups(repoId);
      expect(groups[0].prs[0].number).toBe(2); // Highest score first
      expect(groups[0].prs[1].number).toBe(1);
    });

    it('should return empty array when no duplicate groups exist', () => {
      const repoId = db.upsertRepository('owner', 'repo');

      db.upsertPR(repoId, createScoredPR({
        number: 1,
        signals: [{ name: 'ci_status', score: 100, weight: 0.15, reason: 'CI: success' }],
      }), 'hash');

      const groups = db.getDuplicateGroups(repoId);
      expect(groups).toHaveLength(0);
    });
  });
});
