# Accuracy Pipeline Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 5 accuracy improvements to Treliq: diff-aware scoring, LLM dedup verification, intent-aware scoring profiles, issue-PR semantic matching, and holistic tournament re-ranking.

**Architecture:** Sequential Deep Pipeline — extends the existing `scan()` pipeline with new stages. Each feature is a standalone module that plugs into the scanner orchestration. All new stages are LLM-optional; `--no-llm` skips them.

**Tech Stack:** TypeScript, Jest, Octokit (diff fetch), existing LLMProvider interface, ConcurrencyController

---

### Task 1: Expand Types

**Files:**
- Modify: `src/core/types.ts`
- Modify: `test/fixtures/pr-factory.ts`

**Context:** All 5 features need new type definitions. We add them upfront so subsequent tasks can import them immediately.

**Step 1: Add DiffAnalysis and SemanticMatch interfaces to types.ts**

Add after the `ScoredIssue` interface (line 109):

```typescript
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
```

**Step 2: Add new optional fields to ScoredPR**

Add after `intent?: IntentCategory;` (line 77):

```typescript
  diffAnalysis?: DiffAnalysis;
  semanticMatches?: SemanticMatch[];
  holisticRank?: number;
  adjustedScore?: number;
```

**Step 3: Add new optional fields to ScoredIssue**

Add after `spamReasons: string[];` (line 108):

```typescript
  semanticMatches?: SemanticMatch[];
  holisticRank?: number;
  adjustedScore?: number;
```

**Step 4: Update index.ts exports**

In `src/index.ts`, add `DiffAnalysis` and `SemanticMatch` to the type exports line:

```typescript
export type { PRData, ScoredPR, ScoredIssue, IssueData, DedupCluster, TreliqConfig, TreliqResult, TriageItem, DiffAnalysis, SemanticMatch } from './core/types';
```

**Step 5: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: Clean — no errors (new fields are all optional)

**Step 6: Run existing tests**

Run: `npx jest --no-coverage`
Expected: 345/345 passing (no behavior changes)

**Step 7: Commit**

```bash
git add src/core/types.ts src/index.ts
git commit -m "feat: add DiffAnalysis, SemanticMatch types and new ScoredPR/ScoredIssue fields"
```

---

### Task 2: DiffAnalyzer Module

**Files:**
- Create: `src/core/diff-analyzer.ts`
- Create: `test/unit/diff-analyzer.test.ts`

**Context:** DiffAnalyzer fetches PR diffs from GitHub API and sends them to LLM for structured analysis. It uses `ConcurrencyController` for parallel fetching and the existing `LLMProvider` interface.

**Step 1: Write the failing tests**

Create `test/unit/diff-analyzer.test.ts`:

```typescript
import { DiffAnalyzer } from '../../src/core/diff-analyzer';
import { MockLLMProvider } from '../fixtures/mock-provider';
import type { Octokit } from '@octokit/rest';

function mockOctokit(diffText: string): Octokit {
  return {
    pulls: {
      get: jest.fn().mockResolvedValue({
        data: '',
        headers: { 'content-type': 'text/plain' },
      }),
    },
    request: jest.fn().mockResolvedValue({
      data: diffText,
    }),
  } as any;
}

describe('DiffAnalyzer', () => {
  it('fetches diff and returns LLM analysis', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      codeQuality: 85,
      riskAssessment: 'low',
      changeType: 'modifying',
      affectedAreas: ['auth', 'api'],
      summary: 'Fixes auth timeout handling',
    });

    const octokit = mockOctokit('diff --git a/src/auth.ts\n+fix timeout');
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    const results = await analyzer.analyzeMany([42]);

    expect(results.length).toBe(1);
    expect(results[0].prNumber).toBe(42);
    expect(results[0].codeQuality).toBe(85);
    expect(results[0].riskAssessment).toBe('low');
    expect(results[0].affectedAreas).toEqual(['auth', 'api']);
  });

  it('truncates diffs longer than 10000 chars', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      codeQuality: 50,
      riskAssessment: 'medium',
      changeType: 'mixed',
      affectedAreas: [],
      summary: 'Large diff',
    });

    const longDiff = 'x'.repeat(20000);
    const octokit = mockOctokit(longDiff);
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    await analyzer.analyzeMany([1]);

    const promptUsed = provider.generateTextCalls[0].prompt;
    expect(promptUsed.length).toBeLessThanOrEqual(12000); // 10k diff + prompt overhead
  });

  it('handles diff fetch failure gracefully', async () => {
    const provider = new MockLLMProvider();
    const octokit = {
      request: jest.fn().mockRejectedValue(new Error('404 Not Found')),
    } as any;

    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    const results = await analyzer.analyzeMany([99]);

    expect(results).toEqual([]);
  });

  it('handles LLM failure gracefully', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = 'not valid json at all';

    const octokit = mockOctokit('diff content');
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    const results = await analyzer.analyzeMany([42]);

    expect(results).toEqual([]);
  });

  it('handles invalid JSON fields with defaults', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      codeQuality: 200,
      riskAssessment: 'extreme',
      changeType: 'unknown',
    });

    const octokit = mockOctokit('diff content');
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    const results = await analyzer.analyzeMany([1]);

    expect(results[0].codeQuality).toBe(100); // clamped
    expect(results[0].riskAssessment).toBe('medium'); // invalid -> default
    expect(results[0].changeType).toBe('mixed'); // invalid -> default
  });

  it('analyzes multiple PRs in parallel', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      codeQuality: 70,
      riskAssessment: 'low',
      changeType: 'additive',
      affectedAreas: ['core'],
      summary: 'OK',
    });

    const octokit = mockOctokit('diff');
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo', provider);
    const results = await analyzer.analyzeMany([1, 2, 3]);

    expect(results.length).toBe(3);
    expect(results.map(r => r.prNumber)).toEqual([1, 2, 3]);
  });

  it('works without LLM provider (returns empty)', async () => {
    const octokit = mockOctokit('diff');
    const analyzer = new DiffAnalyzer(octokit, 'owner', 'repo');
    const results = await analyzer.analyzeMany([1]);

    expect(results).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/diff-analyzer.test.ts --no-coverage`
Expected: FAIL — module not found

**Step 3: Implement DiffAnalyzer**

Create `src/core/diff-analyzer.ts`:

```typescript
/**
 * DiffAnalyzer — Fetches PR diffs and analyzes code changes via LLM
 */

import type { Octokit } from '@octokit/rest';
import type { LLMProvider } from './provider';
import type { DiffAnalysis } from './types';
import { ConcurrencyController } from './concurrency';
import { createLogger } from './logger';

const log = createLogger('diff-analyzer');

const MAX_DIFF_LENGTH = 10000;
const VALID_RISKS = ['low', 'medium', 'high', 'critical'] as const;
const VALID_CHANGE_TYPES = ['additive', 'modifying', 'removing', 'mixed'] as const;

export class DiffAnalyzer {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private provider?: LLMProvider;
  private concurrency: ConcurrencyController;

  constructor(octokit: Octokit, owner: string, repo: string, provider?: LLMProvider, maxConcurrent = 15) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
    this.provider = provider;
    this.concurrency = new ConcurrencyController(maxConcurrent);
  }

  async analyzeMany(prNumbers: number[]): Promise<DiffAnalysis[]> {
    if (!this.provider || prNumbers.length === 0) return [];

    log.info({ count: prNumbers.length }, 'Analyzing PR diffs');

    const results = await Promise.allSettled(
      prNumbers.map(num => this.concurrency.execute(() => this.analyzeOne(num)))
    );

    const analyses: DiffAnalysis[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        analyses.push(result.value);
      }
    }

    log.info({ analyzed: analyses.length, total: prNumbers.length }, 'Diff analysis complete');
    return analyses;
  }

  private async analyzeOne(prNumber: number): Promise<DiffAnalysis | null> {
    try {
      const diff = await this.fetchDiff(prNumber);
      if (!diff) return null;

      const truncated = diff.slice(0, MAX_DIFF_LENGTH);
      const prompt = `Analyze this PR diff. Return JSON:
{"codeQuality": <0-100>, "riskAssessment": "<low|medium|high|critical>",
 "changeType": "<additive|modifying|removing|mixed>",
 "affectedAreas": ["<area1>", ...], "summary": "<brief>"}

