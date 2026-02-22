# Accuracy Pipeline Redesign — Design Document

**Date:** 2026-02-22
**Version Target:** v0.7.0
**Status:** Approved

## Goal

Transform Treliq from a metadata-based triage tool into a code-aware, semantically intelligent system. Five improvements that increase ranking accuracy by analyzing actual diffs, verifying duplicates with LLM, adapting scoring to intent, matching issues to PRs semantically, and re-ranking holistically.

## Motivation

Peter Steinberger's approach (50 Codex in parallel, all-in-context comparison) highlights Treliq's current blind spots:
1. Treliq scores PRs without reading their code
2. Each PR is scored in isolation — no cross-PR comparison
3. Embedding dedup misses semantic duplicates
4. Intent signal is underweighted
5. Issue-PR linking is syntactic, not semantic

## Architecture: Sequential Deep Pipeline

Extends the existing pipeline with 3 new stages. No rewrite — additive changes.

```
Fetch PRs/Issues
  → Heuristic Scoring (21 signals + intent-aware profiles)
  → Diff Fetch (all PRs, parallel, cached)
  → LLM Scoring (diff-enriched prompt)
  → Dedup (embedding + LLM verification)
  → Issue-PR Semantic Matching
  → Holistic Re-ranking (tournament-style, grouped)
  → Output
```

`--no-llm` disables all LLM stages; heuristic-only mode continues to work.

---

## Feature 1: Diff-Aware Scoring

### New Module: `src/core/diff-analyzer.ts`

**Class:** `DiffAnalyzer`

**Responsibilities:**
- Fetch PR diffs via GitHub API (`Accept: application/vnd.github.diff`)
- Truncate to 10,000 chars (large diffs summarized)
- Send to LLM for structured analysis
- Cache by diff hash (same commit = skip re-fetch)

**Output type:**
```typescript
interface DiffAnalysis {
  prNumber: number;
  codeQuality: number;        // 0-100
  riskAssessment: 'low' | 'medium' | 'high' | 'critical';
  changeType: 'additive' | 'modifying' | 'removing' | 'mixed';
  affectedAreas: string[];    // e.g. ['auth', 'database', 'api']
  summary: string;            // 1-2 sentence diff summary
}
```

**LLM Prompt:**
```
Analyze this PR diff. Return JSON:
{"codeQuality": <0-100>, "riskAssessment": "<low|medium|high|critical>",
 "changeType": "<additive|modifying|removing|mixed>",
 "affectedAreas": ["<area1>", ...], "summary": "<brief>"}

Diff:
<truncated diff content>
```

**Scoring blend update:**
- Old: `0.4 * heuristic + 0.6 * llmScore`
- New: `0.4 * heuristic + 0.3 * llmTextScore + 0.3 * llmDiffScore`
- `riskAssessment` from diff overrides `llmRisk` (code-based risk > text-based)

**Concurrency:** ConcurrencyController, 15 concurrent diff fetches.

---

## Feature 2: LLM Dedup Verification

### Extension to `DedupEngine`

After embedding clusters are found, each cluster goes through LLM verification.

**Step 1 — Verify (per cluster):**
```
These PRs/Issues were detected as potential duplicates.
Are they actually duplicates (solving the same problem)?

#42: "Fix rate limiter timeout" — [diff summary]
#67: "Add rate limit retry logic" — [diff summary]

Return JSON: {"isDuplicate": true/false, "reason": "<brief>",
  "subgroups": [[42, 67], [89]] // if partial duplicates}
```

- `subgroups` allows splitting false clusters
- Non-duplicate clusters are dissolved

**Step 2 — Best selection (only if isDuplicate=true):**
```
Which duplicate is the best to merge and why?
Return JSON: {"bestPR": 42, "reason": "<brief>"}
```

**Constraints:**
- Max 20 clusters verified (largest first by member count)
- DiffAnalysis summaries included in prompt when available
- `--no-llm`: verification skipped, score-based bestPR preserved
- New param: `DedupEngine({ verifyWithLLM: boolean })`

---

## Feature 3: Intent Weight Increase + Intent-Aware Profiles

### Weight Change

Intent signal: **0.08 → 0.15**

### 6 Hardcoded Profiles

Each profile overrides specific signal weights. Unmentioned signals keep defaults. Weights are normalized to sum=1.0 after override.

```typescript
const INTENT_PROFILES: Record<IntentCategory, Partial<Record<string, number>>> = {
  bugfix: {
    ci_status: 0.20,        // bugs must pass CI
    test_coverage: 0.18,    // bugfix needs tests
    mergeability: 0.15,
    diff_size: 0.04,        // small fix still valuable
  },
  feature: {
    body_quality: 0.08,     // features need good descriptions
    test_coverage: 0.15,
    scope_coherence: 0.08,  // features should be focused
  },
  refactor: {
    test_coverage: 0.18,    // refactor without tests is dangerous
    breaking_change: 0.08,
    scope_coherence: 0.10,
  },
  dependency: {
    ci_status: 0.25,        // dep updates must pass CI
    diff_size: 0.02,        // lockfiles are big, doesn't matter
    body_quality: 0.02,     // Dependabot body is standard
    test_coverage: 0.15,
  },
  docs: {
    diff_size: 0.02,        // docs can be big
    ci_status: 0.05,        // CI less relevant
    test_coverage: 0.03,    // docs don't have tests
    body_quality: 0.08,
  },
  chore: {
    ci_status: 0.20,
    breaking_change: 0.06,
    diff_size: 0.03,
  },
};
```

