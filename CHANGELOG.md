# Changelog

All notable changes to Treliq will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). This project adheres to [Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-02-24

### Changed
- **Triple scoring: idea + implementation + readiness** — `ideaScore` (fikir/problem degeri, 10 LLM soru), `implementationScore` (kod kalitesi, 5 LLM soru), `readinessScore` (merge hazirlik, TOPSIS heuristic)
- **CheckEval binary checklist** split into PART A (10 idea questions) and PART B (5 implementation questions). Evidence: CheckEval EMNLP 2025, "Rubric Is All You Need" ACM ICER 2025.
- **Idea-first scoring formula**: `totalScore = 0.7 * ideaScore + 0.3 * implementationScore`. Fikir madenciligi: PR'in kodu cop olsa bile fikri degerli olabilir.
- **Tier classification idea-driven**: critical (>=80), high (>=60), normal (>=30), low (<30) — purely based on ideaScore
- **Few-shot calibration anchors** with dual scoring (12 references with idea/impl breakdown). Evidence: Zhao et al. ICML 2021.
- TOPSIS replaces weighted average for readiness scoring (evidence: MCDM literature)
- Neutral/missing signal values now score 0 instead of 30-50
- Contributor signal weight reduced 0.12 → 0.04 (AI agents can produce excellent PRs)
- Intent signal removed from scoring formula (only affects weight profiles)
- Diff analysis bonus now affects `implementationScore` instead of `ideaScore`

### Added
- Hard penalty multipliers for CI failure (0.4x), merge conflict (0.5x), spam (0.2x), draft (0.4x), abandoned (0.3x)
- Percentile rank normalization in batch scoring
- `ideaScore`, `ideaReason`, `ideaChecklist`, `implementationScore`, `implementationReason`, `implementationChecklist`, `readinessScore`, `penaltyMultiplier`, `tier`, `percentileRank` fields on ScoredPR
- **Median-of-N self-consistency** (Wang et al. 2023) — configurable multi-pass LLM scoring with median selection for variance reduction
- **Issue context enrichment** (ContextCRBench 2025) — linked issue descriptions included in LLM prompt
- `issueContext` optional field on PRData for linked issue descriptions
- 12 dual calibration anchors spanning full score range (idea + implementation breakdown)

## [0.7.0] - 2026-02-22

### Added
- **Accuracy Pipeline** — 5 new stages: Diff-Aware Scoring, Intent-Aware Profiles, LLM Dedup Verification, Issue-PR Semantic Matching, Holistic Re-ranking.
- **Intent Classification** (Signal #21) — 3-tier detection: conventional commit prefix, LLM classification, heuristic fallback. 6 categories with intent-aware weight profiles.
- **Full Issue Triage** — `scan-issues` command, `--include-issues` flag, 12 issue-specific signals, cross-type PR/issue dedup.
- **Auto-Actions Engine** — `--auto-close-dupes`, `--auto-close-spam`, `--auto-merge`, `--auto-label-intent`. Dry-run by default, `--confirm` for execution.
- **`enrichWithIssues()` method** — Correct pipeline ordering for semantic matching after issue data is available.

### Fixed
- Pino logs redirected to stderr (`destination: 2`) so JSON stdout stays clean.
- LLM scoring rate limit: concurrency reduced 10 → 5, scoring engine wired to `onThrottle` callback.
- Diff analysis rate limit: default concurrency reduced 15 → 3, accepts external `ConcurrencyController`.
- Semantic matching pipeline: `enrichWithIssues()` runs matching + holistic re-ranking after issues are fetched (was running before issue data existed).
- `llmReason` now set on LLM failure for better diagnostics.
- CLI `--include-issues` output ordering fixed (outputResult moved after issue scanning).

### Changed
- Scoring engine exposes `throttle()` and `concurrencyMax()` public methods.
- `DiffAnalyzer.analyzeMany()` accepts optional external `ConcurrencyController`.
- All concurrency controllers (scoring, diff, dedup, vision) throttled together on 429.

### Quality
- **384 tests** across 28 suites (up from 244 in v0.6.0).

## [0.6.0] - 2026-02-22

### Added
- **Parallel Pipeline** — Dedup + Vision run concurrently via `Promise.all`.
- **Batch Embedding** — Gemini `batchEmbedContents` and OpenAI array input (100 embeddings/call).
- **RetryableProvider** — Exponential backoff + jitter, HTTP 429 detection, `Retry-After` support, fast-fail on non-retryable errors.
- **Adaptive Concurrency** — `ConcurrencyController.throttle()` halves parallelism on rate-limit, `recover()` increments back.
- **Expanded Cache** — Embedding vectors and vision results persisted, incremental scans skip re-embedding.

### Changed
- First scan time reduced from ~140 min to ~15-20 min (3000 PRs).
- Incremental scans reduced to ~5-8 min.
- `DedupEngine.findDuplicates()` accepts optional `ConcurrencyController`.
- `VisionChecker.checkMany()` accepts optional `ConcurrencyController`.
- Cache format stores embedding vectors (old caches auto-upgraded).

### Quality
- **244 tests** across 17 suites (up from 218 in v0.5.1).

## [0.5.1] - 2026-02-19

### Added
- `--model` flag for provider-level model selection on scan/score/dedup flows.
- OpenRouter provider support (`--provider openrouter`) with model routing.
- Scope Coherence signal for detecting scattered/unfocused PR changes.
- PR Complexity signal for size-aware and overengineering-aware scoring.
- Release notes doc: `docs/RELEASE_v0.5.1.md`.

### Changed
- Heuristic-only messaging and docs updated from 18 → 20 signals.
- Dashboard/docs copy refreshed for v0.5.1 messaging.
- Dedup empty-state help text updated for embedding fallback behavior.

### Fixed
- Embedding fallback now auto-detects Gemini/OpenAI keys for non-embedding providers.
- Provider/test compatibility after provider constructor/model updates.

## [0.5.0] - 2026-02-18

### Added
- Interactive `treliq init` setup wizard for guided first-time configuration.
- `treliq demo` command for no-key sample output and faster onboarding.
- Free-tier workflow support (`--no-llm`) with clearer CLI messaging.
- High-coverage unit test suites for `scanner`, `graphql`, `provider`, `dedup`, `reputation`, `vision`, and `vectorstore`.
- Expanded webhook and auth test coverage for safer automation paths.

### Changed
- CI now enforces `build + lint + test --coverage` before merge confidence.
- Coverage thresholds raised to meaningful gates:
  - branches: 50%
  - functions: 70%
  - lines/statements: 60%
- README quality metrics updated to reflect current test and coverage status.

### Quality
- Total tests increased to 218.
- Coverage improved to:
  - 85.12% lines
  - 84.01% statements
  - 70.08% branches
  - 91.83% functions

## [0.4.0] - 2025-02-16

### Added
- **Server Mode** — Persistent Fastify server with REST API and dashboard UI (`treliq server`)
- **Real-time SSE** — Server-Sent Events for live dashboard updates (`scan_complete`, `pr_scored`, `pr_closed`)
- **GitHub Webhooks** — Auto-score PRs on open/update/close with HMAC-SHA256 verification
- **GraphQL Fetching** — ~80% fewer API calls using GitHub's GraphQL API
- **18-Signal Scoring** — 5 new signals: draft status, milestone, label priority, CODEOWNERS, requested reviewers
- **SQLite Persistence** — Full scan history, PR state tracking, repository management (WAL mode)
- **Parallel LLM Scoring** — Concurrency-controlled parallel processing with semaphore (3x faster)
- **Rate Limit Manager** — Intelligent GitHub API pacing with automatic backoff
- **Cron Scheduler** — Automatic periodic scanning via node-cron
- **Notifications** — Slack and Discord webhook integration for scan results
- **GitHub App Manifest** — One-click GitHub App creation for webhook setup
- New commands: `server`, `close-spam`, `label-by-score`, `reset`

### Changed
- Dashboard redesigned with sidebar navigation, Tokyo Night theme, dual font system
- Migrated from REST to GraphQL for primary PR fetching
- Database switched from JSON cache to SQLite with incremental updates

## [0.3.0] - 2025-02-10

### Added
- GitHub Actions workflow for auto-scan on PR events
- PR comment commands (`/treliq score`, `/treliq scan`)
- Static HTML dashboard with dark/light theme toggle
- Single PR scoring (`treliq score -n 123`)
- `--trust-contributors` flag for spam exemption
- Incremental cache system (skip unchanged PRs)
- 9-signal scoring (test coverage, staleness, mergeability)
- Live demo at [mahsumaktas.github.io/treliq](https://mahsumaktas.github.io/treliq/)

## [0.2.0] - 2025-02-03

### Added
- Gemini AI scoring (quality + risk assessment)
- Embedding-based deduplication (gemini-embedding-001)
- Blended scoring formula (40% heuristic + 60% LLM)
- Multi-provider LLM support (OpenAI, Anthropic, Gemini)

## [0.1.0] - 2025-01-28

### Added
- CLI scanner (`treliq scan --repo owner/repo`)
- Semantic deduplication via LanceDB + Gemini embeddings
- Multi-signal scoring (CI, diff size, commit quality, contributor history, issue refs, spam)
- Vision document alignment (VISION.md / ROADMAP.md check via LLM)
- Output formats: table, JSON, markdown, GitHub comment

[0.8.0]: https://github.com/mahsumaktas/treliq/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/mahsumaktas/treliq/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mahsumaktas/treliq/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/mahsumaktas/treliq/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/mahsumaktas/treliq/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mahsumaktas/treliq/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mahsumaktas/treliq/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mahsumaktas/treliq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mahsumaktas/treliq/releases/tag/v0.1.0