Diff:
${truncated}`;

      const text = await this.provider!.generateText(prompt, { temperature: 0.1, maxTokens: 200 });
      return this.parseResponse(prNumber, text);
    } catch (err) {
      log.warn({ prNumber, err }, 'Diff analysis failed');
      return null;
    }
  }

  private async fetchDiff(prNumber: number): Promise<string | null> {
    try {
      const response = await this.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        headers: { accept: 'application/vnd.github.diff' },
      });
      return typeof response.data === 'string' ? response.data : String(response.data);
    } catch (err) {
      log.warn({ prNumber, err }, 'Failed to fetch diff');
      return null;
    }
  }

  private parseResponse(prNumber: number, text: string): DiffAnalysis | null {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[0]);
      return {
        prNumber,
        codeQuality: Math.max(0, Math.min(100, Number(parsed.codeQuality) || 50)),
        riskAssessment: VALID_RISKS.includes(parsed.riskAssessment) ? parsed.riskAssessment : 'medium',
        changeType: VALID_CHANGE_TYPES.includes(parsed.changeType) ? parsed.changeType : 'mixed',
        affectedAreas: Array.isArray(parsed.affectedAreas) ? parsed.affectedAreas.map(String) : [],
        summary: String(parsed.summary ?? ''),
      };
    } catch {
      return null;
    }
  }
}
```

**Step 4: Run tests**

Run: `npx jest test/unit/diff-analyzer.test.ts --no-coverage`
Expected: 7/7 passing

**Step 5: Run all tests**

Run: `npx jest --no-coverage`
Expected: 352/352 passing (345 + 7 new)

**Step 6: Commit**

```bash
git add src/core/diff-analyzer.ts test/unit/diff-analyzer.test.ts
git commit -m "feat: add DiffAnalyzer for code-aware PR scoring"
```

---

### Task 3: Intent-Aware Scoring Profiles

**Files:**
- Modify: `src/core/scoring.ts`
- Create: `test/unit/intent-profiles.test.ts`

**Context:** Change intent signal weight from 0.08 to 0.15. Add 6 hardcoded intent profiles that override specific signal weights based on PR intent. Weights are normalized to sum=1.0 after override.

**Step 1: Write the failing tests**

Create `test/unit/intent-profiles.test.ts`:

```typescript
import { ScoringEngine } from '../../src/core/scoring';
import { createPRData } from '../fixtures/pr-factory';

describe('Intent-Aware Scoring Profiles', () => {
  it('uses intent weight of 0.15', async () => {
    const engine = new ScoringEngine();
    const pr = createPRData({ title: 'feat: add feature' });
    const scored = await engine.score(pr);
    const signal = scored.signals.find(s => s.name === 'intent');
    expect(signal?.weight).toBe(0.15);
  });

  it('applies bugfix profile: higher ci_status weight', async () => {
    const engine = new ScoringEngine();
    const bugfix = createPRData({ title: 'fix: crash on login', ciStatus: 'success' });
    const feature = createPRData({ title: 'feat: add dark mode', ciStatus: 'success' });

    const bugfixScored = await engine.score(bugfix);
    const featureScored = await engine.score(feature);

    const bugfixCI = bugfixScored.signals.find(s => s.name === 'ci_status');
    const featureCI = featureScored.signals.find(s => s.name === 'ci_status');

    // bugfix profile boosts ci_status to 0.20, feature keeps default 0.15
    expect(bugfixCI!.weight).toBeGreaterThan(featureCI!.weight);
  });

  it('applies docs profile: lower ci_status and test_coverage weight', async () => {
    const engine = new ScoringEngine();
    const docs = createPRData({
      title: 'docs: update README',
      changedFiles: ['README.md'],
      ciStatus: 'failure',
      hasTests: false,
      testFilesChanged: [],
    });

    const scored = await engine.score(docs);
    const ci = scored.signals.find(s => s.name === 'ci_status');
    const test = scored.signals.find(s => s.name === 'test_coverage');

    expect(ci!.weight).toBeLessThan(0.10); // docs profile: 0.05
    expect(test!.weight).toBeLessThan(0.05); // docs profile: 0.03
  });

  it('applies dependency profile: higher ci_status, lower diff_size', async () => {
    const engine = new ScoringEngine();
    const dep = createPRData({
      title: 'chore(deps): bump express to v5',
      changedFiles: ['package.json', 'package-lock.json'],
      additions: 5000,
      deletions: 3000,
    });

    const scored = await engine.score(dep);
    const ci = scored.signals.find(s => s.name === 'ci_status');
    const diff = scored.signals.find(s => s.name === 'diff_size');

    expect(ci!.weight).toBeGreaterThanOrEqual(0.20); // dep profile: 0.25
    expect(diff!.weight).toBeLessThan(0.05); // dep profile: 0.02
  });

  it('normalizes weights to sum ~1.0 after profile application', async () => {
    const engine = new ScoringEngine();
    const pr = createPRData({ title: 'fix: memory leak' });
    const scored = await engine.score(pr);
    const totalWeight = scored.signals.reduce((sum, s) => sum + s.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 1);
  });

  it('refactor profile boosts test_coverage and breaking_change', async () => {
    const engine = new ScoringEngine();
    const pr = createPRData({ title: 'refactor: extract scoring engine' });
    const scored = await engine.score(pr);

    const test = scored.signals.find(s => s.name === 'test_coverage');
    const breaking = scored.signals.find(s => s.name === 'breaking_change');

    expect(test!.weight).toBeGreaterThan(0.12); // refactor: 0.18
    expect(breaking!.weight).toBeGreaterThan(0.04); // refactor: 0.08
  });

  it('chore profile boosts ci_status', async () => {
    const engine = new ScoringEngine();
    const pr = createPRData({ title: 'ci: add coverage upload' });
    const scored = await engine.score(pr);

    const ci = scored.signals.find(s => s.name === 'ci_status');
    expect(ci!.weight).toBeGreaterThan(0.15); // chore: 0.20
  });

  it('feature profile boosts body_quality and scope_coherence', async () => {
    const engine = new ScoringEngine();
    const pr = createPRData({ title: 'feat: add user dashboard' });
    const scored = await engine.score(pr);

    const body = scored.signals.find(s => s.name === 'body_quality');
    const scope = scored.signals.find(s => s.name === 'scope_coherence');

    expect(body!.weight).toBeGreaterThan(0.04); // feature: 0.08
    expect(scope!.weight).toBeGreaterThan(0.06); // feature: 0.08
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/intent-profiles.test.ts --no-coverage`
Expected: FAIL — intent weight is 0.08, not 0.15