**Application in ScoringEngine:**
1. Classify intent (existing IntentClassifier)
2. Look up intent profile
3. Merge profile deltas into default weights
4. Normalize to sum=1.0
5. Calculate weighted average

---

## Feature 4: Issue-PR Semantic Matching

### New Module: `src/core/semantic-matcher.ts`

**Class:** `SemanticMatcher`

**When it runs:** After DiffAnalysis and Issue scoring, before holistic re-ranking.

**Scope:** Only PR-Issue pairs where PR.issueNumbers references the issue.

**LLM Prompt:**
```
Does this PR resolve this Issue?

Issue #10: "Login button crashes on mobile Safari"
<issue body, max 2000 chars>

PR #42: "fix: handle Safari touch events in auth flow"
<diff summary from DiffAnalysis>
<diff, max 5000 chars>

Return JSON:
{"matchQuality": "full"|"partial"|"unrelated",
 "confidence": <0-1>,
 "reason": "<brief>"}
```

**Score impact — bidirectional:**

PR side (new `issue_match` signal or bonus):
- `full` → +8 points to totalScore
- `partial` → +3 points
- `unrelated` → -5 points (false reference penalty)

Issue side (enhance `has_linked_pr` signal):
- Linked PR matchQuality `full` → score 95
- Linked PR matchQuality `partial` → score 70
- Linked PR matchQuality `unrelated` → score 40
- No linked PR → score 30 (unchanged)

**Fallback:** `--no-llm` → matchQuality = `'unchecked'`, no score impact.

---

## Feature 5: Holistic Re-ranking (Tournament)

### New Module: `src/core/holistic-ranker.ts`

**Class:** `HolisticRanker`

**When it runs:** Last stage, after all scoring, dedup, and matching complete.

**Tournament format:**

```
All items (e.g., 200)
  → Split into groups of 50
  → Per group: LLM ranks top 10
  → Collect group finalists (40 items)
  → Final round: LLM ranks top 15 from finalists
  → holisticRank: 1-15 for winners, undefined for rest
```

**LLM Prompt (per group):**
```
You are triaging a GitHub repository. Rank the top 10 most important items.
Consider: code quality, risk, intent, issue resolution, community demand.

Items:
#42 [PR] score:87 intent:bugfix risk:low diff:"Fix Safari auth crash" match:full(#10)
#67 [PR] score:72 intent:feature risk:medium diff:"Add dark mode" match:unchecked
#10 [Issue] score:91 intent:bugfix reactions:23 linkedPR:#42(full)
...

Return JSON: {"ranked": [42, 10, 67, ...], "reasoning": "<brief per-item>"}
```

**Token budget:** ~200 tokens/item × 50 items = ~10k tokens/group.

**Score impact:**
- New field: `holisticRank?: number` (1-15)
- Adjusted score: `totalScore + (holisticRank ? (16 - holisticRank) * 2 : 0)`
  - Rank #1: +30 bonus, Rank #15: +2 bonus
- Does NOT replace totalScore — additive bonus only

**`--no-llm`:** Re-ranking skipped entirely, totalScore ordering preserved.

---

## New Types Summary

```typescript
// diff-analyzer.ts
interface DiffAnalysis {
  prNumber: number;
  codeQuality: number;
  riskAssessment: 'low' | 'medium' | 'high' | 'critical';
  changeType: 'additive' | 'modifying' | 'removing' | 'mixed';
  affectedAreas: string[];
  summary: string;
}

// semantic-matcher.ts
interface SemanticMatch {
  prNumber: number;
  issueNumber: number;
  matchQuality: 'full' | 'partial' | 'unrelated' | 'unchecked';
  confidence: number;
  reason: string;
}

// holistic-ranker.ts
interface HolisticResult {
  rankedItems: number[];    // ordered item numbers
  reasoning: string;
}

// types.ts additions
interface ScoredPR {
  // ... existing fields
  diffAnalysis?: DiffAnalysis;
  semanticMatches?: SemanticMatch[];
  holisticRank?: number;
  adjustedScore?: number;
}

interface ScoredIssue {
  // ... existing fields
  semanticMatches?: SemanticMatch[];
  holisticRank?: number;
  adjustedScore?: number;
}
```

## Pipeline Flow (Updated)

```
1. Fetch PRs (GraphQL/REST) + Issues (if --include-issues)
2. Heuristic scoring (21 signals)
3. Intent classification → apply intent-aware weight profiles
4. Diff fetch (all PRs, parallel, cached)
5. LLM scoring (diff-enriched prompt, new blend: 0.4/0.3/0.3)
6. Embedding dedup + LLM cluster verification
7. Issue-PR semantic matching (bidirectional score impact)
8. Holistic re-ranking (tournament: groups of 50 → finalists → top 15)
9. Cache + persist + output
```

## Testing Strategy

- DiffAnalyzer: mock GitHub diff API, mock LLM, test truncation, caching
- LLM Dedup Verification: mock LLM responses, test subgroup splitting, cluster dissolution
- Intent Profiles: test weight normalization, per-intent score differences
- SemanticMatcher: mock LLM, test bidirectional score impact, edge cases (empty body)
- HolisticRanker: mock LLM, test tournament flow, group splitting, bonus calculation
- Integration: full pipeline with all features enabled, verify score ordering improves

## Backward Compatibility

- `--no-llm` disables all new LLM features, heuristic mode unchanged
- All new fields are optional (`?`) on ScoredPR/ScoredIssue
- Existing 345 tests must continue passing
- Cache format backward compatible (new fields ignored by old versions)
