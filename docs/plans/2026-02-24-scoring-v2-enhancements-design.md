# Scoring v2 Enhancements — Evidence-Based Design

## Problem
v0.8.0 dual scoring (ideaScore + readinessScore) has score compression:
- Haiku 4.5: ideaScore stddev 9.2, range 35-88
- Sonnet 4.6: ideaScore stddev 13.7, range 18-88
- readinessScore max 71 (dataset-specific, not a bug)

## Evidence-Based Solutions

### 1. CheckEval — Binary Checklist Decomposition

**Source:** CheckEval (EMNLP 2025), "Rubric Is All You Need" (ACM ICER 2025)

Replace single 0-100 LLM score with 15 yes/no questions.
`ideaScore = (yes_count / 15) * 100`

**Why it works:** Binary decisions are far more reliable than numeric judgments (Pearson 0.912 vs 0.745). Mechanically eliminates score compression — LLM never picks a number.

**Questions (15):**
1. Does this fix a bug that users have reported or would encounter?
2. Does this address a security vulnerability?
3. Does this fix a crash, data loss, or data corruption scenario?
4. Does this solve a performance problem?
5. Does this add a new user-facing capability?
6. Does this improve developer experience (DX, tooling, workflow)?
7. Does the problem affect multiple users or use cases (broad impact)?
8. Is the technical approach sound and well-reasoned?
9. Does this remove meaningful technical debt?
10. Is this a novel/non-obvious solution (not just a trivial fix)?
11. Would you want this change in your own codebase?
12. Does this address a documented issue or known pain point?
13. Does the approach align with the project's architecture?
14. Could this benefit other projects beyond the immediate scope?
15. Is the problem important for the project's long-term health?

**Score granularity:** 16 possible values (0, 6.7, 13.3, ..., 93.3, 100)

### 2. Weighted Geometric Mean

**Source:** Triantaphyllou (2001), PMC 729-scenario simulation

Replace `0.7*idea + 0.3*readiness` with:
```
floor = 5
totalScore = max(floor, ideaScore)^0.65 * max(floor, readinessScore)^0.35
```

**Why:** Heterojen sources (LLM vs TOPSIS), rank reversal immune, zero-veto with floor.

**Examples:**
| idea | readiness | Additive | Geometric |
|------|-----------|----------|-----------|
| 93   | 20        | 71       | 56        |
| 93   | 93        | 93       | 93        |
| 47   | 47        | 47       | 47        |
| 27   | 80        | 43       | 39        |
| 87   | 67        | 81       | 80        |
| 0    | 80        | 24       | 8 (floor) |

### 3. Few-Shot Anchor Examples

**Source:** Zhao et al. (ICML 2021), GoDaddy production

Add 5 calibration anchors to the checklist prompt showing expected answers for extreme cases. Breaks central tendency by demonstrating the full range.

## What We Excluded (and why)

| Technique | Reason for exclusion |
|-----------|---------------------|
| RRF | Designed for 5+ rankers; loses score magnitude with 2 sources (Shen et al. 2023) |
| Confidence-Weighted Fusion | LLM self-confidence uncalibrated, ECE 0.108-0.427 (Yang et al. 2024) |
| Domain Multipliers | INTENT_PROFILES already covers this; no evidence for additional static multipliers |

## Files to Change

| File | Change |
|------|--------|
| `scoring.ts` | CheckEval prompt, geometric mean, few-shot anchors |
| `types.ts` | `ideaChecklist?: boolean[]` field |
| `scoring.test.ts` | Updated tests |
| `scoring-engine.test.ts` | Integration test updates |
| `pr-factory.ts` | New defaults |
| `CHANGELOG.md` | Update v0.8.0 entry |