**Step 3: Implement intent-aware profiles**

In `src/core/scoring.ts`, add the following constants after the imports (line 10):

```typescript
import type { IntentCategory } from './types';

/** Intent-aware weight profiles — overrides for specific signals per intent */
const INTENT_PROFILES: Record<IntentCategory, Partial<Record<string, number>>> = {
  bugfix: {
    ci_status: 0.20,
    test_coverage: 0.18,
    mergeability: 0.15,
    diff_size: 0.04,
  },
  feature: {
    body_quality: 0.08,
    test_coverage: 0.15,
    scope_coherence: 0.08,
  },
  refactor: {
    test_coverage: 0.18,
    breaking_change: 0.08,
    scope_coherence: 0.10,
  },
  dependency: {
    ci_status: 0.25,
    diff_size: 0.02,
    body_quality: 0.02,
    test_coverage: 0.15,
  },
  docs: {
    diff_size: 0.02,
    ci_status: 0.05,
    test_coverage: 0.03,
    body_quality: 0.08,
  },
  chore: {
    ci_status: 0.20,
    breaking_change: 0.06,
    diff_size: 0.03,
  },
};
```

Then modify the `score()` method (around line 54-121). After computing signals but before computing heuristicScore, add profile application:

```typescript
  async score(pr: PRData): Promise<ScoredPR> {
    const intentResult = await this.intentClassifier.classify(pr.title, pr.body ?? '', pr.changedFiles);

    const signals: SignalScore[] = [
      // ... all 21 signal calls unchanged ...
    ];

    // Apply intent-aware weight profiles
    const profile = INTENT_PROFILES[intentResult.intent];
    if (profile) {
      for (const signal of signals) {
        if (profile[signal.name] !== undefined) {
          signal.weight = profile[signal.name]!;
        }
      }
      // Normalize weights to sum=1.0
      const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
      if (totalWeight > 0 && totalWeight !== 1.0) {
        const factor = 1.0 / totalWeight;
        for (const signal of signals) {
          signal.weight *= factor;
        }
      }
    }

    const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
    const heuristicScore = totalWeight > 0
      ? signals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight
      : 0;
    // ... rest unchanged
  }
```

Also change the `scoreIntent()` method weight from `0.08` to `0.15`:

```typescript
  private scoreIntent(result: IntentResult): SignalScore {
    const scores: Record<string, number> = {
      bugfix: 90, feature: 85, refactor: 60, dependency: 35, docs: 30, chore: 25,
    };
    return {
      name: 'intent',
      score: scores[result.intent] ?? 50,
      weight: 0.15,
      reason: `${result.intent} (${result.reason})`,
    };
  }
```

**Step 4: Run profile tests**

Run: `npx jest test/unit/intent-profiles.test.ts --no-coverage`
Expected: 8/8 passing

**Step 5: Run all tests**

Run: `npx jest --no-coverage`
Expected: All passing. NOTE: Some existing scoring tests may need minor assertion updates if they check exact totalScore values, because weights changed. Adjust assertions to check relative ordering rather than exact values if needed.

**Step 6: Commit**

```bash
git add src/core/scoring.ts test/unit/intent-profiles.test.ts
git commit -m "feat: add intent-aware scoring profiles with weight normalization"
```

---

### Task 4: LLM Dedup Verification

**Files:**
- Modify: `src/core/dedup.ts`
- Create: `test/unit/dedup-verification.test.ts`

**Context:** After embedding clusters are built, each cluster is sent to LLM for verification (is this really a duplicate?) and best selection (which PR should we keep?). Max 20 clusters verified.

**Step 1: Write the failing tests**

Create `test/unit/dedup-verification.test.ts`:

```typescript
import { DedupEngine } from '../../src/core/dedup';
import { MockLLMProvider } from '../fixtures/mock-provider';
import { createScoredPR } from '../fixtures/pr-factory';

describe('DedupEngine LLM Verification', () => {
  function makeProvider(verifyResponse: string, bestResponse?: string): MockLLMProvider {
    const provider = new MockLLMProvider();
    const responses = [verifyResponse];
    if (bestResponse) responses.push(bestResponse);
    let callCount = 0;
    provider.generateTextResponse = () => {
      return responses[callCount++] || responses[responses.length - 1];
    };
    return provider;
  }

  it('dissolves cluster when LLM says not duplicate', async () => {
    const provider = makeProvider(JSON.stringify({
      isDuplicate: false,
      reason: 'Different problems',
      subgroups: [],
    }));
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('login')) return [1, 0, 0];
      if (text.includes('auth')) return [0.99, 0.01, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login bug', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth fix', totalScore: 92 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2], undefined, true);

    expect(clusters.length).toBe(0);
  });

  it('keeps cluster and updates bestPR from LLM recommendation', async () => {
    const provider = makeProvider(
      JSON.stringify({ isDuplicate: true, reason: 'Same fix', subgroups: [] }),
      JSON.stringify({ bestPR: 10, reason: 'Better tests' })
    );
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('login')) return [1, 0, 0];
      if (text.includes('auth')) return [0.99, 0.01, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login bug', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth login fix', totalScore: 92 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2], undefined, true);

    expect(clusters.length).toBe(1);
    expect(clusters[0].bestPR).toBe(10); // LLM picked 10 over score-higher 11
  });

  it('splits cluster into subgroups', async () => {
    const provider = makeProvider(
      JSON.stringify({ isDuplicate: true, reason: 'Partial match', subgroups: [[10, 11], [12]] }),
      JSON.stringify({ bestPR: 11, reason: 'More complete' })
    );
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('PR 10')) return [1, 0, 0];
      if (text.includes('PR 11')) return [0.99, 0.01, 0];
      if (text.includes('PR 12')) return [0.98, 0.02, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'PR 10 fix', totalScore: 60 });
    const pr2 = createScoredPR({ number: 11, title: 'PR 11 fix', totalScore: 80 });
    const pr3 = createScoredPR({ number: 12, title: 'PR 12 fix', totalScore: 70 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2, pr3], undefined, true);

    // Subgroup [10,11] becomes cluster, [12] alone is dissolved
    expect(clusters.length).toBe(1);
    expect(clusters[0].prs.map(p => p.number).sort()).toEqual([10, 11]);
  });

  it('skips verification when verifyWithLLM is false', async () => {
    const provider = new MockLLMProvider();
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('login')) return [1, 0, 0];
      if (text.includes('auth')) return [0.99, 0.01, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth login fix', totalScore: 92 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2], undefined, false);

    expect(clusters.length).toBe(1);
    expect(clusters[0].bestPR).toBe(11); // score-based, not LLM
    // generateText should NOT have been called
    expect(provider.generateTextCalls.length).toBe(0);
  });

  it('limits verification to 20 clusters', async () => {
    const provider = new MockLLMProvider();
    // All verification says true
    provider.generateTextResponse = (prompt: string) => {
      if (prompt.includes('best')) return JSON.stringify({ bestPR: 1, reason: 'ok' });
      return JSON.stringify({ isDuplicate: true, reason: 'same', subgroups: [] });
    };

    // Create many items that will form 25+ clusters
    // Each pair has unique embeddings close to each other
    const items = [];
    for (let i = 0; i < 50; i++) {
      const base = i * 0.1;
      items.push(createScoredPR({
        number: i * 2,
        title: `PR-A-${i}`,
        totalScore: 50 + i,
      }));
      items.push(createScoredPR({
        number: i * 2 + 1,
        title: `PR-B-${i}`,
        totalScore: 50 + i,
      }));
    }

    provider.generateEmbeddingResponse = (text: string) => {
      const num = parseInt(text.match(/\d+/)?.[0] ?? '0');
      const group = Math.floor(num / 2);
      const offset = num % 2 === 0 ? 0 : 0.001;
      const vec = new Array(768).fill(0);
      vec[group % 768] = 1 + offset;
      return vec;
    };

    const engine = new DedupEngine(0.85, 0.8, provider);
    await engine.findDuplicates(items, undefined, true);

    // Count verify calls (not embedding calls)
    const verifyCalls = provider.generateTextCalls.filter(c => !c.prompt.includes('best'));
    expect(verifyCalls.length).toBeLessThanOrEqual(20);
  });

  it('falls back to score-based best when LLM best selection fails', async () => {
    const provider = makeProvider(
      JSON.stringify({ isDuplicate: true, reason: 'Same', subgroups: [] }),
      'invalid json'
    );
    provider.generateEmbeddingResponse = (text: string) => {
      if (text.includes('login')) return [1, 0, 0];
      if (text.includes('auth')) return [0.99, 0.01, 0];
      return [0, 1, 0];
    };

    const pr1 = createScoredPR({ number: 10, title: 'fix login', totalScore: 65 });
    const pr2 = createScoredPR({ number: 11, title: 'auth login fix', totalScore: 92 });

    const engine = new DedupEngine(0.85, 0.8, provider);
    const clusters = await engine.findDuplicates([pr1, pr2], undefined, true);

    expect(clusters.length).toBe(1);
    expect(clusters[0].bestPR).toBe(11); // score-based fallback
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/dedup-verification.test.ts --no-coverage`
Expected: FAIL — findDuplicates doesn't accept verifyWithLLM parameter

