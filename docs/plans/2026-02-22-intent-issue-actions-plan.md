# Intent Analysis + Issue Triage + Auto-Actions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add intent classification (21st signal), full issue triage with cross-type dedup, and auto-actions (close dupes, close spam, merge, label) to make Treliq actionable at 3000+ PR/Issue scale.

**Architecture:** Three features built sequentially. Intent classifier is a standalone module used by both PR and Issue scoring. Issue triage mirrors PR pipeline (fetch via GraphQL, score with 12 signals, embed+dedup). Auto-actions engine takes scored results and executes close/merge/label with dry-run safety.

**Tech Stack:** TypeScript, Octokit REST+GraphQL, Jest, Pino logging

---

### Task 1: Add Intent Types and IntentClassifier Module

**Files:**
- Modify: `src/core/types.ts` (add intent field to ScoredPR, add IssueData/ScoredIssue interfaces)
- Create: `src/core/intent.ts`
- Create: `test/unit/intent.test.ts`
- Modify: `test/fixtures/pr-factory.ts` (add intent to createScoredPR, add createIssueData/createScoredIssue)
- Modify: `test/fixtures/mock-provider.ts` (no changes needed, already supports configurable responses)

**Context:** `src/core/types.ts` has `ScoredPR` at lines 64-77. We add `intent?: string` field. We also add the full IssueData and ScoredIssue types now (used by Task 5+).

**Step 1: Add types to src/core/types.ts**

Add to ScoredPR interface (after line 77, before closing brace):
```typescript
  intent?: 'bugfix' | 'feature' | 'refactor' | 'dependency' | 'docs' | 'chore';
```

Add new interfaces after ScoredPR:
```typescript
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
}
```

**Step 2: Write the tests for IntentClassifier**

Create `test/unit/intent.test.ts`:
```typescript
import { IntentClassifier } from '../../src/core/intent';
import { MockLLMProvider } from '../fixtures/mock-provider';
import { createPRData } from '../fixtures/pr-factory';

describe('IntentClassifier', () => {
  describe('classifyFromTitle (conventional commit)', () => {
    it('detects bugfix from fix: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('fix: resolve null pointer in auth');
      expect(result).toEqual({ intent: 'bugfix', confidence: 1.0, reason: 'Conventional commit: fix' });
    });

    it('detects feature from feat: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('feat: add dark mode support');
      expect(result).toEqual({ intent: 'feature', confidence: 1.0, reason: 'Conventional commit: feat' });
    });

    it('detects refactor from refactor: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('refactor(auth): extract service layer');
      expect(result).toEqual({ intent: 'refactor', confidence: 1.0, reason: 'Conventional commit: refactor' });
    });

    it('detects dependency from chore(deps): prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('chore(deps): bump lodash from 4.17.20 to 4.17.21');
      expect(result).toEqual({ intent: 'dependency', confidence: 1.0, reason: 'Conventional commit: chore(deps)' });
    });

    it('detects docs from docs: prefix', () => {
      const classifier = new IntentClassifier();
      const result = classifier.classifyFromTitle('docs: update API reference');
      expect(result).toEqual({ intent: 'docs', confidence: 1.0, reason: 'Conventional commit: docs' });
    });

    it('detects chore from ci:/build:/style:/test: prefixes', () => {
      const classifier = new IntentClassifier();
      expect(classifier.classifyFromTitle('ci: fix GitHub Actions workflow').intent).toBe('chore');
      expect(classifier.classifyFromTitle('build: update webpack config').intent).toBe('chore');
      expect(classifier.classifyFromTitle('test: add unit tests for auth').intent).toBe('chore');
    });

    it('returns null for non-conventional titles', () => {
      const classifier = new IntentClassifier();
      expect(classifier.classifyFromTitle('Update the login page')).toBeNull();
      expect(classifier.classifyFromTitle('Bump dependencies')).toBeNull();
    });
  });

  describe('classifyFromHeuristic (keyword fallback)', () => {
    it('detects dependency from bump/update keywords', () => {
      const classifier = new IntentClassifier();
      const pr = createPRData({ title: 'Bump lodash to 4.17.21', changedFiles: ['package.json', 'package-lock.json'] });
      const result = classifier.classifyFromHeuristic(pr.title, pr.changedFiles);
      expect(result.intent).toBe('dependency');
    });

    it('detects docs from all-docs files', () => {
      const classifier = new IntentClassifier();
      const pr = createPRData({ title: 'Update getting started guide', changedFiles: ['README.md', 'docs/setup.md'] });
      const result = classifier.classifyFromHeuristic(pr.title, pr.changedFiles);
      expect(result.intent).toBe('docs');
    });

    it('detects bugfix from fix keywords', () => {
      const classifier = new IntentClassifier();
      const pr = createPRData({ title: 'Fix crash on login page', changedFiles: ['src/auth.ts'] });
      const result = classifier.classifyFromHeuristic(pr.title, pr.changedFiles);
      expect(result.intent).toBe('bugfix');
    });

    it('defaults to feature for unknown patterns', () => {
      const classifier = new IntentClassifier();
      const pr = createPRData({ title: 'Add new dashboard component', changedFiles: ['src/dashboard.tsx'] });
      const result = classifier.classifyFromHeuristic(pr.title, pr.changedFiles);
      expect(result.intent).toBe('feature');
    });
  });

  describe('classifyWithLLM', () => {
    it('parses valid LLM JSON response', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"intent": "bugfix", "confidence": 0.95, "reason": "Fixes null pointer"}';
      const classifier = new IntentClassifier(provider);
      const result = await classifier.classifyWithLLM('Fix null pointer', 'Resolves crash', ['src/auth.ts']);
      expect(result).toEqual({ intent: 'bugfix', confidence: 0.95, reason: 'Fixes null pointer' });
    });

    it('falls back to heuristic on LLM failure', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = () => { throw new Error('LLM down'); };
      const classifier = new IntentClassifier(provider);
      const result = await classifier.classifyWithLLM('fix: auth crash', 'Fixes auth', ['src/auth.ts']);
      expect(result.intent).toBe('bugfix');
    });

    it('falls back on invalid JSON', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = 'not json at all';
      const classifier = new IntentClassifier(provider);
      const result = await classifier.classifyWithLLM('Add new feature', '', ['src/new.ts']);
      expect(result).toBeDefined();
      expect(result.intent).toBeDefined();
    });
  });

  describe('classify (full pipeline)', () => {
    it('uses conventional commit first, skips LLM', async () => {
      const provider = new MockLLMProvider();
      const classifier = new IntentClassifier(provider);
      const result = await classifier.classify('feat: add dark mode', '', []);
      expect(result.intent).toBe('feature');
      expect(result.confidence).toBe(1.0);
      expect(provider.generateTextCalls).toHaveLength(0);
    });

    it('falls through to LLM for non-conventional titles', async () => {
      const provider = new MockLLMProvider();
      provider.generateTextResponse = '{"intent": "refactor", "confidence": 0.88, "reason": "Restructuring code"}';
      const classifier = new IntentClassifier(provider);
      const result = await classifier.classify('Restructure the auth module', '', ['src/auth.ts']);
      expect(result.intent).toBe('refactor');
      expect(provider.generateTextCalls).toHaveLength(1);
    });

    it('works without LLM provider (heuristic only)', async () => {
      const classifier = new IntentClassifier();
      const result = await classifier.classify('Fix login crash', '', ['src/auth.ts']);
      expect(result.intent).toBe('bugfix');
    });
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `npx jest test/unit/intent.test.ts --no-coverage`
Expected: FAIL (IntentClassifier module not found)

**Step 4: Implement IntentClassifier**

Create `src/core/intent.ts`:
```typescript
import type { LLMProvider } from './provider';
import { createLogger } from './logger';

