# Changelog

All notable changes to Treliq will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). This project adheres to [Semantic Versioning](https://semver.org/).

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

[0.4.0]: https://github.com/mahsumaktas/treliq/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mahsumaktas/treliq/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mahsumaktas/treliq/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mahsumaktas/treliq/releases/tag/v0.1.0