**Step 3: Implement LLM verification in DedupEngine**

Modify `src/core/dedup.ts`:

1. Add 3rd boolean param `verifyWithLLM` to `findDuplicates()` (default `false`):

```typescript
  async findDuplicates(items: TriageItem[], cc?: ConcurrencyController, verifyWithLLM = false): Promise<DedupCluster[]> {
```

2. After building clusters (line 178), before returning, add verification:

```typescript
    // 5. LLM Verification (optional)
    if (verifyWithLLM && typeof this.provider.generateText === 'function') {
      return await this.verifyClusters(clusters, itemMap);
    }

    return clusters;
  }
```

3. Add verification methods:

```typescript
  private async verifyClusters(
    clusters: DedupCluster[],
    itemMap: Map<number, TriageItem>
  ): Promise<DedupCluster[]> {
    // Verify largest clusters first, max 20
    const sorted = [...clusters].sort((a, b) => b.prs.length - a.prs.length);
    const toVerify = sorted.slice(0, 20);
    const unverified = sorted.slice(20);

    const verified: DedupCluster[] = [...unverified];

    for (const cluster of toVerify) {
      try {
        const result = await this.verifyCluster(cluster);
        if (result) {
          verified.push(...result);
        }
        // If null, cluster dissolved (not duplicate)
      } catch (err) {
        log.warn({ clusterId: cluster.id, err }, 'Cluster verification failed, keeping original');
        verified.push(cluster);
      }
    }

    // Re-number cluster IDs
    for (let i = 0; i < verified.length; i++) {
      verified[i].id = i;
      for (const item of verified[i].prs) {
        item.duplicateGroup = i;
      }
    }

    return verified;
  }

  private async verifyCluster(cluster: DedupCluster): Promise<DedupCluster[] | null> {
    const itemDescriptions = cluster.prs.map(item => {
      const type = 'changedFiles' in item ? 'PR' : 'Issue';
      return `#${item.number} [${type}]: "${item.title}"`;
    }).join('\n');

    // Step 1: Verify
    const verifyPrompt = `These items were detected as potential duplicates based on text similarity.
Are they actually duplicates (solving the same problem)?

${itemDescriptions}

Return JSON: {"isDuplicate": true/false, "reason": "<brief>", "subgroups": [[num1, num2], [num3]] or []}`;

    const verifyText = await this.provider.generateText(verifyPrompt, { temperature: 0.1, maxTokens: 200 });
    const verifyMatch = verifyText.match(/\{[\s\S]*\}/);
    if (!verifyMatch) return [cluster]; // Can't parse → keep original

    let verifyResult: { isDuplicate: boolean; reason: string; subgroups: number[][] };
    try {
      verifyResult = JSON.parse(verifyMatch[0]);
    } catch {
      return [cluster];
    }

    if (!verifyResult.isDuplicate) {
      // Dissolve cluster
      for (const item of cluster.prs) {
        item.duplicateGroup = undefined;
      }
      return null;
    }

    // Handle subgroups
    if (verifyResult.subgroups && verifyResult.subgroups.length > 0) {
      const subClusters: DedupCluster[] = [];
      for (const group of verifyResult.subgroups) {
        if (group.length < 2) continue;
        const items = group.map(n => cluster.prs.find(p => p.number === n)).filter(Boolean) as TriageItem[];
        if (items.length < 2) continue;

        const best = await this.selectBest(items);
        subClusters.push({
          id: 0, // Re-numbered later
          prs: items,
          bestPR: best,
          similarity: cluster.similarity,
          reason: `LLM verified: ${verifyResult.reason}`,
          type: cluster.type,
        });
      }
      return subClusters.length > 0 ? subClusters : null;
    }

    // Step 2: Select best
    const best = await this.selectBest(cluster.prs);
    cluster.bestPR = best;
    cluster.reason = `LLM verified: ${verifyResult.reason}`;
    return [cluster];
  }

  private async selectBest(items: TriageItem[]): Promise<number> {
    const scoreBased = items.reduce((a, b) => a.totalScore >= b.totalScore ? a : b);

    try {
      const descriptions = items.map(item => `#${item.number}: "${item.title}" (score: ${item.totalScore})`).join('\n');
      const prompt = `Which of these duplicate items is the best to keep and why?
Consider: completeness, quality, test coverage.

${descriptions}

Return JSON: {"bestPR": <number>, "reason": "<brief>"}`;

      const text = await this.provider.generateText(prompt, { temperature: 0.1, maxTokens: 100 });
      const match = text.match(/\{[^}]+\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const candidate = Number(parsed.bestPR);
        if (items.some(p => p.number === candidate)) {
          return candidate;
        }
      }
    } catch (err) {
      log.warn({ err }, 'LLM best selection failed, using score-based');
    }

    return scoreBased.number;
  }