const log = createLogger('intent');

export type IntentCategory = 'bugfix' | 'feature' | 'refactor' | 'dependency' | 'docs' | 'chore';

export interface IntentResult {
  intent: IntentCategory;
  confidence: number;
  reason: string;
}

const CONVENTIONAL_MAP: Record<string, IntentCategory> = {
  fix: 'bugfix',
  hotfix: 'bugfix',
  feat: 'feature',
  feature: 'feature',
  refactor: 'refactor',
  perf: 'refactor',
  docs: 'docs',
  doc: 'docs',
  ci: 'chore',
  build: 'chore',
  style: 'chore',
  test: 'chore',
  chore: 'chore',
};

const CONVENTIONAL_RE = /^(\w+)(\([^)]*\))?!?:/;

export class IntentClassifier {
  private provider?: LLMProvider;

  constructor(provider?: LLMProvider) {
    this.provider = provider;
  }

  /** Full classification pipeline: conventional -> LLM -> heuristic */
  async classify(title: string, body: string, changedFiles: string[]): Promise<IntentResult> {
    // 1. Try conventional commit
    const conventional = this.classifyFromTitle(title);
    if (conventional) return conventional;

    // 2. Try LLM
    if (this.provider) {
      try {
        return await this.classifyWithLLM(title, body, changedFiles);
      } catch (err: any) {
        log.warn({ err }, 'LLM intent classification failed, using heuristic');
      }
    }

    // 3. Heuristic fallback
    return this.classifyFromHeuristic(title, changedFiles);
  }

  classifyFromTitle(title: string): IntentResult | null {
    const match = title.match(CONVENTIONAL_RE);
    if (!match) return null;

    const prefix = match[1].toLowerCase();
    const scope = match[2] ?? '';

    // Special case: chore(deps) -> dependency
    if ((prefix === 'chore' || prefix === 'build') && /deps|dependencies/i.test(scope)) {
      return { intent: 'dependency', confidence: 1.0, reason: `Conventional commit: ${prefix}(deps)` };
    }

    const intent = CONVENTIONAL_MAP[prefix];
    if (!intent) return null;

    return { intent, confidence: 1.0, reason: `Conventional commit: ${prefix}` };
  }

  classifyFromHeuristic(title: string, changedFiles: string[]): IntentResult {
    const lower = title.toLowerCase();

    // Dependency signals
    if (/\b(bump|upgrade|update|dependabot|renovate)\b/i.test(lower)) {
      const depFiles = changedFiles.filter(f => /package\.json|package-lock|yarn\.lock|Gemfile|requirements\.txt|go\.mod|Cargo\.toml/i.test(f));
      if (depFiles.length > 0 || /bump|dependabot|renovate/i.test(lower)) {
        return { intent: 'dependency', confidence: 0.8, reason: 'Dependency update keywords' };
      }
    }

    // Docs signals
    const allDocs = changedFiles.length > 0 && changedFiles.every(f =>
      /\.(md|txt|rst|adoc)$/i.test(f) || /readme|license|changelog|contributing|docs\//i.test(f)
    );
    if (allDocs) {
      return { intent: 'docs', confidence: 0.8, reason: 'All changed files are documentation' };
    }

    // Bugfix signals
    if (/\b(fix|bug|crash|error|issue|resolve|patch|hotfix)\b/i.test(lower)) {
      return { intent: 'bugfix', confidence: 0.7, reason: 'Bugfix keywords in title' };
    }

    // Refactor signals
    if (/\b(refactor|restructure|reorganize|cleanup|clean up|simplify|extract|move)\b/i.test(lower)) {
      return { intent: 'refactor', confidence: 0.7, reason: 'Refactor keywords in title' };
    }

    // Default to feature
    return { intent: 'feature', confidence: 0.5, reason: 'Default classification' };
  }

