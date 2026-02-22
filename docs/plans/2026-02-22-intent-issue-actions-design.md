# Intent Analysis + Issue Triage + Auto-Actions Design

**Goal:** Make Treliq actionable at Peter Steinberger scale (3000+ PRs/Issues) by adding intent classification, full issue triage, and automated actions.

**Architecture:** Three features built sequentially — Intent (new signal) -> Issue Triage (scanner expansion) -> Auto-Actions (action engine). Unified pipeline where PRs and Issues share scoring, embedding, and dedup infrastructure.

**Order:** Intent -> Issue -> Auto-action (each builds on the previous)

---

## Feature 1: Intent Analysis (21st Signal)

### Categories
| Intent | Score | Mapping |
|--------|-------|---------|
| `bugfix` | 90 | fix:, hotfix: |
| `feature` | 85 | feat: |
| `refactor` | 60 | refactor: |
| `dependency` | 35 | deps:, bump, chore(deps) |
| `docs` | 30 | docs: |
| `chore` | 25 | chore:, ci:, build:, style:, test: |

### Detection Strategy
1. **Conventional commit prefix** — Direct map (no LLM needed)
2. **LLM fallback** — Prompt with title + body + file list, return `{"intent": "bugfix", "confidence": 0.92, "reason": "..."}`
3. **Heuristic fallback** — Title keyword matching if no LLM

### Signal
- Name: `intent`
- Weight: `0.08`
- Score: Category-based (see table)
- Stored on: `ScoredPR.intent` and `ScoredIssue.intent`

### Integration Points
- `ScoringEngine.scoreIntent(pr)` — new signal method
- `ScoredPR` type gets `intent?: string` field
- Intent used by auto-actions for merge/close rules

---

## Feature 2: Issue Triage

### Data Model

```typescript
interface IssueData {
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
  linkedPRs: number[];  // PRs that reference this issue
}

interface ScoredIssue extends IssueData {
  totalScore: number;
  signals: SignalScore[];
  intent?: string;
  embedding?: number[];
  duplicateGroup?: number;
  isSpam: boolean;
  spamReasons: string[];
}
```

### Issue Signals (12)
1. `staleness` — Age in days
2. `body_quality` — Description length, formatting, steps-to-reproduce
3. `label_priority` — High/low priority labels
4. `activity` — Comment count
5. `contributor` — Author trust level
6. `spam` — Spam heuristics (empty body, trivial title)
7. `milestone` — Milestone attached
8. `reaction_score` — Community reactions (+1, heart, etc.)
9. `has_linked_pr` — A PR references this issue
10. `assignee_status` — Assigned to someone
11. `reproducibility` — Has steps-to-reproduce, expected/actual sections
12. `intent` — LLM intent classification

### Fetch Strategy
- GraphQL query for issues (similar to PR_DETAILS_QUERY)
- REST fallback via `octokit.issues.list()`
- PR-Issue linking: cross-reference `issueNumbers[]` from PRs

### Cross-type Dedup
- Issues and PRs embedded in same vector space
- A bug report issue and its fix PR cluster together
- Cluster type: `pr-only`, `issue-only`, or `mixed`

### CLI
- `npx treliq scan-issues -r owner/repo` — Standalone issue scan
- `npx treliq scan -r owner/repo --include-issues` — Combined scan

### DB Schema Addition
- `issues` table mirroring `pull_requests` structure
- `issue_signals` table mirroring `signals`

---

## Feature 3: Auto-Actions

### Action Types

#### 1. Auto-close duplicates (`--auto-close-dupes`)
- Close all but highest-scored item in each duplicate cluster
- Post comment: "Closed as duplicate of #X (similarity: 94%)"
- Works for both PRs and Issues

#### 2. Auto-close spam (`--auto-close-spam`)
- Close items where `isSpam === true`
- Post comment with spam reasons
- Extends existing `close-spam` command

#### 3. Auto-merge (`--auto-merge --merge-threshold 85`)
- Merge PRs that meet ALL criteria:
  - `totalScore >= threshold` (default 85)
  - `mergeable === 'mergeable'`
  - `reviewState === 'approved'`
  - `ciStatus === 'success'`
  - `llmRisk !== 'high'`
  - `isDraft === false`
- Merge method: squash (default), configurable
- PRs only (not issues)

#### 4. Auto-label intent (`--auto-label-intent`)
- Add `intent:<category>` label to PRs and Issues
- Extends existing `label-by-score` command

### Safety Model
- **Dry-run default** — No `--confirm` = report only
- **Fresh state check** — Re-fetch current state before each action (avoid stale cache)
- **Exclude list** — `--exclude 123,456` to skip specific items
- **Detailed logging** — Every action logged with before/after state
- **Batch limit** — Max 50 actions per run (configurable with `--batch-limit`)

### CLI Integration
```bash
# Full triage with auto-actions (dry-run)
npx treliq scan -r owner/repo --include-issues \
  --auto-close-dupes --auto-close-spam \
  --auto-merge --merge-threshold 85 \
  --auto-label-intent

# Execute after review
npx treliq scan -r owner/repo --include-issues \
  --auto-close-dupes --auto-close-spam \
  --auto-merge --merge-threshold 85 \
  --auto-label-intent --confirm
```

### Dry-run Output Format
```
=== Auto-Actions (DRY RUN) ===

CLOSE (duplicate):
  #142 "Fix auth bug" -> duplicate of #138 (sim: 94%)
  #147 "Fix login error" -> duplicate of #138 (sim: 91%)

CLOSE (spam):
  #201 "Update README.md" -> spam (score: 12/100)

MERGE:
  #138 "fix: resolve auth null pointer" -> score: 92, approved, CI pass

LABEL:
  #155 -> intent:feature
  #138 -> intent:bugfix

Run with --confirm to execute. (4 actions pending)
```

---

## File Change Summary

### New Files
- `src/core/intent.ts` — Intent classifier
- `src/core/issue-scanner.ts` — Issue fetcher + scorer
- `src/core/issue-scoring.ts` — Issue-specific signals
- `src/core/actions.ts` — Auto-action engine
- `src/core/issue-graphql.ts` — Issue GraphQL queries
- `test/unit/intent.test.ts`
- `test/unit/issue-scanner.test.ts`
- `test/unit/issue-scoring.test.ts`
- `test/unit/actions.test.ts`

### Modified Files
- `src/core/types.ts` — Add IssueData, ScoredIssue, intent field on ScoredPR
- `src/core/scoring.ts` — Add scoreIntent signal (#21)
- `src/core/scanner.ts` — Wire intent signal, --include-issues support
- `src/core/dedup.ts` — Support mixed PR+Issue embedding
- `src/core/cache.ts` — Cache issues alongside PRs
- `src/core/db.ts` — Add issues + issue_signals tables
- `src/cli.ts` — Add scan-issues command, auto-action flags
- `src/server/app.ts` — Add issue API endpoints
- `test/fixtures/pr-factory.ts` — Add createIssueData(), createScoredIssue()

### Estimated Scope
- ~10 new/modified source files
- ~10 new/modified test files
- ~300-400 new tests expected
- Version: v0.7.0
