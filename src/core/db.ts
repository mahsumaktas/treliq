/**
 * TreliqDB - SQLite persistence layer for PR scan results
 *
 * Stores repositories, pull requests, scoring signals, and scan history
 * with full transaction support and optimized indexes.
 */

import Database from 'better-sqlite3';
import type { ScoredPR, SignalScore } from './types';

export interface Repository {
  id: number;
  owner: string;
  repo: string;
  createdAt: string;
  lastScan: string | null;
}

export interface ScanHistoryEntry {
  scannedAt: string;
  totalPRs: number;
  spamCount: number;
  dupClusters: number;
  configHash: string;
}

export interface GetPRsOptions {
  state?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
}

export class TreliqDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  /**
   * Initialize database schema with tables and indexes
   */
  private initSchema(): void {
    // Repositories table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repositories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_scan TEXT,
        UNIQUE(owner, repo)
      );
    `);

    // Pull requests table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pull_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL,
        pr_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        author_association TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        files_changed INTEGER NOT NULL,
        additions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        commits INTEGER NOT NULL,
        labels TEXT NOT NULL,
        ci_status TEXT NOT NULL,
        has_issue_ref INTEGER NOT NULL,
        issue_numbers TEXT NOT NULL,
        changed_files TEXT NOT NULL,
        diff_url TEXT NOT NULL,
        has_tests INTEGER NOT NULL,
        test_files_changed TEXT NOT NULL,
        age_in_days INTEGER NOT NULL,
        mergeable TEXT NOT NULL,
        review_state TEXT NOT NULL,
        review_count INTEGER NOT NULL,
        comment_count INTEGER NOT NULL,
        is_draft INTEGER NOT NULL,
        milestone TEXT,
        requested_reviewers TEXT NOT NULL,
        codeowners TEXT NOT NULL,
        total_score REAL NOT NULL,
        embedding TEXT,
        vision_alignment TEXT,
        vision_score REAL,
        vision_reason TEXT,
        llm_score REAL,
        llm_risk TEXT,
        llm_reason TEXT,
        duplicate_group INTEGER,
        is_spam INTEGER NOT NULL,
        spam_reasons TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        config_hash TEXT NOT NULL,
        stored_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
        UNIQUE(repo_id, pr_number)
      );
    `);

    // Scoring signals table (normalized for detailed queries)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scoring_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        score REAL NOT NULL,
        weight REAL NOT NULL,
        reason TEXT NOT NULL,
        FOREIGN KEY (pr_id) REFERENCES pull_requests(id) ON DELETE CASCADE
      );
    `);

    // Scan history table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL,
        scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
        total_prs INTEGER NOT NULL,
        spam_count INTEGER NOT NULL,
        dup_clusters INTEGER NOT NULL,
        config_hash TEXT NOT NULL,
        FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
      );
    `);

    // Create indexes for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_prs_repo_number ON pull_requests(repo_id, pr_number);
      CREATE INDEX IF NOT EXISTS idx_prs_state ON pull_requests(state);
      CREATE INDEX IF NOT EXISTS idx_prs_score ON pull_requests(total_score DESC);
      CREATE INDEX IF NOT EXISTS idx_prs_is_spam ON pull_requests(is_spam);
      CREATE INDEX IF NOT EXISTS idx_prs_duplicate_group ON pull_requests(duplicate_group);
      CREATE INDEX IF NOT EXISTS idx_signals_pr ON scoring_signals(pr_id);
      CREATE INDEX IF NOT EXISTS idx_scan_history_repo ON scan_history(repo_id, scanned_at DESC);
    `);
  }

  // ========== Repository Operations ==========

  /**
   * Insert or update a repository and return its ID
   */
  upsertRepository(owner: string, repo: string): number {
    const stmt = this.db.prepare(`
      INSERT INTO repositories (owner, repo)
      VALUES (?, ?)
      ON CONFLICT(owner, repo) DO UPDATE SET last_scan = last_scan
      RETURNING id
    `);
    const result = stmt.get(owner, repo) as { id: number };
    return result.id;
  }

  /**
   * Get all repositories
   */
  getRepositories(): Array<{ id: number; owner: string; repo: string; lastScan: string | null }> {
    const stmt = this.db.prepare(`
      SELECT id, owner, repo, last_scan as lastScan
      FROM repositories
      ORDER BY created_at DESC
    `);
    return stmt.all() as Array<{ id: number; owner: string; repo: string; lastScan: string | null }>;
  }

  // ========== Pull Request Operations ==========

  /**
   * Insert or update a pull request with its scoring signals
   * Uses transaction to ensure atomicity
   */
  upsertPR(repoId: number, pr: ScoredPR, configHash: string): number {
    const upsert = this.db.transaction((repoId: number, pr: ScoredPR, configHash: string) => {
      // Upsert PR
      const prStmt = this.db.prepare(`
        INSERT INTO pull_requests (
          repo_id, pr_number, title, body, author, author_association,
          created_at, updated_at, head_ref, base_ref,
          files_changed, additions, deletions, commits,
          labels, ci_status, has_issue_ref, issue_numbers,
          changed_files, diff_url, has_tests, test_files_changed,
          age_in_days, mergeable, review_state, review_count,
          comment_count, is_draft, milestone, requested_reviewers,
          codeowners, total_score, embedding, vision_alignment,
          vision_score, vision_reason, llm_score, llm_risk,
          llm_reason, duplicate_group, is_spam, spam_reasons,
          config_hash
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?
        )
        ON CONFLICT(repo_id, pr_number) DO UPDATE SET
          title = excluded.title,
          body = excluded.body,
          updated_at = excluded.updated_at,
          files_changed = excluded.files_changed,
          additions = excluded.additions,
          deletions = excluded.deletions,
          commits = excluded.commits,
          labels = excluded.labels,
          ci_status = excluded.ci_status,
          has_issue_ref = excluded.has_issue_ref,
          issue_numbers = excluded.issue_numbers,
          changed_files = excluded.changed_files,
          has_tests = excluded.has_tests,
          test_files_changed = excluded.test_files_changed,
          age_in_days = excluded.age_in_days,
          mergeable = excluded.mergeable,
          review_state = excluded.review_state,
          review_count = excluded.review_count,
          comment_count = excluded.comment_count,
          is_draft = excluded.is_draft,
          milestone = excluded.milestone,
          requested_reviewers = excluded.requested_reviewers,
          codeowners = excluded.codeowners,
          total_score = excluded.total_score,
          embedding = excluded.embedding,
          vision_alignment = excluded.vision_alignment,
          vision_score = excluded.vision_score,
          vision_reason = excluded.vision_reason,
          llm_score = excluded.llm_score,
          llm_risk = excluded.llm_risk,
          llm_reason = excluded.llm_reason,
          duplicate_group = excluded.duplicate_group,
          is_spam = excluded.is_spam,
          spam_reasons = excluded.spam_reasons,
          config_hash = excluded.config_hash,
          stored_at = datetime('now')
        RETURNING id
      `);

      const prResult = prStmt.get(
        repoId,
        pr.number,
        pr.title,
        pr.body,
        pr.author,
        pr.authorAssociation,
        pr.createdAt,
        pr.updatedAt,
        pr.headRef,
        pr.baseRef,
        pr.filesChanged,
        pr.additions,
        pr.deletions,
        pr.commits,
        JSON.stringify(pr.labels),
        pr.ciStatus,
        pr.hasIssueRef ? 1 : 0,
        JSON.stringify(pr.issueNumbers),
        JSON.stringify(pr.changedFiles),
        pr.diffUrl,
        pr.hasTests ? 1 : 0,
        JSON.stringify(pr.testFilesChanged),
        pr.ageInDays,
        pr.mergeable,
        pr.reviewState,
        pr.reviewCount,
        pr.commentCount,
        pr.isDraft ? 1 : 0,
        pr.milestone || null,
        JSON.stringify(pr.requestedReviewers),
        JSON.stringify(pr.codeowners),
        pr.totalScore,
        pr.embedding ? JSON.stringify(pr.embedding) : null,
        pr.visionAlignment || null,
        pr.visionScore ?? null,
        pr.visionReason || null,
        pr.llmScore ?? null,
        pr.llmRisk || null,
        pr.llmReason || null,
        pr.duplicateGroup ?? null,
        pr.isSpam ? 1 : 0,
        JSON.stringify(pr.spamReasons),
        configHash
      ) as { id: number };

      const prId = prResult.id;

      // Delete old signals and insert new ones
      const deleteSignals = this.db.prepare('DELETE FROM scoring_signals WHERE pr_id = ?');
      deleteSignals.run(prId);

      const insertSignal = this.db.prepare(`
        INSERT INTO scoring_signals (pr_id, name, score, weight, reason)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const signal of pr.signals) {
        insertSignal.run(prId, signal.name, signal.score, signal.weight, signal.reason);
      }

      return prId;
    });

    return upsert(repoId, pr, configHash);
  }

  /**
   * Get pull requests with optional filtering, sorting, and pagination
   */
  getPRs(repoId: number, opts: GetPRsOptions = {}): ScoredPR[] {
    const { state, limit, offset = 0, sortBy = 'total_score DESC' } = opts;

    let sql = `
      SELECT * FROM pull_requests
      WHERE repo_id = ?
    `;

    const params: any[] = [repoId];

    if (state) {
      sql += ' AND state = ?';
      params.push(state);
    }

    sql += ` ORDER BY ${sortBy}`;

    if (limit) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params);

    return rows.map((row: any) => this.rowToPR(row));
  }

  /**
   * Get spam PRs for a repository
   */
  getSpamPRs(repoId: number): ScoredPR[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pull_requests
      WHERE repo_id = ? AND is_spam = 1
      ORDER BY total_score DESC
    `);
    const rows = stmt.all(repoId);
    return rows.map((row: any) => this.rowToPR(row));
  }

  /**
   * Get a single PR by number
   */
  getPRByNumber(repoId: number, prNumber: number): ScoredPR | null {
    const stmt = this.db.prepare(`
      SELECT * FROM pull_requests
      WHERE repo_id = ? AND pr_number = ?
    `);
    const row = stmt.get(repoId, prNumber);
    return row ? this.rowToPR(row as any) : null;
  }

  /**
   * Update PR state (e.g., 'open', 'closed', 'merged')
   */
  updatePRState(repoId: number, prNumber: number, state: string): void {
    const stmt = this.db.prepare(`
      UPDATE pull_requests
      SET state = ?, updated_at = datetime('now')
      WHERE repo_id = ? AND pr_number = ?
    `);
    stmt.run(state, repoId, prNumber);
  }

  /**
   * Get signals for a specific PR
   */
  private getSignalsForPR(prId: number): SignalScore[] {
    const stmt = this.db.prepare(`
      SELECT name, score, weight, reason
      FROM scoring_signals
      WHERE pr_id = ?
      ORDER BY weight DESC
    `);
    return stmt.all(prId) as SignalScore[];
  }

  /**
   * Convert database row to ScoredPR object
   */
  private rowToPR(row: any): ScoredPR {
    // Get signals for this PR
    const signals = this.getSignalsForPR(row.id);

    return {
      number: row.pr_number,
      title: row.title,
      body: row.body,
      author: row.author,
      authorAssociation: row.author_association,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      headRef: row.head_ref,
      baseRef: row.base_ref,
      filesChanged: row.files_changed,
      additions: row.additions,
      deletions: row.deletions,
      commits: row.commits,
      labels: JSON.parse(row.labels),
      ciStatus: row.ci_status,
      hasIssueRef: Boolean(row.has_issue_ref),
      issueNumbers: JSON.parse(row.issue_numbers),
      changedFiles: JSON.parse(row.changed_files),
      diffUrl: row.diff_url,
      hasTests: Boolean(row.has_tests),
      testFilesChanged: JSON.parse(row.test_files_changed),
      ageInDays: row.age_in_days,
      mergeable: row.mergeable,
      reviewState: row.review_state,
      reviewCount: row.review_count,
      commentCount: row.comment_count,
      isDraft: Boolean(row.is_draft),
      milestone: row.milestone,
      requestedReviewers: JSON.parse(row.requested_reviewers),
      codeowners: JSON.parse(row.codeowners),
      totalScore: row.total_score,
      signals,
      embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
      visionAlignment: row.vision_alignment || undefined,
      visionScore: row.vision_score ?? undefined,
      visionReason: row.vision_reason || undefined,
      llmScore: row.llm_score ?? undefined,
      llmRisk: row.llm_risk || undefined,
      llmReason: row.llm_reason || undefined,
      duplicateGroup: row.duplicate_group ?? undefined,
      isSpam: Boolean(row.is_spam),
      spamReasons: JSON.parse(row.spam_reasons),
    };
  }

  // ========== Scan History Operations ==========

  /**
   * Record a scan in history and update repository last_scan timestamp
   */
  recordScan(repoId: number, totalPRs: number, spamCount: number, dupClusters: number, configHash: string): void {
    const recordScan = this.db.transaction((repoId: number, totalPRs: number, spamCount: number, dupClusters: number, configHash: string) => {
      // Insert scan history
      const historyStmt = this.db.prepare(`
        INSERT INTO scan_history (repo_id, total_prs, spam_count, dup_clusters, config_hash)
        VALUES (?, ?, ?, ?, ?)
      `);
      historyStmt.run(repoId, totalPRs, spamCount, dupClusters, configHash);

      // Update repository last_scan
      const updateStmt = this.db.prepare(`
        UPDATE repositories
        SET last_scan = datetime('now')
        WHERE id = ?
      `);
      updateStmt.run(repoId);
    });

    recordScan(repoId, totalPRs, spamCount, dupClusters, configHash);
  }

  /**
   * Get scan history for a repository
   */
  getScanHistory(repoId: number, limit: number = 10): ScanHistoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT scanned_at as scannedAt, total_prs as totalPRs, spam_count as spamCount,
             dup_clusters as dupClusters, config_hash as configHash
      FROM scan_history
      WHERE repo_id = ?
      ORDER BY scanned_at DESC
      LIMIT ?
    `);
    return stmt.all(repoId, limit) as ScanHistoryEntry[];
  }

  // ========== Analytics & Queries ==========

  /**
   * Get duplicate PR groups for a repository
   */
  getDuplicateGroups(repoId: number): Array<{ duplicateGroup: number; prs: ScoredPR[] }> {
    const stmt = this.db.prepare(`
      SELECT DISTINCT duplicate_group
      FROM pull_requests
      WHERE repo_id = ? AND duplicate_group IS NOT NULL
      ORDER BY duplicate_group
    `);
    const groups = stmt.all(repoId) as Array<{ duplicate_group: number }>;

    return groups.map(({ duplicate_group }) => ({
      duplicateGroup: duplicate_group,
      prs: this.getPRsByDuplicateGroup(repoId, duplicate_group),
    }));
  }

  /**
   * Get PRs in a specific duplicate group
   */
  private getPRsByDuplicateGroup(repoId: number, duplicateGroup: number): ScoredPR[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pull_requests
      WHERE repo_id = ? AND duplicate_group = ?
      ORDER BY total_score DESC
    `);
    const rows = stmt.all(repoId, duplicateGroup);
    return rows.map((row: any) => this.rowToPR(row));
  }

  /**
   * Get statistics for a repository
   */
  getRepositoryStats(repoId: number): {
    totalPRs: number;
    openPRs: number;
    spamPRs: number;
    duplicateGroups: number;
    avgScore: number;
  } {
    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as totalPRs,
        COUNT(CASE WHEN state = 'open' THEN 1 END) as openPRs,
        COUNT(CASE WHEN is_spam = 1 THEN 1 END) as spamPRs,
        COUNT(DISTINCT duplicate_group) as duplicateGroups,
        AVG(total_score) as avgScore
      FROM pull_requests
      WHERE repo_id = ?
    `);
    return stmt.get(repoId) as {
      totalPRs: number;
      openPRs: number;
      spamPRs: number;
      duplicateGroups: number;
      avgScore: number;
    };
  }

  // ========== Data Management ==========

  /**
   * Clear all PR data, scoring signals, and scan history for a repository
   * Repository entry itself is preserved
   */
  clearRepository(repoId: number): { deletedPRs: number; deletedScans: number } {
    const clear = this.db.transaction((repoId: number) => {
      // Delete scoring signals for all PRs in this repo
      this.db.prepare(`
        DELETE FROM scoring_signals
        WHERE pr_id IN (SELECT id FROM pull_requests WHERE repo_id = ?)
      `).run(repoId);

      // Delete pull requests
      const prResult = this.db.prepare('DELETE FROM pull_requests WHERE repo_id = ?').run(repoId);

      // Delete scan history
      const scanResult = this.db.prepare('DELETE FROM scan_history WHERE repo_id = ?').run(repoId);

      // Reset last_scan timestamp
      this.db.prepare('UPDATE repositories SET last_scan = NULL WHERE id = ?').run(repoId);

      return {
        deletedPRs: prResult.changes,
        deletedScans: scanResult.changes,
      };
    });

    return clear(repoId);
  }

  // ========== Lifecycle ==========

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Optimize database (VACUUM and ANALYZE)
   */
  optimize(): void {
    this.db.exec('VACUUM');
    this.db.exec('ANALYZE');
  }

  /**
   * Get database size in bytes
   */
  getDatabaseSize(): number {
    const stmt = this.db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()");
    const result = stmt.get() as { size: number };
    return result.size;
  }
}