  async classifyWithLLM(title: string, body: string, changedFiles: string[]): Promise<IntentResult> {
    const filesStr = changedFiles.slice(0, 20).join(', ');
    const input = `Title: ${title}\nBody: ${(body ?? '').slice(0, 1000)}\nFiles: ${filesStr}`.slice(0, 2000);

    const prompt = `Classify this PR/Issue intent into exactly one category: bugfix, feature, refactor, dependency, docs, chore.
Return JSON: {"intent": "<category>", "confidence": <0-1>, "reason": "<brief>"}
${input}`;

    const text = await this.provider!.generateText(prompt, { temperature: 0.1, maxTokens: 100 });

    try {
      const match = text.match(/\{[^}]+\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const valid: IntentCategory[] = ['bugfix', 'feature', 'refactor', 'dependency', 'docs', 'chore'];
        if (valid.includes(parsed.intent)) {
          return {
            intent: parsed.intent,
            confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
            reason: String(parsed.reason ?? ''),
          };
        }
      }
    } catch { /* fall through */ }

    // LLM gave unusable response, use heuristic
    return this.classifyFromHeuristic(title, changedFiles);
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `npx jest test/unit/intent.test.ts --no-coverage`
Expected: ALL PASS

**Step 6: Update test factories**

In `test/fixtures/pr-factory.ts`, add `intent` to `createScoredPR` defaults and add `createIssueData`/`createScoredIssue` factories.

Add to createScoredPR default return (after spamReasons):
```typescript
intent: overrides.intent,
```

Add new factory functions:
```typescript
export function createIssueData(overrides: Partial<IssueData> = {}): IssueData {
  return {
    number: 1,
    title: 'Bug: login fails on Safari',
    body: 'Steps to reproduce:\n1. Open Safari\n2. Click login\n3. Nothing happens',
    author: 'testuser',
    authorAssociation: 'CONTRIBUTOR',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    labels: [],
    commentCount: 0,
    reactionCount: 0,
    state: 'open',
    isLocked: false,
    assignees: [],
    linkedPRs: [],
    ...overrides,
  };
}

export function createScoredIssue(overrides: Partial<ScoredIssue> = {}): ScoredIssue {
  return {
    ...createIssueData(overrides),
    totalScore: overrides.totalScore ?? 50,
    signals: overrides.signals ?? [],
    isSpam: overrides.isSpam ?? false,
    spamReasons: overrides.spamReasons ?? [],
    ...overrides,
  };
}
```

**Step 7: Commit**

```bash
git add src/core/types.ts src/core/intent.ts test/unit/intent.test.ts test/fixtures/pr-factory.ts
git commit -m "feat: add IntentClassifier with conventional commit, LLM, and heuristic detection"
```

---

### Task 2: Integrate Intent Signal into ScoringEngine

**Files:**
- Modify: `src/core/scoring.ts` (add scoreIntent as 21st signal)
- Modify: `test/unit/scoring.test.ts` (add intent signal tests)

**Context:** `src/core/scoring.ts` has 20 signal calls at lines 52-72. We add `scoreIntent` as the 21st.

**Step 1: Write tests for intent signal**

Add to `test/unit/scoring.test.ts` in the describe block:
```typescript
describe('intent signal', () => {
  it('scores bugfix intent as 90', async () => {
    const pr = createPRData({ title: 'fix: resolve auth crash' });
    const scored = await engine.score(pr);
    const intentSignal = scored.signals.find(s => s.name === 'intent');
    expect(intentSignal).toBeDefined();
    expect(intentSignal!.score).toBe(90);
    expect(scored.intent).toBe('bugfix');
  });

  it('scores feature intent as 85', async () => {
    const pr = createPRData({ title: 'feat: add dark mode' });
    const scored = await engine.score(pr);
    const intentSignal = scored.signals.find(s => s.name === 'intent');
    expect(intentSignal!.score).toBe(85);
    expect(scored.intent).toBe('feature');
  });

  it('scores dependency intent as 35', async () => {
    const pr = createPRData({ title: 'chore(deps): bump lodash' });
    const scored = await engine.score(pr);
    const intentSignal = scored.signals.find(s => s.name === 'intent');
    expect(intentSignal!.score).toBe(35);
    expect(scored.intent).toBe('dependency');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest test/unit/scoring.test.ts --no-coverage -t "intent signal"`
Expected: FAIL

**Step 3: Add scoreIntent to ScoringEngine**

In `src/core/scoring.ts`:

Add import at top:
```typescript
import { IntentClassifier, type IntentResult } from './intent';
```

Add field to class:
```typescript
private intentClassifier: IntentClassifier;
```

In constructor, after `this.concurrency = ...`:
```typescript
this.intentClassifier = new IntentClassifier(provider);
```

Add to signal list in score() (after line 72 `this.scoreComplexity(pr)`):
```typescript
// Intent is async — classify before building signals
const intentResult = await this.intentClassifier.classify(pr.title, pr.body ?? '', pr.changedFiles);
```

Add to signals array:
```typescript
this.scoreIntent(intentResult),
```

Add intent to return object (after `spamReasons`):
```typescript
intent: intentResult.intent,
```

Add signal method:
```typescript
private scoreIntent(result: IntentResult): SignalScore {
  const scores: Record<string, number> = {
    bugfix: 90, feature: 85, refactor: 60, dependency: 35, docs: 30, chore: 25,
  };
  return {
    name: 'intent',
    score: scores[result.intent] ?? 50,
    weight: 0.08,
    reason: `${result.intent} (${result.reason})`,
  };
}
```

**Step 4: Run tests**

Run: `npx jest test/unit/scoring.test.ts --no-coverage`
Expected: ALL PASS

**Step 5: Run full test suite to verify no regressions**

Run: `npx jest --no-coverage`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/core/scoring.ts test/unit/scoring.test.ts
git commit -m "feat: add intent signal (#21) to ScoringEngine"
```

---

### Task 3: Issue GraphQL Queries

**Files:**
- Modify: `src/core/graphql.ts` (add issue queries + mapGraphQLToIssueData)
- Create: `test/unit/issue-graphql.test.ts`

**Context:** `src/core/graphql.ts` has PR_DETAILS_QUERY at lines 56-107 and mapGraphQLToPRData at 184-261. We add similar queries and mapping for issues.

**Step 1: Write tests**

Create `test/unit/issue-graphql.test.ts`:
```typescript
import { mapGraphQLToIssueData, ISSUE_DETAILS_QUERY, ISSUE_LIST_QUERY } from '../../src/core/graphql';

describe('Issue GraphQL', () => {
  it('exports ISSUE_DETAILS_QUERY as a string', () => {
    expect(typeof ISSUE_DETAILS_QUERY).toBe('string');
    expect(ISSUE_DETAILS_QUERY).toContain('issues');
  });

  it('exports ISSUE_LIST_QUERY as a string', () => {
    expect(typeof ISSUE_LIST_QUERY).toBe('string');
    expect(ISSUE_LIST_QUERY).toContain('issues');
  });

  it('maps GraphQL issue node to IssueData', () => {
    const node = {
      number: 42,
      title: 'Bug: login fails',
      body: 'Steps to reproduce...',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      author: { login: 'alice' },
      authorAssociation: 'MEMBER',
      labels: { nodes: [{ name: 'bug' }] },
      milestone: { title: 'v1.0' },
      comments: { totalCount: 3 },
      reactions: { totalCount: 5 },
      state: 'OPEN',
      stateReason: null,
      locked: false,
      assignees: { nodes: [{ login: 'bob' }] },
    };

    const issue = mapGraphQLToIssueData(node);
    expect(issue.number).toBe(42);
    expect(issue.title).toBe('Bug: login fails');
    expect(issue.author).toBe('alice');
    expect(issue.labels).toEqual(['bug']);
    expect(issue.milestone).toBe('v1.0');
    expect(issue.commentCount).toBe(3);
    expect(issue.reactionCount).toBe(5);
    expect(issue.state).toBe('open');
    expect(issue.assignees).toEqual(['bob']);
    expect(issue.linkedPRs).toEqual([]);
  });

  it('handles null fields gracefully', () => {
    const node = {
      number: 1,
      title: 'Test',
      body: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      author: null,
      authorAssociation: 'NONE',
      labels: { nodes: [] },
      milestone: null,
      comments: { totalCount: 0 },
      reactions: { totalCount: 0 },
      state: 'OPEN',
      stateReason: null,
      locked: false,
      assignees: { nodes: [] },
    };

    const issue = mapGraphQLToIssueData(node);
    expect(issue.body).toBe('');
    expect(issue.author).toBe('unknown');
    expect(issue.milestone).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest test/unit/issue-graphql.test.ts --no-coverage`
Expected: FAIL

**Step 3: Implement issue GraphQL queries in src/core/graphql.ts**

Add after existing PR queries:
```typescript
export const ISSUE_LIST_QUERY = `
  query($owner: String!, $repo: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: $first, after: $after, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          updatedAt
        }
      }
    }
  }
`;

export const ISSUE_DETAILS_QUERY = `
  query($owner: String!, $repo: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: $first, after: $after, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          body
          createdAt
          updatedAt
          author { login }
          authorAssociation
          labels(first: 50) { nodes { name } }
          milestone { title }
          comments { totalCount }
          reactions { totalCount }
          state
          stateReason
          locked
          assignees(first: 20) { nodes { login } }
        }
      }
    }
  }
`;

export function mapGraphQLToIssueData(node: any): IssueData {
  return {
    number: node.number,
    title: node.title,
    body: node.body ?? '',
    author: node.author?.login ?? 'unknown',
    authorAssociation: node.authorAssociation ?? 'NONE',
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    labels: (node.labels?.nodes ?? []).map((l: any) => l.name),
    milestone: node.milestone?.title ?? undefined,
    commentCount: node.comments?.totalCount ?? 0,
    reactionCount: node.reactions?.totalCount ?? 0,
    state: node.state?.toLowerCase() as 'open' | 'closed',
    stateReason: node.stateReason ?? null,
    isLocked: node.locked ?? false,
    assignees: (node.assignees?.nodes ?? []).map((a: any) => a.login),
    linkedPRs: [],
  };
}
```

**Step 4: Run tests**

Run: `npx jest test/unit/issue-graphql.test.ts --no-coverage`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/core/graphql.ts src/core/types.ts test/unit/issue-graphql.test.ts
git commit -m "feat: add issue GraphQL queries and mapping"
```

---

### Task 4: IssueScoringEngine

**Files:**
- Create: `src/core/issue-scoring.ts`
- Create: `test/unit/issue-scoring.test.ts`

**Context:** Issue scoring uses 12 signals (subset of PR signals + new ones). Reuses IntentClassifier. No LLM blend for issues (heuristic only for now).

**Step 1: Write tests**

Create `test/unit/issue-scoring.test.ts`:
```typescript
import { IssueScoringEngine } from '../../src/core/issue-scoring';
import { createIssueData } from '../fixtures/pr-factory';

describe('IssueScoringEngine', () => {
  let engine: IssueScoringEngine;

  beforeEach(() => {
    engine = new IssueScoringEngine();
  });

  it('scores a typical issue', async () => {
    const issue = createIssueData({ commentCount: 3, reactionCount: 5 });
    const scored = await engine.score(issue);
    expect(scored.totalScore).toBeGreaterThan(0);
    expect(scored.totalScore).toBeLessThanOrEqual(100);
    expect(scored.signals.length).toBe(12);
    expect(scored.isSpam).toBe(false);
  });

  it('detects spam issues (empty body, no labels)', async () => {
    const issue = createIssueData({ body: '', title: 'hi', labels: [], commentCount: 0 });
    const scored = await engine.score(issue);
    expect(scored.isSpam).toBe(true);
  });

  it('scores high for popular issues with reactions', async () => {
    const popular = createIssueData({ reactionCount: 20, commentCount: 10, labels: ['bug', 'high-priority'] });
    const boring = createIssueData({ reactionCount: 0, commentCount: 0 });
    const scoredPop = await engine.score(popular);
    const scoredBor = await engine.score(boring);
    expect(scoredPop.totalScore).toBeGreaterThan(scoredBor.totalScore);
  });

  it('includes has_linked_pr signal', async () => {
    const withPR = createIssueData({ linkedPRs: [42] });
    const scored = await engine.score(withPR);
    const signal = scored.signals.find(s => s.name === 'has_linked_pr');
    expect(signal).toBeDefined();
    expect(signal!.score).toBe(90);
  });

  it('includes reproducibility signal', async () => {
    const withSteps = createIssueData({ body: 'Steps to reproduce:\n1. Open app\n2. Click login\n\nExpected: Login works\nActual: Crash' });
    const scored = await engine.score(withSteps);
    const signal = scored.signals.find(s => s.name === 'reproducibility');
    expect(signal).toBeDefined();
    expect(signal!.score).toBeGreaterThanOrEqual(80);
  });

  it('includes assignee signal', async () => {
    const assigned = createIssueData({ assignees: ['alice'] });
    const unassigned = createIssueData({ assignees: [] });
    const scoredA = await engine.score(assigned);
    const scoredU = await engine.score(unassigned);
    const sigA = scoredA.signals.find(s => s.name === 'assignee_status')!;
    const sigU = scoredU.signals.find(s => s.name === 'assignee_status')!;
    expect(sigA.score).toBeGreaterThan(sigU.score);
  });

  it('includes intent signal', async () => {
    const issue = createIssueData({ title: 'fix: crash on startup' });
    const scored = await engine.score(issue);
    expect(scored.intent).toBe('bugfix');
  });

  it('scores many issues in parallel', async () => {
    const issues = Array.from({ length: 10 }, (_, i) => createIssueData({ number: i + 1 }));
    const scored = await engine.scoreMany(issues);
    expect(scored).toHaveLength(10);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx jest test/unit/issue-scoring.test.ts --no-coverage`
Expected: FAIL

**Step 3: Implement IssueScoringEngine**

Create `src/core/issue-scoring.ts`:
```typescript
import type { IssueData, ScoredIssue, SignalScore, IntentCategory } from './types';
import type { LLMProvider } from './provider';
import { IntentClassifier, type IntentResult } from './intent';
import { ConcurrencyController } from './concurrency';
import { createLogger } from './logger';

const log = createLogger('issue-scoring');

export class IssueScoringEngine {
  private provider?: LLMProvider;
  private intentClassifier: IntentClassifier;
  private concurrency: ConcurrencyController;

  constructor(provider?: LLMProvider, maxConcurrent = 10) {
    this.provider = provider;
    this.intentClassifier = new IntentClassifier(provider);
    this.concurrency = new ConcurrencyController(maxConcurrent);
  }

  async scoreMany(issues: IssueData[]): Promise<ScoredIssue[]> {
    if (issues.length === 0) return [];
    log.info({ count: issues.length }, 'Scoring issues');

    const results = await Promise.allSettled(
      issues.map(issue => this.concurrency.execute(() => this.score(issue)))
    );

    const scored: ScoredIssue[] = [];
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        scored.push(result.value);
      } else {
        log.warn({ issue: issues[i].number, err: result.reason }, 'Failed to score issue');
      }
    }
    return scored;
  }

  async score(issue: IssueData): Promise<ScoredIssue> {
    const intentResult = await this.intentClassifier.classify(issue.title, issue.body ?? '', []);

    const signals: SignalScore[] = [
      this.scoreStaleness(issue),
      this.scoreBodyQuality(issue),
      this.scoreLabelPriority(issue),
      this.scoreActivity(issue),
      this.scoreContributor(issue),
      this.scoreSpam(issue),
      this.scoreMilestone(issue),
      this.scoreReactions(issue),
      this.scoreLinkedPR(issue),
      this.scoreAssignee(issue),
      this.scoreReproducibility(issue),
      this.scoreIntent(intentResult),
    ];

    const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
    const totalScore = totalWeight > 0
      ? Math.round(signals.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight)
      : 0;

    const spamSignal = signals.find(s => s.name === 'spam');
    const isSpam = (spamSignal?.score ?? 100) < 25;

    return {
      ...issue,
      totalScore,
      signals,
      intent: intentResult.intent,
      isSpam,
      spamReasons: isSpam ? [spamSignal?.reason ?? 'Low quality'] : [],
    };
  }

  private scoreStaleness(issue: IssueData): SignalScore {
    const days = Math.floor((Date.now() - new Date(issue.createdAt).getTime()) / (1000 * 60 * 60 * 24));
    let score: number;
    if (days < 7) score = 100;
    else if (days <= 30) score = 70;
    else if (days <= 90) score = 40;
    else score = 15;
    return { name: 'staleness', score, weight: 0.08, reason: `${days}d old` };
  }

  private scoreBodyQuality(issue: IssueData): SignalScore {
    const len = (issue.body ?? '').length;
    let score = len > 500 ? 90 : len >= 200 ? 70 : len >= 50 ? 50 : 20;
    if (/- \[[ x]\]/.test(issue.body ?? '')) score = Math.min(100, score + 10);
    return { name: 'body_quality', score, weight: 0.08, reason: `Body: ${len} chars` };
  }

  private scoreLabelPriority(issue: IssueData): SignalScore {
    const highLabels = ['high-priority', 'urgent', 'critical', 'p0', 'p1', 'security', 'bug'];
    const labels = issue.labels.map(l => l.toLowerCase());
    if (labels.some(l => highLabels.some(h => l.includes(h)))) {
      return { name: 'label_priority', score: 95, weight: 0.10, reason: `High priority: ${issue.labels.join(', ')}` };
    }
    return { name: 'label_priority', score: 50, weight: 0.07, reason: issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : 'No labels' };
  }

  private scoreActivity(issue: IssueData): SignalScore {
    let score = issue.commentCount >= 5 ? 90 : issue.commentCount >= 2 ? 70 : issue.commentCount === 1 ? 50 : 30;
    return { name: 'activity', score, weight: 0.08, reason: `${issue.commentCount} comments` };
  }

  private scoreContributor(issue: IssueData): SignalScore {
    const trustMap: Record<string, number> = { OWNER: 100, MEMBER: 90, COLLABORATOR: 85, CONTRIBUTOR: 70, NONE: 30 };
    return { name: 'contributor', score: trustMap[issue.authorAssociation] ?? 50, weight: 0.08, reason: `${issue.author} (${issue.authorAssociation})` };
  }

  private scoreSpam(issue: IssueData): SignalScore {
    let spamScore = 0;
    const reasons: string[] = [];
    if ((issue.body ?? '').length < 20) { spamScore += 2; reasons.push('Empty/short body'); }
    if (issue.title.length < 10) { spamScore++; reasons.push('Short title'); }
    const aiMarkers = [/certainly!/i, /as an ai/i, /i apologize/i];
    if (aiMarkers.some(p => p.test(issue.body ?? ''))) { spamScore++; reasons.push('AI language'); }
    return { name: 'spam', score: Math.max(0, 100 - spamScore * 20), weight: 0.10, reason: reasons.length > 0 ? reasons.join(', ') : 'No spam signals' };
  }

  private scoreMilestone(issue: IssueData): SignalScore {
    return { name: 'milestone', score: issue.milestone ? 90 : 40, weight: 0.07, reason: issue.milestone ? `Milestone: ${issue.milestone}` : 'No milestone' };
  }

  private scoreReactions(issue: IssueData): SignalScore {
    let score = issue.reactionCount >= 10 ? 95 : issue.reactionCount >= 5 ? 80 : issue.reactionCount >= 1 ? 60 : 30;
    return { name: 'reaction_score', score, weight: 0.10, reason: `${issue.reactionCount} reactions` };
  }

  private scoreLinkedPR(issue: IssueData): SignalScore {
    return { name: 'has_linked_pr', score: issue.linkedPRs.length > 0 ? 90 : 30, weight: 0.08, reason: issue.linkedPRs.length > 0 ? `Linked to PR(s): ${issue.linkedPRs.map(n => `#${n}`).join(', ')}` : 'No linked PR' };
  }

  private scoreAssignee(issue: IssueData): SignalScore {
    return { name: 'assignee_status', score: issue.assignees.length > 0 ? 80 : 30, weight: 0.07, reason: issue.assignees.length > 0 ? `Assigned: ${issue.assignees.join(', ')}` : 'Unassigned' };
  }

  private scoreReproducibility(issue: IssueData): SignalScore {
    const body = issue.body ?? '';
    let score = 40;
    if (/steps?\s*to\s*reproduce/i.test(body)) score += 20;
    if (/expected|actual/i.test(body)) score += 20;
    if (/```/.test(body)) score += 10;
    score = Math.min(100, score);
    return { name: 'reproducibility', score, weight: 0.07, reason: score >= 80 ? 'Has reproduction steps' : 'Missing reproduction info' };
  }

  private scoreIntent(result: IntentResult): SignalScore {
    const scores: Record<string, number> = { bugfix: 90, feature: 85, refactor: 60, dependency: 35, docs: 30, chore: 25 };
    return { name: 'intent', score: scores[result.intent] ?? 50, weight: 0.09, reason: `${result.intent} (${result.reason})` };
  }
}
```

**Step 4: Run tests**

Run: `npx jest test/unit/issue-scoring.test.ts --no-coverage`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/core/issue-scoring.ts test/unit/issue-scoring.test.ts
git commit -m "feat: add IssueScoringEngine with 12 signals"
```

---

### Task 5: IssueScanner — Fetch + Score + Dedup Issues

**Files:**
- Create: `src/core/issue-scanner.ts`
- Create: `test/unit/issue-scanner.test.ts`

**Context:** Similar to TreliqScanner but for issues. Uses GraphQL + REST fallback, scores with IssueScoringEngine, builds PR-Issue links from existing `issueNumbers[]` on PRs.

**Step 1: Write tests**

Create `test/unit/issue-scanner.test.ts` with tests for:
- Fetches issues via GraphQL
- Falls back to REST
- Scores issues
- Links PRs to issues (cross-reference)
- Handles empty repo

**Step 2: Implement IssueScanner**

Create `src/core/issue-scanner.ts` that:
- Accepts `TreliqConfig` + optional `ScoredPR[]` (for PR-Issue linking)
- Fetches issues via GraphQL (`ISSUE_DETAILS_QUERY`), falls back to REST (`octokit.issues.listForRepo`)
- Assigns `linkedPRs` by cross-referencing from scored PR `issueNumbers[]`
- Scores with `IssueScoringEngine`
- Returns `ScoredIssue[]`

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add IssueScanner with GraphQL fetch and PR-Issue linking"
```

---

### Task 6: Cross-type Dedup (PR + Issue in same vector space)

**Files:**
- Modify: `src/core/dedup.ts` (accept ScoredIssue alongside ScoredPR)
- Modify: `src/core/types.ts` (add TriageItem union type)
- Modify: `test/unit/dedup.test.ts`

**Context:** DedupEngine currently works with `ScoredPR[]`. We need it to also embed Issues. Both share `title`, `body`, `embedding`, `duplicateGroup`, `number`.

**Step 1: Add TriageItem type**

In `src/core/types.ts`:
```typescript
export type TriageItem = ScoredPR | ScoredIssue;
```

**Step 2: Modify DedupEngine to accept TriageItem[]**

Change `findDuplicates` signature:
```typescript
async findDuplicates(items: TriageItem[], cc?: ConcurrencyController): Promise<DedupCluster[]>
```

The `prToText` method works for both (both have `title`, `body`). ScoredPR has `changedFiles`, ScoredIssue doesn't — handle gracefully:
```typescript
private itemToText(item: TriageItem): string {
  const parts = [item.title, item.body?.slice(0, 1000) ?? ''];
  if ('changedFiles' in item && item.changedFiles.length > 0) {
    parts.push('Files: ' + item.changedFiles.slice(0, 20).join(', '));
  }
  return parts.join('\n').slice(0, 2000);
}
```

**Step 3: Add DedupCluster type field**

In `DedupCluster`, add optional `type` to indicate mixed clusters:
```typescript
type?: 'pr' | 'issue' | 'mixed';
```

**Step 4: Tests + commit**

```bash
git commit -m "feat: cross-type dedup for PR + Issue in same vector space"
```

---

### Task 7: ActionEngine — Auto-close, Auto-merge, Auto-label

**Files:**
- Create: `src/core/actions.ts`
- Create: `test/unit/actions.test.ts`

**Context:** ActionEngine takes scored results and produces a list of planned actions. In dry-run mode, returns the plan. With `confirm=true`, executes via Octokit.

**Step 1: Write tests**

Create `test/unit/actions.test.ts`:
```typescript
import { ActionEngine, type ActionPlan } from '../../src/core/actions';
import { createScoredPR, createScoredIssue } from '../fixtures/pr-factory';

describe('ActionEngine', () => {
  describe('planCloseDuplicates', () => {
    it('closes lower-scored items in duplicate cluster', () => {
      const prs = [
        createScoredPR({ number: 1, totalScore: 90, duplicateGroup: 0 }),
        createScoredPR({ number: 2, totalScore: 70, duplicateGroup: 0 }),
        createScoredPR({ number: 3, totalScore: 50, duplicateGroup: 0 }),
      ];
      const engine = new ActionEngine();
      const plan = engine.planCloseDuplicates(prs, [{ id: 0, prs, bestPR: 1, similarity: 0.94, reason: '' }]);
      expect(plan).toHaveLength(2);
      expect(plan[0].target).toBe(2);
      expect(plan[1].target).toBe(3);
      expect(plan[0].action).toBe('close');
      expect(plan[0].reason).toContain('duplicate of #1');
    });
  });

  describe('planCloseSpam', () => {
    it('plans close for spam items', () => {
      const prs = [
        createScoredPR({ number: 1, isSpam: true, spamReasons: ['Empty body'] }),
        createScoredPR({ number: 2, isSpam: false }),
      ];
      const engine = new ActionEngine();
      const plan = engine.planCloseSpam(prs);
      expect(plan).toHaveLength(1);
      expect(plan[0].target).toBe(1);
    });
  });

  describe('planAutoMerge', () => {
    it('plans merge for high-score approved PRs', () => {
      const prs = [
        createScoredPR({ number: 1, totalScore: 92, reviewState: 'approved', ciStatus: 'success', mergeable: 'mergeable', isDraft: false }),
      ];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      const plan = engine.planAutoMerge(prs);
      expect(plan).toHaveLength(1);
      expect(plan[0].action).toBe('merge');
    });

    it('skips PRs below threshold', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 70, reviewState: 'approved', ciStatus: 'success', mergeable: 'mergeable' })];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      expect(engine.planAutoMerge(prs)).toHaveLength(0);
    });

    it('skips PRs not approved', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 95, reviewState: 'none', ciStatus: 'success', mergeable: 'mergeable' })];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      expect(engine.planAutoMerge(prs)).toHaveLength(0);
    });

    it('skips PRs with failing CI', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 95, reviewState: 'approved', ciStatus: 'failure', mergeable: 'mergeable' })];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      expect(engine.planAutoMerge(prs)).toHaveLength(0);
    });

    it('skips draft PRs', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 95, reviewState: 'approved', ciStatus: 'success', mergeable: 'mergeable', isDraft: true })];
      const engine = new ActionEngine({ mergeThreshold: 85 });
      expect(engine.planAutoMerge(prs)).toHaveLength(0);
    });

    it('skips high-risk PRs', () => {
      const prs = [createScoredPR({ number: 1, totalScore: 95, reviewState: 'approved', ciStatus: 'success', mergeable: 'mergeable', isDraft: false })];
      (prs[0] as any).llmRisk = 'high';
      const engine = new ActionEngine({ mergeThreshold: 85 });
      expect(engine.planAutoMerge(prs)).toHaveLength(0);
    });
  });

  describe('planLabelIntent', () => {
    it('plans intent labels for PRs with intent', () => {
      const prs = [
        createScoredPR({ number: 1, intent: 'bugfix' }),
        createScoredPR({ number: 2, intent: 'feature' }),
        createScoredPR({ number: 3 }), // no intent
      ];
      const engine = new ActionEngine();
      const plan = engine.planLabelIntent(prs);
      expect(plan).toHaveLength(2);
      expect(plan[0].label).toBe('intent:bugfix');
    });
  });

  describe('formatDryRun', () => {
    it('formats action plan as readable text', () => {
      const engine = new ActionEngine();
      const actions = [
        { action: 'close' as const, target: 2, type: 'pr' as const, reason: 'duplicate of #1' },
        { action: 'merge' as const, target: 1, type: 'pr' as const, reason: 'score: 92, approved, CI pass' },
      ];
      const output = engine.formatDryRun(actions);
      expect(output).toContain('CLOSE');
      expect(output).toContain('MERGE');
      expect(output).toContain('--confirm');
    });
  });
});
```

**Step 2: Implement ActionEngine**

Create `src/core/actions.ts`:
```typescript
import type { ScoredPR, ScoredIssue, DedupCluster, TriageItem } from './types';
import { createLogger } from './logger';