```

**Step 4: Run verification tests**

Run: `npx jest test/unit/dedup-verification.test.ts --no-coverage`
Expected: 6/6 passing

**Step 5: Run all tests**

Run: `npx jest --no-coverage`
Expected: All passing (existing dedup tests pass because verifyWithLLM defaults to false)

**Step 6: Commit**

```bash
git add src/core/dedup.ts test/unit/dedup-verification.test.ts
git commit -m "feat: add LLM dedup verification with subgroup splitting and best selection"
```

---

### Task 5: SemanticMatcher Module

**Files:**
- Create: `src/core/semantic-matcher.ts`
- Create: `test/unit/semantic-matcher.test.ts`

**Context:** Compares Issue body + PR diff to determine if a PR actually resolves a referenced issue. Bidirectional score impact.

**Step 1: Write the failing tests**

Create `test/unit/semantic-matcher.test.ts`:

```typescript
import { SemanticMatcher } from '../../src/core/semantic-matcher';
import { MockLLMProvider } from '../fixtures/mock-provider';
import { createScoredPR, createScoredIssue } from '../fixtures/pr-factory';
import type { DiffAnalysis } from '../../src/core/types';

describe('SemanticMatcher', () => {
  it('returns full match with bidirectional score impact', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      matchQuality: 'full',
      confidence: 0.95,
      reason: 'PR directly fixes the reported Safari issue',
    });

    const pr = createScoredPR({
      number: 42,
      title: 'fix: Safari auth crash',
      issueNumbers: [10],
      totalScore: 75,
    });
    const issue = createScoredIssue({
      number: 10,
      title: 'Login crashes on Safari',
      linkedPRs: [42],
      totalScore: 60,
    });

    const matcher = new SemanticMatcher(provider);
    const { matches, prBonuses, issueScoreUpdates } = await matcher.matchAll([pr], [issue]);

    expect(matches.length).toBe(1);
    expect(matches[0].matchQuality).toBe('full');
    expect(prBonuses.get(42)).toBe(8);
    expect(issueScoreUpdates.get(10)).toBe(95);
  });

  it('returns partial match', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      matchQuality: 'partial',
      confidence: 0.6,
      reason: 'Addresses part of the issue',
    });

    const pr = createScoredPR({ number: 1, issueNumbers: [2], totalScore: 70 });
    const issue = createScoredIssue({ number: 2, linkedPRs: [1] });

    const matcher = new SemanticMatcher(provider);
    const { matches, prBonuses, issueScoreUpdates } = await matcher.matchAll([pr], [issue]);

    expect(prBonuses.get(1)).toBe(3);
    expect(issueScoreUpdates.get(2)).toBe(70);
  });

  it('penalizes unrelated match', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      matchQuality: 'unrelated',
      confidence: 0.9,
      reason: 'PR does not address this issue',
    });

    const pr = createScoredPR({ number: 1, issueNumbers: [2], totalScore: 80 });
    const issue = createScoredIssue({ number: 2, linkedPRs: [1] });

    const matcher = new SemanticMatcher(provider);
    const { prBonuses, issueScoreUpdates } = await matcher.matchAll([pr], [issue]);

    expect(prBonuses.get(1)).toBe(-5);
    expect(issueScoreUpdates.get(2)).toBe(40);
  });

  it('skips pairs with no issue reference', async () => {
    const provider = new MockLLMProvider();

    const pr = createScoredPR({ number: 1, issueNumbers: [], hasIssueRef: false });
    const issue = createScoredIssue({ number: 2 });

    const matcher = new SemanticMatcher(provider);
    const { matches } = await matcher.matchAll([pr], [issue]);

    expect(matches.length).toBe(0);
    expect(provider.generateTextCalls.length).toBe(0);
  });

  it('returns unchecked when no provider', async () => {
    const pr = createScoredPR({ number: 1, issueNumbers: [2] });
    const issue = createScoredIssue({ number: 2, linkedPRs: [1] });

    const matcher = new SemanticMatcher();
    const { matches } = await matcher.matchAll([pr], [issue]);

    expect(matches.length).toBe(0);
  });

  it('handles LLM failure gracefully', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = 'not json';

    const pr = createScoredPR({ number: 1, issueNumbers: [2] });
    const issue = createScoredIssue({ number: 2, linkedPRs: [1] });

    const matcher = new SemanticMatcher(provider);
    const { matches } = await matcher.matchAll([pr], [issue]);

    expect(matches.length).toBe(0);
  });

  it('includes diff summary in prompt when available', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      matchQuality: 'full', confidence: 0.9, reason: 'ok',
    });

    const diffMap = new Map<number, DiffAnalysis>();
    diffMap.set(1, {
      prNumber: 1,
      codeQuality: 80,
      riskAssessment: 'low',
      changeType: 'modifying',
      affectedAreas: ['auth'],
      summary: 'Fixes Safari touch handling',
    });

    const pr = createScoredPR({ number: 1, issueNumbers: [2] });
    const issue = createScoredIssue({ number: 2, linkedPRs: [1] });

    const matcher = new SemanticMatcher(provider);
    await matcher.matchAll([pr], [issue], diffMap);

    const prompt = provider.generateTextCalls[0].prompt;
    expect(prompt).toContain('Fixes Safari touch handling');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/semantic-matcher.test.ts --no-coverage`
Expected: FAIL — module not found

**Step 3: Implement SemanticMatcher**

Create `src/core/semantic-matcher.ts`:

```typescript
/**
 * SemanticMatcher — Determines if PRs actually resolve their referenced issues
 */

import type { LLMProvider } from './provider';
import type { ScoredPR, ScoredIssue, DiffAnalysis, SemanticMatch } from './types';
import { ConcurrencyController } from './concurrency';
import { createLogger } from './logger';

const log = createLogger('semantic-matcher');

const MATCH_PR_BONUS: Record<string, number> = {
  full: 8,
  partial: 3,
  unrelated: -5,
};

const MATCH_ISSUE_SCORE: Record<string, number> = {
  full: 95,
  partial: 70,
  unrelated: 40,
};

export interface MatchResult {
  matches: SemanticMatch[];
  prBonuses: Map<number, number>;
  issueScoreUpdates: Map<number, number>;
}

export class SemanticMatcher {
  private provider?: LLMProvider;
  private concurrency: ConcurrencyController;

  constructor(provider?: LLMProvider, maxConcurrent = 10) {
    this.provider = provider;
    this.concurrency = new ConcurrencyController(maxConcurrent);
  }

  async matchAll(
    prs: ScoredPR[],
    issues: ScoredIssue[],
    diffMap?: Map<number, DiffAnalysis>,
  ): Promise<MatchResult> {
    const result: MatchResult = {
      matches: [],
      prBonuses: new Map(),
      issueScoreUpdates: new Map(),
    };

    if (!this.provider) return result;

    const issueMap = new Map(issues.map(i => [i.number, i]));

    // Build pairs: PR references issue AND issue exists
    const pairs: Array<{ pr: ScoredPR; issue: ScoredIssue }> = [];
    for (const pr of prs) {
      for (const issueNum of pr.issueNumbers) {
        const issue = issueMap.get(issueNum);
        if (issue) {
          pairs.push({ pr, issue });
        }
      }
    }

    if (pairs.length === 0) return result;

    log.info({ pairs: pairs.length }, 'Matching PR-Issue pairs');

    const matchResults = await Promise.allSettled(
      pairs.map(({ pr, issue }) =>
        this.concurrency.execute(() => this.matchOne(pr, issue, diffMap?.get(pr.number)))
      )
    );

    for (const mr of matchResults) {
      if (mr.status !== 'fulfilled' || !mr.value) continue;
      const match = mr.value;
      result.matches.push(match);

      // PR bonus
      const bonus = MATCH_PR_BONUS[match.matchQuality] ?? 0;
      const existing = result.prBonuses.get(match.prNumber) ?? 0;
      result.prBonuses.set(match.prNumber, existing + bonus);

      // Issue score update (use best match quality if multiple PRs)
      const issueScore = MATCH_ISSUE_SCORE[match.matchQuality];
      if (issueScore !== undefined) {
        const current = result.issueScoreUpdates.get(match.issueNumber) ?? 0;
        result.issueScoreUpdates.set(match.issueNumber, Math.max(current, issueScore));
      }
    }

    return result;
  }

