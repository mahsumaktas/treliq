/**
 * Treliq — AI-Powered PR Triage for Open Source Maintainers
 *
 * Core pipeline:
 * 1. Fetch open PRs from GitHub
 * 2. Embed PR content (title + description + files)
 * 3. Find duplicate/related PR clusters
 * 4. Score each PR on multiple signals
 * 5. Check vision document alignment
 * 6. Output ranked results
 */

export { TreliqScanner } from './core/scanner';
export { DedupEngine } from './core/dedup';
export { ScoringEngine } from './core/scoring';
export { VisionChecker } from './core/vision';
export { IntentClassifier } from './core/intent';
export { IssueScanner } from './core/issue-scanner';
export { IssueScoringEngine } from './core/issue-scoring';
export { ActionEngine } from './core/actions';
export { ActionExecutor } from './core/action-executor';
export { DiffAnalyzer } from './core/diff-analyzer';
export { SemanticMatcher } from './core/semantic-matcher';
export { HolisticRanker } from './core/holistic-ranker';
export type { PRData, ScoredPR, ScoredIssue, IssueData, DedupCluster, TreliqConfig, TreliqResult, TriageItem, DiffAnalysis, SemanticMatch } from './core/types';
export type { ActionItem, ActionOptions } from './core/actions';
export type { ExecutionResult } from './core/action-executor';
export { loadCache, saveCache, configHash } from './core/cache';
export { TEST_PATTERNS } from './core/scanner';
export { createProvider, GeminiProvider, OpenAIProvider, AnthropicProvider } from './core/provider';
export type { LLMProvider, ProviderName } from './core/provider';
