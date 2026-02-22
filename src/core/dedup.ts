/**
 * DedupEngine — Semantic duplicate detection for PRs using embeddings
 * Supports both brute-force O(n²) and LanceDB ANN O(n log n) modes.
 */

import type { DedupCluster, TriageItem } from './types';
import type { LLMProvider } from './provider';
import { VectorStore, type VectorRecord } from './vectorstore';
import { ConcurrencyController } from './concurrency';
import { createLogger } from './logger';

const log = createLogger('dedup');

export class DedupEngine {
  private duplicateThreshold: number;
  private relatedThreshold: number;
  private provider: LLMProvider;
  private vectorStore?: VectorStore;

  constructor(
    duplicateThreshold = 0.85,
    relatedThreshold = 0.80,
    provider: LLMProvider,
    vectorStorePath?: string
  ) {
    this.duplicateThreshold = duplicateThreshold;
    this.relatedThreshold = relatedThreshold;
    this.provider = provider;

    if (vectorStorePath) {
      this.vectorStore = new VectorStore();
      this.vectorStore.connect(vectorStorePath).catch(err => {
        log.warn({ err }, 'Failed to connect VectorStore');
        this.vectorStore = undefined;
      });
    }
  }

  async findDuplicates(items: TriageItem[], cc?: ConcurrencyController): Promise<DedupCluster[]> {
    if (items.length < 2) return [];

    // 1. Embed all items — batch first, parallel individual fallback
    log.info({ count: items.length }, 'Embedding items');
    const embeddings: Map<number, number[]> = new Map();

    const hasBatch = typeof (this.provider as any).generateEmbeddingBatch === 'function';
    let batchDone = false;

    if (hasBatch) {
      log.info({ count: items.length }, 'Using batch embedding');
      const BATCH_SIZE = 100;
      try {
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE);
          const texts = batch.map(item => this.itemToText(item));
          const results = await (this.provider as any).generateEmbeddingBatch(texts);
          for (let j = 0; j < batch.length; j++) {
            batch[j].embedding = results[j];
            embeddings.set(batch[j].number, results[j]);
          }
        }
        batchDone = true;
      } catch (err: any) {
        log.warn({ err }, 'Batch embedding failed, falling back to parallel individual');
      }
    }

    // For items without embedding (batch failed or no batch support): parallel individual
    // If an external ConcurrencyController is provided, use it (enables adaptive throttling)
    if (!batchDone) {
      const remaining = items.filter(p => !p.embedding);
      if (remaining.length > 0) {
        log.info({ count: remaining.length }, 'Embedding items individually (parallel)');
        const controller = cc ?? new ConcurrencyController(15, 2, 500);
        const results = await Promise.allSettled(
          remaining.map(item => controller.execute(async () => {
            const text = this.itemToText(item);
            const embedding = await this.embed(text);
            item.embedding = embedding;
            embeddings.set(item.number, embedding);
          }))
        );
        let failed = 0;
        for (const r of results) {
          if (r.status === 'rejected') failed++;
        }
        if (failed > 0) log.warn({ failed }, 'Some embeddings failed');
      }
    }

    // 2. Find similar pairs — use VectorStore (ANN) or brute-force
    const embeddedItems = items.filter(p => p.embedding);
    let pairs: Array<{ a: number; b: number; sim: number }>;

    if (this.vectorStore && embeddedItems.length > 50) {
      // Use LanceDB ANN for large sets (>50 items)
      log.info({ count: embeddedItems.length }, 'Using LanceDB ANN search');
      const records: VectorRecord[] = embeddedItems.map(item => ({
        prNumber: item.number,
        embedding: item.embedding!,
      }));
      pairs = await this.vectorStore.findAllPairsAboveThreshold(records, this.relatedThreshold);
    } else {
      // Brute-force cosine similarity for small sets
      pairs = [];
      for (let i = 0; i < embeddedItems.length; i++) {
        for (let j = i + 1; j < embeddedItems.length; j++) {
          const sim = this.cosineSimilarity(embeddedItems[i].embedding!, embeddedItems[j].embedding!);
          if (sim >= this.relatedThreshold) {
            pairs.push({ a: embeddedItems[i].number, b: embeddedItems[j].number, sim });
          }
        }
      }
    }

    // 3. Cluster via union-find
    const itemMap = new Map(items.map(p => [p.number, p]));
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      if (!parent.has(x)) parent.set(x, x);
      if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
      return parent.get(x)!;
    };
    const union = (a: number, b: number) => {
      parent.set(find(a), find(b));
    };

    for (const { a, b } of pairs) {
      union(a, b);
    }

    // Group by root
    const groups = new Map<number, number[]>();
    for (const { a, b } of pairs) {
      const root = find(a);
      if (!groups.has(root)) groups.set(root, []);
      const g = groups.get(root)!;
      if (!g.includes(a)) g.push(a);
      if (!g.includes(b)) g.push(b);
    }

    // 4. Build clusters
    const clusters: DedupCluster[] = [];
    let id = 0;
    for (const [, members] of groups) {
      if (members.length < 2) continue;
      const clusterItems = members.map(n => itemMap.get(n)!).filter(Boolean);
      const bestItem = clusterItems.reduce((a, b) => a.totalScore >= b.totalScore ? a : b);

      // Avg similarity
      let simSum = 0;
      let simCount = 0;
      for (const p of pairs) {
        if (members.includes(p.a) && members.includes(p.b)) {
          simSum += p.sim;
          simCount++;
        }
      }

      // Determine cluster type
      const hasPR = clusterItems.some(i => 'changedFiles' in i);
      const hasIssue = clusterItems.some(i => !('changedFiles' in i));
      const type: 'pr' | 'issue' | 'mixed' = hasPR && hasIssue ? 'mixed' : hasPR ? 'pr' : 'issue';

      // Mark duplicate group on items
      for (const item of clusterItems) {
        item.duplicateGroup = id;
      }

      clusters.push({
        id: id++,
        prs: clusterItems,
        bestPR: bestItem.number,
        similarity: simCount > 0 ? simSum / simCount : 0,
        reason: `${members.length} similar items (avg similarity: ${((simCount > 0 ? simSum / simCount : 0) * 100).toFixed(1)}%)`,
        type,
      });
    }

    return clusters;
  }

  private itemToText(item: TriageItem): string {
    const parts = [item.title, item.body?.slice(0, 1000) ?? ''];
    if ('changedFiles' in item && item.changedFiles.length > 0) {
      parts.push('Files: ' + item.changedFiles.slice(0, 20).join(', '));
    }
    return parts.join('\n').slice(0, 2000);
  }

  private async embed(text: string): Promise<number[]> {
    return this.provider.generateEmbedding(text);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
  }
}
