/**
 * Core type definitions for Treliq
 */

export interface TreliqConfig {
  repo: string;               // owner/repo
  token: string;              // GitHub token
  geminiApiKey?: string;      // Gemini API key for embeddings + review
  visionDocPath?: string;     // Path to VISION.md or ROADMAP.md
  duplicateThreshold: number; // Default: 0.85
  relatedThreshold: number;   // Default: 0.80
  maxPRs: number;             // Max PRs to scan (default: 500)
  outputFormat: 'table' | 'json' | 'markdown';
  comment: boolean;           // Post results as PR comment
}

export interface PRData {
  number: number;
  title: string;
  body: string;
  author: string;
  authorAssociation: string;  // CONTRIBUTOR, FIRST_TIMER, etc.
  createdAt: string;
  updatedAt: string;
  headRef: string;            // Branch name
  baseRef: string;            // Target branch
  filesChanged: number;
  additions: number;
  deletions: number;
  commits: number;
  labels: string[];
  ciStatus: 'success' | 'failure' | 'pending' | 'unknown';
  hasIssueRef: boolean;
  issueNumbers: number[];
  changedFiles: string[];
  diffUrl: string;
}

export interface SignalScore {
  name: string;
  score: number;       // 0-100
  weight: number;      // 0-1
  reason: string;
}

export interface ScoredPR extends PRData {
  totalScore: number;          // 0-100 weighted
  signals: SignalScore[];
  embedding?: number[];
  visionAlignment?: 'aligned' | 'tangential' | 'off-roadmap' | 'unchecked';
  visionScore?: number;        // 0-100 LLM vision alignment score
  visionReason?: string;
  llmScore?: number;           // 0-100 LLM quality score
  llmRisk?: 'low' | 'medium' | 'high';
  llmReason?: string;
  duplicateGroup?: number;     // Cluster ID if part of a duplicate group
  isSpam: boolean;
  spamReasons: string[];
}

export interface DedupCluster {
  id: number;
  prs: ScoredPR[];
  bestPR: number;              // PR number of recommended best
  similarity: number;          // Average similarity within cluster
  reason: string;              // Why these are grouped
}

export interface TreliqResult {
  repo: string;
  scannedAt: string;
  totalPRs: number;
  spamCount: number;
  duplicateClusters: DedupCluster[];
  rankedPRs: ScoredPR[];       // Sorted by totalScore desc
  summary: string;
}