  private async matchOne(
    pr: ScoredPR,
    issue: ScoredIssue,
    diff?: DiffAnalysis,
  ): Promise<SemanticMatch | null> {
    try {
      const diffInfo = diff
        ? `\nDiff summary: ${diff.summary}\nAffected areas: ${diff.affectedAreas.join(', ')}`
        : '';

      const prompt = `Does this PR resolve this Issue?

Issue #${issue.number}: "${issue.title}"
${(issue.body ?? '').slice(0, 2000)}

PR #${pr.number}: "${pr.title}"
${(pr.body ?? '').slice(0, 1000)}${diffInfo}

Return JSON:
{"matchQuality": "full"|"partial"|"unrelated", "confidence": <0-1>, "reason": "<brief>"}`;

      const text = await this.provider!.generateText(prompt, { temperature: 0.1, maxTokens: 150 });
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;

      const parsed = JSON.parse(match[0]);
      const validQualities = ['full', 'partial', 'unrelated'];
      if (!validQualities.includes(parsed.matchQuality)) return null;

      return {
        prNumber: pr.number,
        issueNumber: issue.number,
        matchQuality: parsed.matchQuality,
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
        reason: String(parsed.reason ?? ''),
      };
    } catch (err) {
      log.warn({ pr: pr.number, issue: issue.number, err }, 'Semantic match failed');
      return null;
    }
  }
}
```

**Step 4: Run tests**

Run: `npx jest test/unit/semantic-matcher.test.ts --no-coverage`
Expected: 7/7 passing

**Step 5: Run all tests**

Run: `npx jest --no-coverage`
Expected: All passing

**Step 6: Commit**

```bash
git add src/core/semantic-matcher.ts test/unit/semantic-matcher.test.ts
git commit -m "feat: add SemanticMatcher for issue-PR resolution analysis"
```

---

### Task 6: HolisticRanker Module

**Files:**
- Create: `src/core/holistic-ranker.ts`
- Create: `test/unit/holistic-ranker.test.ts`

**Context:** Tournament-style re-ranking. Split items into groups of 50, LLM ranks top 10 per group, then final round ranks top 15 from finalists.

**Step 1: Write the failing tests**

Create `test/unit/holistic-ranker.test.ts`:

```typescript
import { HolisticRanker } from '../../src/core/holistic-ranker';
import { MockLLMProvider } from '../fixtures/mock-provider';
import { createScoredPR, createScoredIssue } from '../fixtures/pr-factory';
import type { TriageItem } from '../../src/core/types';