const log = createLogger('actions');

export interface ActionItem {
  action: 'close' | 'merge' | 'label';
  target: number;
  type: 'pr' | 'issue';
  reason: string;
  label?: string;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  comment?: string;
}

export interface ActionOptions {
  mergeThreshold?: number;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
  batchLimit?: number;
  exclude?: number[];
}

export class ActionEngine {
  private opts: Required<ActionOptions>;

  constructor(opts: ActionOptions = {}) {
    this.opts = {
      mergeThreshold: opts.mergeThreshold ?? 85,
      mergeMethod: opts.mergeMethod ?? 'squash',
      batchLimit: opts.batchLimit ?? 50,
      exclude: opts.exclude ?? [],
    };
  }

  planCloseDuplicates(items: TriageItem[], clusters: DedupCluster[]): ActionItem[] {
    const actions: ActionItem[] = [];
    for (const cluster of clusters) {
      const sorted = [...cluster.prs].sort((a, b) => b.totalScore - a.totalScore);
      const best = sorted[0];
      for (const item of sorted.slice(1)) {
        if (this.opts.exclude.includes(item.number)) continue;
        actions.push({
          action: 'close',
          target: item.number,
          type: 'changedFiles' in item ? 'pr' : 'issue',
          reason: `duplicate of #${best.number} (sim: ${(cluster.similarity * 100).toFixed(0)}%)`,
          comment: `Closed as duplicate of #${best.number} (similarity: ${(cluster.similarity * 100).toFixed(1)}%). Treliq auto-triage.`,
        });
      }
    }
    return actions.slice(0, this.opts.batchLimit);
  }

