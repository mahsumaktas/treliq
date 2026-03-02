# Treliq Scoring Signals

## 21 PR Signals

| # | Signal | Weight | Description |
|---|--------|--------|-------------|
| 1 | CI Status | 0.15 | Pass / fail / pending from GitHub Checks |
| 2 | Test Coverage | 0.12 | Whether test files changed alongside code |
| 3 | Merge Conflicts | 0.12 | Mergeable / conflicting / unknown |
| 4 | Spam Detection | 0.12 | Tiny diff, docs-only, AI language markers |
| 5 | Review Status | 0.08 | Approved / changes requested / commented |
| 6 | Label Priority | 0.08 | High-priority labels boosted (p0, critical, security) |
| 7 | Draft Status | 0.08 | Draft PRs deprioritized |
| 8 | Diff Size | 0.07 | Lines changed — penalizes extremes |
| 9 | Staleness | 0.07 | Days since opened — fresh PRs preferred |
| 10 | Issue References | 0.07 | Links to issues via `Fixes #123` |
| 11 | Milestone | 0.07 | PRs attached to milestones score higher |
| 12 | Scope Coherence | 0.06 | Directory spread, title-to-files alignment |
| 13 | CODEOWNERS | 0.05 | Author owns affected code paths |
| 14 | Requested Reviewers | 0.05 | Reviewers assigned signals process maturity |
| 15 | PR Complexity | 0.05 | Size analysis, AI detection, overengineering |
| 16 | Contributor Trust | 0.04 | Author association + reputation score |
| 17 | Commit Quality | 0.04 | Conventional commit format |
| 18 | Body Quality | 0.04 | Description length, checklists, screenshots |
| 19 | Activity | 0.04 | Comment count — engagement signal |
| 20 | Breaking Change | 0.04 | Risky files, large deletions, `!:` in title |
| 21 | Intent | — | bugfix/feature/refactor/dependency/docs/chore (affects weight profiles, not score directly) |

### How Scoring Works

**Heuristic (readinessScore):** All 21 signals evaluated using TOPSIS (multi-criteria decision method). Hard penalty multipliers:
- CI failure: 0.4x
- Merge conflict: 0.5x
- Spam detected: 0.2x
- Draft PR: 0.4x
- Abandoned: 0.3x

**LLM (ideaScore + implementationScore):** Dual CheckEval binary checklist.
- `ideaScore` = 10 binary questions (idea/problem value) + noveltyBonus (0-20)
- `implementationScore` = 5 binary questions (code quality)
- `totalScore = 0.7 * ideaScore + 0.3 * implementationScore`

**Tier classification** (based on ideaScore):
- critical: >= 80
- high: >= 60
- normal: >= 30
- low: < 30

### Intent-Aware Weight Profiles

When intent is detected (bugfix, feature, refactor, dependency, docs, chore), signal weights are automatically adjusted. For example:
- **bugfix** PRs boost CI and test coverage weights
- **docs** PRs reduce CI and test weights
- Weights are normalized to sum=1.0 after profile application

### Cascade Pipeline

Three-stage cost-optimized scoring:

```
PR -> Heuristic (21 signals + TOPSIS readiness)
  -> readinessScore < 15 || spam? -> scoredBy='heuristic', skip LLM ($0)
  -> Haiku CheckEval              -> ideaScore < 40? -> scoredBy='haiku', final
  -> Sonnet re-score              -> scoredBy='sonnet', final
```

Estimated cost: ~$13 for 4000 PRs (vs $27 Sonnet-only).

## 12 Issue Signals

| # | Signal | Weight | Description |
|---|--------|--------|-------------|
| 1 | Spam Detection | 0.10 | Empty body, short title, AI language markers |
| 2 | Reactions | 0.10 | Community interest via emoji reactions |
| 3 | Intent | 0.09 | bugfix/feature/refactor/dependency/docs/chore |
| 4 | Staleness | 0.08 | Days since opened — fresh issues preferred |
| 5 | Body Quality | 0.08 | Description length, checklists |
| 6 | Activity | 0.08 | Comment count — engagement signal |
| 7 | Contributor Trust | 0.08 | Author association (owner/member/contributor) |
| 8 | Linked PR | 0.08 | Has linked PR(s) attempting to resolve |
| 9 | Label Priority | 0.07-0.10 | High-priority labels (bug, p0, security) boosted |
| 10 | Milestone | 0.07 | Issues attached to milestones score higher |
| 11 | Assignee | 0.07 | Assigned = someone is working on it |
| 12 | Reproducibility | 0.07 | Steps to reproduce, expected/actual, code blocks |