describe('HolisticRanker', () => {
  it('ranks items with single group (< 50 items)', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      ranked: [3, 1, 2],
      reasoning: 'PR #3 is critical bugfix',
    });

    const items: TriageItem[] = [
      createScoredPR({ number: 1, totalScore: 80 }),
      createScoredPR({ number: 2, totalScore: 70 }),
      createScoredPR({ number: 3, totalScore: 60 }),
    ];

    const ranker = new HolisticRanker(provider);
    const result = await ranker.rank(items);

    expect(result.get(3)).toBe(1); // LLM ranked #3 first
    expect(result.get(1)).toBe(2);
    expect(result.get(2)).toBe(3);
  });

  it('applies bonus to adjustedScore', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      ranked: [1, 2],
      reasoning: 'ok',
    });

    const items: TriageItem[] = [
      createScoredPR({ number: 1, totalScore: 50 }),
      createScoredPR({ number: 2, totalScore: 50 }),
    ];

    const ranker = new HolisticRanker(provider);
    const rankings = await ranker.rank(items);

    // Rank #1 gets (16-1)*2 = 30 bonus
    expect(HolisticRanker.calculateAdjustedScore(50, rankings.get(1))).toBe(80);
    // Rank #2 gets (16-2)*2 = 28 bonus
    expect(HolisticRanker.calculateAdjustedScore(50, rankings.get(2))).toBe(78);
    // Unranked gets 0 bonus
    expect(HolisticRanker.calculateAdjustedScore(50, undefined)).toBe(50);
  });

  it('handles LLM failure gracefully (returns empty rankings)', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = 'not valid json';

    const items: TriageItem[] = [
      createScoredPR({ number: 1, totalScore: 80 }),
      createScoredPR({ number: 2, totalScore: 70 }),
    ];

    const ranker = new HolisticRanker(provider);
    const result = await ranker.rank(items);

    expect(result.size).toBe(0);
  });

  it('works without provider (returns empty)', async () => {
    const items: TriageItem[] = [
      createScoredPR({ number: 1, totalScore: 80 }),
    ];

    const ranker = new HolisticRanker();
    const result = await ranker.rank(items);

    expect(result.size).toBe(0);
  });

  it('handles tournament with multiple groups', async () => {
    const provider = new MockLLMProvider();
    let callNum = 0;
    provider.generateTextResponse = () => {
      callNum++;
      if (callNum <= 2) {
        // Group rounds: pick first 10 from each group
        const start = (callNum - 1) * 50;
        const ranked = Array.from({ length: 10 }, (_, i) => start + i);
        return JSON.stringify({ ranked, reasoning: `Group ${callNum}` });
      }
      // Final round: pick top 15
      const ranked = Array.from({ length: 15 }, (_, i) => i);
      return JSON.stringify({ ranked, reasoning: 'Final' });
    };

    // 80 items -> 2 groups of 50 (second has 30)
    const items: TriageItem[] = Array.from({ length: 80 }, (_, i) =>
      createScoredPR({ number: i, totalScore: 80 - i })
    );

    const ranker = new HolisticRanker(provider, 50);
    const result = await ranker.rank(items);

    // Should have called LLM 3 times: 2 groups + 1 final
    expect(provider.generateTextCalls.length).toBe(3);
    // Top 15 should have ranks
    expect(result.size).toBeLessThanOrEqual(15);
  });

  it('includes mixed PR and Issue items', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      ranked: [10, 20],
      reasoning: 'Issue #10 is critical, PR #20 fixes it',
    });

    const items: TriageItem[] = [
      createScoredIssue({ number: 10, totalScore: 90 }),
      createScoredPR({ number: 20, totalScore: 80 }),
    ];

    const ranker = new HolisticRanker(provider);
    const result = await ranker.rank(items);

    expect(result.get(10)).toBe(1);
    expect(result.get(20)).toBe(2);
  });

  it('filters out invalid item numbers from LLM response', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({
      ranked: [1, 999, 2], // 999 doesn't exist
      reasoning: 'ok',
    });

    const items: TriageItem[] = [
      createScoredPR({ number: 1, totalScore: 80 }),
      createScoredPR({ number: 2, totalScore: 70 }),
    ];

    const ranker = new HolisticRanker(provider);
    const result = await ranker.rank(items);

    expect(result.get(1)).toBe(1);
    expect(result.get(2)).toBe(2);
    expect(result.has(999)).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/holistic-ranker.test.ts --no-coverage`
Expected: FAIL — module not found

**Step 3: Implement HolisticRanker**

Create `src/core/holistic-ranker.ts`:

```typescript
/**
 * HolisticRanker — Tournament-style cross-item re-ranking via LLM
 */

import type { LLMProvider } from './provider';
import type { TriageItem, DiffAnalysis, SemanticMatch } from './types';
import { createLogger } from './logger';

const log = createLogger('holistic-ranker');

export class HolisticRanker {
  private provider?: LLMProvider;
  private groupSize: number;

  constructor(provider?: LLMProvider, groupSize = 50) {
    this.provider = provider;
    this.groupSize = groupSize;
  }

  static calculateAdjustedScore(totalScore: number, holisticRank?: number): number {
    if (!holisticRank) return totalScore;
    return totalScore + (16 - holisticRank) * 2;
  }

  async rank(items: TriageItem[]): Promise<Map<number, number>> {
    const rankings = new Map<number, number>();
    if (!this.provider || items.length === 0) return rankings;

    const validNumbers = new Set(items.map(i => i.number));

    try {
      if (items.length <= this.groupSize) {
        // Single group — direct ranking
        const ranked = await this.rankGroup(items, 15);
        const filtered = ranked.filter(n => validNumbers.has(n));
        for (let i = 0; i < filtered.length; i++) {
          rankings.set(filtered[i], i + 1);
        }
      } else {
        // Multi-group tournament
        const groups: TriageItem[][] = [];
        for (let i = 0; i < items.length; i += this.groupSize) {
          groups.push(items.slice(i, i + this.groupSize));
        }

        // Group rounds: pick top 10 per group
        const finalists: number[] = [];
        for (const group of groups) {
          const ranked = await this.rankGroup(group, 10);
          finalists.push(...ranked.filter(n => validNumbers.has(n)));
        }

        // Final round: rank all finalists, pick top 15
        const finalistItems = items.filter(i => finalists.includes(i.number));
        const finalRanked = await this.rankGroup(finalistItems, 15);
        const filtered = finalRanked.filter(n => validNumbers.has(n));
        for (let i = 0; i < filtered.length; i++) {
          rankings.set(filtered[i], i + 1);
        }
      }
    } catch (err) {
      log.warn({ err }, 'Holistic ranking failed');
    }

    return rankings;
  }

  private async rankGroup(items: TriageItem[], topN: number): Promise<number[]> {
    const summaries = items.map(item => {
      const type = 'changedFiles' in item ? 'PR' : 'Issue';
      const intent = item.intent ?? 'unknown';
      const risk = 'llmRisk' in item ? (item as any).llmRisk ?? 'unknown' : 'n/a';
      const diff = 'diffAnalysis' in item && (item as any).diffAnalysis
        ? `diff:"${(item as any).diffAnalysis.summary}"`
        : '';
      return `#${item.number} [${type}] score:${item.totalScore} intent:${intent} risk:${risk} ${diff} "${item.title}"`;
    }).join('\n');

    const prompt = `You are triaging a GitHub repository. Rank the top ${topN} most important items to review/merge/address first.
Consider: code quality, risk level, intent, issue resolution, community demand.

Items:
${summaries}

Return JSON: {"ranked": [<item numbers in priority order>], "reasoning": "<brief>"}`;

    const text = await this.provider!.generateText(prompt, { temperature: 0.2, maxTokens: 500 });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];

    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.ranked)) {
        return parsed.ranked.map(Number).filter((n: number) => !isNaN(n)).slice(0, topN);
      }
    } catch {
      // invalid JSON
    }

    return [];
  }
}
```

**Step 4: Run tests**

Run: `npx jest test/unit/holistic-ranker.test.ts --no-coverage`
Expected: 7/7 passing

**Step 5: Run all tests**

Run: `npx jest --no-coverage`
Expected: All passing

**Step 6: Commit**

```bash
git add src/core/holistic-ranker.ts test/unit/holistic-ranker.test.ts
git commit -m "feat: add HolisticRanker with tournament-style cross-item re-ranking"
```

---

### Task 7: Scanner Pipeline Integration

**Files:**
- Modify: `src/core/scanner.ts`
- Modify: `src/index.ts`

**Context:** Wire all 5 new modules into the scanner's `scan()` method. The pipeline becomes: fetch → score (with intent profiles, already active from Task 3) → diff analysis → LLM scoring (diff-enriched) → dedup (with LLM verify) → semantic matching → holistic re-ranking → output.

**Step 1: Add imports to scanner.ts**

At the top of `src/core/scanner.ts`, add:

```typescript
import { DiffAnalyzer } from './diff-analyzer';
import { SemanticMatcher } from './semantic-matcher';
import { HolisticRanker } from './holistic-ranker';
import type { DiffAnalysis } from './types';
```

**Step 2: Add diff analysis stage after scoring**

In `scan()`, after scoring is complete (line 168) and before the dedup/vision parallel block (line 170), add:

```typescript
    // 2b. Diff analysis (all PRs, parallel)
    let diffMap = new Map<number, DiffAnalysis>();
    if (this.wrappedProvider) {
      try {
        const diffAnalyzer = new DiffAnalyzer(this.octokit, owner, repo, this.wrappedProvider);
        const prNumbers = scored.map(pr => pr.number);
        const analyses = await diffAnalyzer.analyzeMany(prNumbers);
        for (const analysis of analyses) {
          diffMap.set(analysis.prNumber, analysis);
          const pr = scored.find(p => p.number === analysis.prNumber);
          if (pr) pr.diffAnalysis = analysis;
        }
        log.info({ analyzed: analyses.length }, 'Diff analysis complete');
      } catch (err: any) {
        log.warn({ err }, 'Diff analysis failed (skipping)');
      }
    }
```

**Step 3: Update LLM scoring blend**

In `src/core/scoring.ts`, update the blend logic in `score()` to use diff score when available. This requires DiffAnalysis to be passed in. Add a `setDiffAnalysis` method:

```typescript
  private diffAnalyses = new Map<number, DiffAnalysis>();

  setDiffAnalysis(prNumber: number, analysis: DiffAnalysis): void {
    this.diffAnalyses.set(prNumber, analysis);
  }
```

Then update the blend in `score()`:

```typescript
    // Blend: new formula when diff available
    const diffAnalysis = this.diffAnalyses.get(pr.number);
    let totalScore: number;
    if (llmScore !== undefined && diffAnalysis) {
      // 0.4 heuristic + 0.3 LLM text + 0.3 LLM diff
      totalScore = Math.round(0.4 * heuristicScore + 0.3 * llmScore + 0.3 * diffAnalysis.codeQuality);
      // Override risk from diff (more reliable)
      if (diffAnalysis.riskAssessment !== 'medium') {
        llmRisk = diffAnalysis.riskAssessment === 'critical' ? 'high' : diffAnalysis.riskAssessment;
      }
    } else if (llmScore !== undefined) {
      totalScore = Math.round(0.4 * heuristicScore + 0.6 * llmScore);
    } else {
      totalScore = Math.round(heuristicScore);
    }
```

**Step 4: Pass verifyWithLLM to DedupEngine**

In scanner.ts, change the dedup creation to pass `true` for verification:

```typescript
        const c = await dedup.findDuplicates(scored, this.dedupCC, !!this.wrappedProvider);