  planCloseSpam(items: TriageItem[]): ActionItem[] {
    return items
      .filter(item => item.isSpam && !this.opts.exclude.includes(item.number))
      .map(item => ({
        action: 'close' as const,
        target: item.number,
        type: ('changedFiles' in item ? 'pr' : 'issue') as 'pr' | 'issue',
        reason: `spam (${item.spamReasons.join(', ')})`,
        comment: `Closed by Treliq: detected as spam (${item.spamReasons.join(', ')}).`,
      }))
      .slice(0, this.opts.batchLimit);
  }

  planAutoMerge(prs: ScoredPR[]): ActionItem[] {
    return prs
      .filter(pr =>
        pr.totalScore >= this.opts.mergeThreshold &&
        pr.mergeable === 'mergeable' &&
        pr.reviewState === 'approved' &&
        pr.ciStatus === 'success' &&
        pr.llmRisk !== 'high' &&
        !pr.isDraft &&
        !this.opts.exclude.includes(pr.number)
      )
      .map(pr => ({
        action: 'merge' as const,
        target: pr.number,
        type: 'pr' as const,
        reason: `score: ${pr.totalScore}, approved, CI pass`,
        mergeMethod: this.opts.mergeMethod,
      }))
      .slice(0, this.opts.batchLimit);
  }

