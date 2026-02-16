/**
 * VectorStore — LanceDB-backed approximate nearest neighbor (ANN) search
 * for efficient duplicate detection across large PR sets.
 *
 * Replaces O(n²) brute-force cosine similarity with O(n log n) ANN search.
 */

import * as lancedb from '@lancedb/lancedb';

export interface VectorRecord {
  prNumber: number;
  embedding: number[];
}

export interface SimilarResult {
  prNumber: number;
  distance: number;
  similarity: number;
}

export class VectorStore {
  private db: lancedb.Connection | null = null;
  private tableName = 'pr_embeddings';

  async connect(dbPath: string): Promise<void> {
    this.db = await lancedb.connect(dbPath);
  }

  /**
   * Insert or replace embeddings for a batch of PRs.
   * Creates table if it doesn't exist, overwrites if it does.
   */
  async upsertEmbeddings(records: VectorRecord[]): Promise<void> {
    if (!this.db) throw new Error('VectorStore not connected');
    if (records.length === 0) return;

    const data = records.map(r => ({
      pr_number: r.prNumber,
      vector: r.embedding,
    }));

    // Check if table exists
    const tables = await this.db.tableNames();
    if (tables.includes(this.tableName)) {
      await this.db.dropTable(this.tableName);
    }

    await this.db.createTable(this.tableName, data);
  }

  /**
   * Find similar PRs to a given embedding using ANN search.
   * Returns results above the similarity threshold.
   */
  async findSimilar(
    embedding: number[],
    threshold: number,
    limit = 20
  ): Promise<SimilarResult[]> {
    if (!this.db) throw new Error('VectorStore not connected');

    const tables = await this.db.tableNames();
    if (!tables.includes(this.tableName)) return [];

    const table = await this.db.openTable(this.tableName);

    // LanceDB uses L2 distance by default; we search with a generous limit
    // then filter by cosine similarity threshold
    const results = await table
      .vectorSearch(embedding)
      .limit(limit)
      .toArray();

    const similar: SimilarResult[] = [];
    for (const row of results) {
      // LanceDB returns _distance (L2 squared distance)
      // Convert L2 distance to cosine similarity approximation:
      // For normalized vectors: cosine_sim ≈ 1 - (l2_dist² / 2)
      const l2Dist = row._distance ?? 0;
      const cosineSim = 1 - l2Dist / 2;

      if (cosineSim >= threshold) {
        similar.push({
          prNumber: row.pr_number,
          distance: l2Dist,
          similarity: cosineSim,
        });
      }
    }

    return similar;
  }

  /**
   * Find all pairs above threshold — used by DedupEngine.
   * For each PR, finds its nearest neighbors via ANN, returning
   * unique pairs with similarity scores.
   */
  async findAllPairsAboveThreshold(
    records: VectorRecord[],
    threshold: number
  ): Promise<Array<{ a: number; b: number; sim: number }>> {
    if (!this.db) throw new Error('VectorStore not connected');
    if (records.length < 2) return [];

    // Upsert all embeddings first
    await this.upsertEmbeddings(records);

    const table = await this.db.openTable(this.tableName);
    const pairs = new Map<string, { a: number; b: number; sim: number }>();

    for (const record of records) {
      const results = await table
        .vectorSearch(record.embedding)
        .limit(20)
        .toArray();

      for (const row of results) {
        const otherPR = row.pr_number as number;
        if (otherPR === record.prNumber) continue;

        const l2Dist = row._distance ?? 0;
        const cosineSim = 1 - l2Dist / 2;

        if (cosineSim >= threshold) {
          const key = [Math.min(record.prNumber, otherPR), Math.max(record.prNumber, otherPR)].join('-');
          const existing = pairs.get(key);
          if (!existing || cosineSim > existing.sim) {
            pairs.set(key, {
              a: Math.min(record.prNumber, otherPR),
              b: Math.max(record.prNumber, otherPR),
              sim: cosineSim,
            });
          }
        }
      }
    }

    return Array.from(pairs.values());
  }

  async close(): Promise<void> {
    this.db = null;
  }
}
