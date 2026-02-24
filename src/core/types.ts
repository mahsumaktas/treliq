/**
 * Core type definitions for Treliq
 */

import type { LLMProvider } from './provider';

export interface TreliqConfig {
  repo: string;               // owner/repo
  token: string;              // GitHub token
  provider?: LLMProvider;     // LLM provider for scoring, dedup, vision
  geminiApiKey?: string;      // @deprecated — use provider instead
  visionDocPath?: string;     // Path to VISION.md or ROADMAP.md
  duplicateThreshold: number; // Default: 0.85
  relatedThreshold: number;   // Default: 0.80
  maxPRs: number;             // Max PRs to scan (default: 500)
  outputFormat: 'table' | 'json' | 'markdown';
  comment: boolean;           // Post results as PR comment
  trustContributors: boolean; // Exempt known contributors from spam detection
  useCache: boolean;           // Use incremental cache (default: true)
  cacheFile: string;           // Cache file path (default: '.treliq-cache.json')
  dbPath?: string;             // SQLite database path (undefined = no DB)
  cascade?: {
    enabled: boolean;
    reScoreProvider?: LLMProvider;
    preFilterThreshold?: number;
    haikuThreshold?: number;
  };
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
  hasTests: boolean;
  testFilesChanged: string[];
  ageInDays: number;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  reviewState: 'approved' | 'changes_requested' | 'commented' | 'none';
  reviewCount: number;
  commentCount: number;
  isDraft: boolean;
  milestone?: string;
  requestedReviewers: string[];
  codeowners: string[];
  /** Optional linked issue description for LLM context enrichment */
  issueContext?: string;
  /** PR state for readyToSteal detection */
  state?: 'open' | 'closed' | 'merged';
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
  llmScore?: number;           // 0-100 LLM quality score (backward compat — maps to ideaScore)
  llmRisk?: 'low' | 'medium' | 'high';
  llmReason?: string;
  duplicateGroup?: number;     // Cluster ID if part of a duplicate group
  isSpam: boolean;
  spamReasons: string[];
  intent?: IntentCategory;
  diffAnalysis?: DiffAnalysis;
  semanticMatches?: SemanticMatch[];
  holisticRank?: number;
  adjustedScore?: number;
  /** Idea/fix value score (0-100) — how valuable is the core idea? */
  ideaScore?: number;
  /** Why this score for idea value */
  ideaReason?: string;
  /** Binary checklist answers from CheckEval idea questions */
  ideaChecklist?: boolean[];
  /** Implementation quality score (0-100) — how well is the code implemented? */
  implementationScore?: number;
  /** Why this score for implementation */
  implementationReason?: string;
  /** Binary checklist answers from CheckEval implementation questions */
  implementationChecklist?: boolean[];
  /** Merge-readiness score (0-100) — heuristic signals via TOPSIS */
  readinessScore?: number;
  /** Hard penalty multiplier applied to readiness */
  penaltyMultiplier?: number;
  /** Percentile rank within scored batch */
  percentileRank?: number;
  /** Priority tier based on combined scores */
  tier?: 'critical' | 'high' | 'normal' | 'low';
  /** Which model scored this PR */
  scoredBy?: 'heuristic' | 'haiku' | 'sonnet';
  /** Ready to steal: high-value closed PR we can re-implement */
  readyToSteal?: boolean;
  /** Novelty bonus (0-20) from CheckEval Part C */
  noveltyBonus?: number;
}

export type IntentCategory = 'bugfix' | 'feature' | 'refactor' | 'dependency' | 'docs' | 'chore';

export interface IssueData {
  number: number;
  title: string;
  body: string;
  author: string;
  authorAssociation: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  milestone?: string;
  commentCount: number;
  reactionCount: number;
  state: 'open' | 'closed';
  stateReason?: 'completed' | 'not_planned' | null;
  isLocked: boolean;
  assignees: string[];
  linkedPRs: number[];
}

export interface ScoredIssue extends IssueData {
  totalScore: number;
  signals: SignalScore[];
  intent?: IntentCategory;
  embedding?: number[];
  duplicateGroup?: number;
  isSpam: boolean;
  spamReasons: string[];
  semanticMatches?: SemanticMatch[];
  holisticRank?: number;
  adjustedScore?: number;
}

export interface DiffAnalysis {
  prNumber: number;
  codeQuality: number;        // 0-100
  riskAssessment: 'low' | 'medium' | 'high' | 'critical';
  changeType: 'additive' | 'modifying' | 'removing' | 'mixed';
  affectedAreas: string[];
  summary: string;
}

export interface SemanticMatch {
  prNumber: number;
  issueNumber: number;
  matchQuality: 'full' | 'partial' | 'unrelated' | 'unchecked';
  confidence: number;
  reason: string;
}

export type TriageItem = ScoredPR | ScoredIssue;

export interface DedupCluster {
  id: number;
  prs: TriageItem[];           // Items in cluster (name kept for backward compat)
  bestPR: number;              // Item number of recommended best
  similarity: number;          // Average similarity within cluster
  reason: string;              // Why these are grouped
  type?: 'pr' | 'issue' | 'mixed';
}

export interface TreliqResult {
  repo: string;
  scannedAt: string;
  totalPRs: number;
  totalIssues?: number;
  spamCount: number;
  duplicateClusters: DedupCluster[];
  rankedPRs: ScoredPR[];       // Sorted by totalScore desc
  rankedIssues?: ScoredIssue[];
  summary: string;
}

export interface CascadeConfig {
  enabled: boolean;
  reScoreProvider: LLMProvider;
  preFilterThreshold?: number;  // default: 15
  haikuThreshold?: number;      // default: 40
}

export interface ScoringEngineOptions {
  provider?: LLMProvider;
  trustContributors?: boolean;
  maxConcurrent?: number;
  scoringPasses?: number;
  cascade?: CascadeConfig;
}