  planLabelIntent(items: TriageItem[]): ActionItem[] {
    return items
      .filter(item => item.intent && !this.opts.exclude.includes(item.number))
      .map(item => ({
        action: 'label' as const,
        target: item.number,
        type: ('changedFiles' in item ? 'pr' : 'issue') as 'pr' | 'issue',
        reason: `intent: ${item.intent}`,
        label: `intent:${item.intent}`,
      }))
      .slice(0, this.opts.batchLimit);
  }

  formatDryRun(actions: ActionItem[]): string {
    if (actions.length === 0) return 'No actions to perform.';

    const groups = {
      close: actions.filter(a => a.action === 'close'),
      merge: actions.filter(a => a.action === 'merge'),
      label: actions.filter(a => a.action === 'label'),
    };

    const lines: string[] = ['=== Auto-Actions (DRY RUN) ===', ''];

    if (groups.close.length > 0) {
      lines.push('CLOSE:');
      for (const a of groups.close) lines.push(`  #${a.target} (${a.type}) -> ${a.reason}`);
      lines.push('');
    }
    if (groups.merge.length > 0) {
      lines.push('MERGE:');
      for (const a of groups.merge) lines.push(`  #${a.target} -> ${a.reason}`);
      lines.push('');
    }
    if (groups.label.length > 0) {
      lines.push('LABEL:');
      for (const a of groups.label) lines.push(`  #${a.target} -> ${a.label}`);
      lines.push('');
    }

    lines.push(`Run with --confirm to execute. (${actions.length} actions pending)`);
    return lines.join('\n');
  }
}
```

**Step 3: Run tests**

Run: `npx jest test/unit/actions.test.ts --no-coverage`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/core/actions.ts test/unit/actions.test.ts
git commit -m "feat: add ActionEngine with close-dupes, close-spam, auto-merge, label-intent"
```

