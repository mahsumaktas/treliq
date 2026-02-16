/**
 * DedupEngine — Semantic duplicate detection for PRs using embeddings
 * Supports both brute-force O(n²) and LanceDB ANN O(n log n) modes.
 */

import type { ScoredPR, DedupCluster } from './types';
import type { LLMProvider } from './provider';
import { VectorStore, type VectorRecord } from './vectorstore';

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
        console.error(`   ⚠️  Failed to connect VectorStore: ${err.message}`);
        this.vectorStore = undefined;
      });
    }
  }

  async findDuplicates(prs: ScoredPR[]): Promise<DedupCluster[]> {
    if (prs.length < 2) return [];

    // 1. Embed all PRs
    console.error(`   Embedding ${prs.length} PRs...`);
    const embeddings: Map<number, number[]> = new Map();
    let consecutiveFailures = 0;

    for (const pr of prs) {
      if (consecutiveFailures >= 5) {
        console.warn('   ⚠️  Too many embedding failures, skipping remaining PRs for dedup.');
        break;
      }
      try {
        const text = this.prToText(pr);
        const embedding = await this.embed(text);
        pr.embedding = embedding;
        embeddings.set(pr.number, embedding);
        consecutiveFailures = 0;
        // Rate limit protection
        await new Promise(r => setTimeout(r, 250));
      } catch (err: any) {
        consecutiveFailures++;
        console.error(`   ⚠️  Failed to embed PR #${pr.number}: ${err.message}`);
      }
    }

    // 2. Find similar pairs — use VectorStore (ANN) or brute-force
    const embeddedPRs = prs.filter(p => p.embedding);
    let pairs: Array<{ a: number; b: number; sim: number }>;

    if (this.vectorStore && embeddedPRs.length > 50) {
      // Use LanceDB ANN for large sets (>50 PRs)
      console.error(`   Using LanceDB ANN search for ${embeddedPRs.length} PRs...`);
      const records: VectorRecord[] = embeddedPRs.map(pr => ({
        prNumber: pr.number,
        embedding: pr.embedding!,
      }));
      pairs = await this.vectorStore.findAllPairsAboveThreshold(records, this.relatedThreshold);
    } else {
      // Brute-force cosine similarity for small sets
      pairs = [];
      for (let i = 0; i < embeddedPRs.length; i++) {
        for (let j = i + 1; j < embeddedPRs.length; j++) {
          const sim = this.cosineSimilarity(embeddedPRs[i].embedding!, embeddedPRs[j].embedding!);
          if (sim >= this.relatedThreshold) {
            pairs.push({ a: embeddedPRs[i].number, b: embeddedPRs[j].number, sim });
          }
        }
      }
    }

    // 3. Cluster via union-find
    const prMap = new Map(prs.map(p => [p.number, p]));
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
      const clusterPRs = members.map(n => prMap.get(n)!).filter(Boolean);
      const bestPR = clusterPRs.reduce((a, b) => a.totalScore >= b.totalScore ? a : b);

      // Avg similarity
      let simSum = 0;
      let simCount = 0;
      for (const p of pairs) {
        if (members.includes(p.a) && members.includes(p.b)) {
          simSum += p.sim;
          simCount++;
        }
      }

      // Mark duplicate group on PRs
      for (const pr of clusterPRs) {
        pr.duplicateGroup = id;
      }

      clusters.push({
        id: id++,
        prs: clusterPRs,
        bestPR: bestPR.number,
        similarity: simCount > 0 ? simSum / simCount : 0,
        reason: `${members.length} similar PRs (avg similarity: ${((simCount > 0 ? simSum / simCount : 0) * 100).toFixed(1)}%)`,
      });
    }

    return clusters;
  }

  private prToText(pr: ScoredPR): string {
    const parts = [pr.title, pr.body?.slice(0, 1000) ?? ''];
    if (pr.changedFiles.length > 0) {
      parts.push('Files: ' + pr.changedFiles.slice(0, 20).join(', '));
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