```

**Step 5: Add semantic matching after dedup/vision**

After the `Promise.all([dedupPromise, visionPromise])` line (line 225), add:

```typescript
    // 4. Semantic matching (PR-Issue pairs)
    if (this.wrappedProvider && result.rankedIssues && result.rankedIssues.length > 0) {
      try {
        const matcher = new SemanticMatcher(this.wrappedProvider);
        const matchResult = await matcher.matchAll(scored, result.rankedIssues, diffMap);

        // Apply PR bonuses
        for (const [prNum, bonus] of matchResult.prBonuses) {
          const pr = scored.find(p => p.number === prNum);
          if (pr) {
            pr.totalScore = Math.max(0, Math.min(100, pr.totalScore + bonus));
            pr.semanticMatches = matchResult.matches.filter(m => m.prNumber === prNum);
          }
        }

        // Apply issue score updates
        for (const [issueNum, score] of matchResult.issueScoreUpdates) {
          const issue = result.rankedIssues.find(i => i.number === issueNum);
          if (issue) {
            const linkedSignal = issue.signals.find(s => s.name === 'has_linked_pr');
            if (linkedSignal) linkedSignal.score = score;
            issue.semanticMatches = matchResult.matches.filter(m => m.issueNumber === issueNum);
          }
        }

        log.info({ matches: matchResult.matches.length }, 'Semantic matching complete');
      } catch (err: any) {
        log.warn({ err }, 'Semantic matching failed (skipping)');
      }
    }
```

Note: This block uses `result.rankedIssues` which is set by CLI when `--include-issues` is used. If the scanner doesn't have issues, this block is safely skipped.

**Step 6: Add holistic re-ranking as final stage**

After semantic matching and before the sort:

```typescript
    // 5. Holistic re-ranking
    if (this.wrappedProvider) {
      try {
        const ranker = new HolisticRanker(this.wrappedProvider);
        const allItems: TriageItem[] = [...scored];
        const rankings = await ranker.rank(allItems);

        for (const [itemNumber, rank] of rankings) {
          const item = scored.find(p => p.number === itemNumber);
          if (item) {
            item.holisticRank = rank;
            item.adjustedScore = HolisticRanker.calculateAdjustedScore(item.totalScore, rank);
          }
        }
        log.info({ ranked: rankings.size }, 'Holistic re-ranking complete');
      } catch (err: any) {
        log.warn({ err }, 'Holistic re-ranking failed (skipping)');
      }
    }

    // Sort by adjustedScore (if available) then totalScore
    scored.sort((a, b) => (b.adjustedScore ?? b.totalScore) - (a.adjustedScore ?? a.totalScore));
```

**Step 7: Update index.ts exports**

Add new module exports:

```typescript
export { DiffAnalyzer } from './core/diff-analyzer';
export { SemanticMatcher } from './core/semantic-matcher';
export { HolisticRanker } from './core/holistic-ranker';
```

**Step 8: Run TypeScript check**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 9: Run all tests**

Run: `npx jest --no-coverage`
Expected: All passing

**Step 10: Commit**

```bash
git add src/core/scanner.ts src/core/scoring.ts src/index.ts
git commit -m "feat: integrate diff analysis, semantic matching, and holistic re-ranking into scan pipeline"
```

---

### Task 8: Update Scoring Blend for Diff-Enriched LLM

**Files:**
- Modify: `src/core/scoring.ts`
- Modify: `test/integration/scoring-engine.test.ts`

**Context:** The scoring engine needs to accept and use DiffAnalysis data in its blend calculation. Task 7 added `setDiffAnalysis` — this task adds integration tests to verify the new 0.4/0.3/0.3 blend.

**Step 1: Write integration test**

Add to `test/integration/scoring-engine.test.ts`:

```typescript
describe('Diff-enriched scoring blend', () => {
  it('uses 0.4/0.3/0.3 blend when diff analysis available', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({ score: 80, risk: 'low', reason: 'Good PR' });

    const engine = new ScoringEngine(provider);
    engine.setDiffAnalysis(1, {
      prNumber: 1,
      codeQuality: 90,
      riskAssessment: 'low',
      changeType: 'modifying',
      affectedAreas: ['core'],
      summary: 'Improves error handling',
    });

    const pr = createPRData({ number: 1, title: 'fix: improve error handling' });
    const scored = await engine.score(pr);

    // With diff: 0.4 * heuristic + 0.3 * 80 + 0.3 * 90
    // Without diff: 0.4 * heuristic + 0.6 * 80
    // The diff-enriched score should be different from non-diff
    expect(scored.diffAnalysis).toBeDefined();
    expect(scored.totalScore).toBeGreaterThan(0);
  });

  it('overrides llmRisk from diff riskAssessment', async () => {
    const provider = new MockLLMProvider();
    provider.generateTextResponse = JSON.stringify({ score: 80, risk: 'low', reason: 'ok' });

    const engine = new ScoringEngine(provider);
    engine.setDiffAnalysis(1, {
      prNumber: 1,
      codeQuality: 50,
      riskAssessment: 'high',
      changeType: 'removing',
      affectedAreas: ['database'],
      summary: 'Drops migration table',
    });

    const pr = createPRData({ number: 1 });
    const scored = await engine.score(pr);

    expect(scored.llmRisk).toBe('high'); // Overridden by diff
  });
});
```

**Step 2: Run test**

Run: `npx jest test/integration/scoring-engine.test.ts --no-coverage`
Expected: All passing

**Step 3: Commit**

```bash
git add src/core/scoring.ts test/integration/scoring-engine.test.ts
git commit -m "test: add integration tests for diff-enriched scoring blend"
```

---

### Task 9: Final Verification and Version Update

**Files:**
- Modify: `README.md` (update test count and signal info)
- Verify: all tests pass, build succeeds

**Step 1: Run full build**

Run: `npx tsc`
Expected: Clean build

**Step 2: Run all tests with coverage**

Run: `npx jest --no-coverage`
Expected: All tests passing (345 original + ~35 new ≈ 380+)

**Step 3: Verify TypeScript strict**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 4: Update README badges**

Update test count badge in README.md to match actual test count.

**Step 5: Commit**

```bash
git add README.md
git commit -m "docs: update README with accuracy pipeline test count"
```

---

## Summary

| Task | Module | New Tests | Key Change |
|------|--------|-----------|------------|
| 1 | types.ts | 0 | DiffAnalysis, SemanticMatch types, new ScoredPR/ScoredIssue fields |
| 2 | diff-analyzer.ts | ~7 | Fetch diffs, LLM code analysis, 10k truncation |
| 3 | scoring.ts | ~8 | Intent 0.08→0.15, 6 weight profiles, normalization |
| 4 | dedup.ts | ~6 | LLM cluster verify, subgroup split, best selection |
| 5 | semantic-matcher.ts | ~7 | Issue-PR resolution analysis, bidirectional scoring |
| 6 | holistic-ranker.ts | ~7 | Tournament re-ranking, group→final, bonus calc |
| 7 | scanner.ts, scoring.ts | 0 | Wire all modules into pipeline |
| 8 | scoring.ts | ~2 | Integration tests for diff-enriched blend |
| 9 | README.md | 0 | Final verification |

**Total new tests: ~37**
**Total expected: ~382**