---

### Task 8: Action Executor (Octokit integration)

**Files:**
- Create: `src/core/action-executor.ts`
- Create: `test/unit/action-executor.test.ts`

**Context:** Separate module that takes an `ActionItem[]` and executes them via Octokit. Separated from ActionEngine so planning is pure/testable and execution is isolated.

**Step 1: Write tests with mocked Octokit**

Tests should verify:
- `execute()` calls `octokit.pulls.update()` for PR close
- `execute()` calls `octokit.issues.update()` for issue close
- `execute()` calls `octokit.pulls.merge()` for PR merge
- `execute()` calls `octokit.issues.addLabels()` for labeling
- `execute()` posts comment before closing
- `execute()` re-fetches current state before each action (stale check)
- `execute()` skips already-closed items
- `execute()` returns success/failure counts

**Step 2: Implement ActionExecutor**

The executor should:
1. Accept Octokit instance + owner + repo
2. For each action, re-fetch current state (`pulls.get` or `issues.get`)
3. Skip if state changed (already closed/merged)
4. Execute action + post comment
5. Return `{ executed: number, skipped: number, failed: number }`

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add ActionExecutor with Octokit integration and stale checks"
```

---

### Task 9: CLI Integration — scan-issues command + auto-action flags

**Files:**
- Modify: `src/cli.ts` (add scan-issues command, add auto-action flags to scan)
- Modify: `src/core/scanner.ts` (add --include-issues support)

**Context:** `src/cli.ts` defines commands at lines 438+. We add `scan-issues` as a new command and add auto-action flags to existing `scan` command.

**Step 1: Add scan-issues command to CLI**

```typescript
program
  .command('scan-issues')
  .description('Scan and triage open issues in a repository')
  .requiredOption('-r, --repo <owner/repo>', 'GitHub repository')
  .option('-t, --token <token>', 'GitHub token')
  .option('-p, --provider <name>', 'LLM provider')
  .option('-m, --max <number>', 'Max issues to scan', '500')
  .option('-f, --format <format>', 'Output format', 'table')
  .action(async (opts) => { ... });
