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
export type { PRData, ScoredPR, DedupCluster, TreliqConfig } from './core/types';
export { loadCache, saveCache, configHash } from './core/cache';
export { TEST_PATTERNS } from './core/scanner';
export { createProvider, GeminiProvider, OpenAIProvider, AnthropicProvider } from './core/provider';
export type { LLMProvider, ProviderName } from './core/provider';