```

**Step 2: Add auto-action flags to scan command**

Add to existing scan command options:
```typescript
.option('--include-issues', 'Also scan and triage issues', false)
.option('--auto-close-dupes', 'Close duplicate PRs/Issues (dry-run)', false)
.option('--auto-close-spam', 'Close spam PRs/Issues (dry-run)', false)
.option('--auto-merge', 'Merge high-score PRs (dry-run)', false)
.option('--merge-threshold <score>', 'Min score for auto-merge', '85')
.option('--auto-label-intent', 'Label PRs/Issues by intent', false)
.option('--confirm', 'Execute auto-actions (not just dry-run)', false)
.option('--exclude <numbers>', 'Comma-separated PR/Issue numbers to exclude')
```

**Step 3: Wire action flow in scan handler**

After scoring, if any auto-action flag is set:
1. Create `ActionEngine` with options
2. Generate action plan
3. If `--confirm`: execute via `ActionExecutor`
4. Else: print dry-run output

**Step 4: Run full test suite**

Run: `npx jest --no-coverage`
Expected: ALL PASS

**Step 5: Commit**

```bash
git commit -m "feat: add scan-issues command and auto-action flags to CLI"
```

---

### Task 10: Issue DB Schema + API Endpoints

**Files:**
- Modify: `src/core/db.ts` (add issues + issue_signals tables, upsertIssue, getIssues)
- Modify: `src/server/app.ts` (add /api/repos/:owner/:repo/issues endpoint)
- Add tests for both

**Step 1: Add DB tables**

```sql
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  author_association TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  labels TEXT NOT NULL,
  milestone TEXT,
  comment_count INTEGER NOT NULL,
  reaction_count INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  state_reason TEXT,
  is_locked INTEGER NOT NULL,
  assignees TEXT NOT NULL,
  linked_prs TEXT NOT NULL,
  total_score REAL NOT NULL,
  intent TEXT,
  embedding TEXT,
  duplicate_group INTEGER,
  is_spam INTEGER NOT NULL,
  spam_reasons TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  stored_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE(repo_id, issue_number)
);

CREATE TABLE IF NOT EXISTS issue_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  score REAL NOT NULL,
  weight REAL NOT NULL,
  reason TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
```

**Step 2: Add API endpoint**

```typescript
fastify.get('/api/repos/:owner/:repo/issues', ...)
```

**Step 3: Tests + commit**

```bash
git commit -m "feat: add issue DB schema and API endpoints"
```

---

### Task 11: Update TreliqResult + README + Version Bump

**Files:**
- Modify: `src/core/types.ts` (expand TreliqResult)
- Modify: `README.md` (add v0.7.0 section)
- Modify: `package.json` (bump to 0.7.0)

**Step 1: Expand TreliqResult**

```typescript
export interface TreliqResult {
  repo: string;
  scannedAt: string;
  totalPRs: number;
  totalIssues?: number;
  spamCount: number;
  duplicateClusters: DedupCluster[];
  rankedPRs: ScoredPR[];
  rankedIssues?: ScoredIssue[];
  actions?: ActionItem[];
  summary: string;
}
```

**Step 2: Run full test suite**

Run: `npm run build && npm test`
Expected: ALL PASS

**Step 3: Update README + bump version**

**Step 4: Commit**

```bash
git commit -m "feat: v0.7.0 — intent analysis, issue triage, and auto-actions"
```

---

### Task 12: Integration Testing + Final Verification

**Step 1: Build**
Run: `npm run build`
Expected: SUCCESS

**Step 2: Lint**
Run: `npm run lint`
Expected: SUCCESS

**Step 3: Full tests**
Run: `npm test`
Expected: ALL PASS

**Step 4: Verify new test count**
Target: ~280+ tests (244 existing + ~40+ new)

**Step 5: Push + Release**
```bash
git push origin main
git tag v0.7.0
git push origin v0.7.0
gh release create v0.7.0 --title "Treliq v0.7.0" --notes "..."
```
