# Treliq Roadmap

## v0.1 — Foundation ✅

- CLI scanner (`treliq scan --repo owner/repo`)
- Semantic dedup via LanceDB + Gemini embeddings (0.85 duplicate / 0.80 related)
- Multi-signal scoring (CI, diff size, commit quality, contributor history, issue refs, spam heuristics)
- Vision doc alignment (VISION.md / ROADMAP.md check via LLM)
- Output formats: table, JSON, markdown, GitHub comment

## v0.2 — LLM Integration ✅

- Gemini AI scoring (quality + risk assessment)
- Embedding-based dedup (gemini-embedding-001)
- Blended scoring (40% heuristic + 60% LLM)

## v0.3 — GitHub Integration + Dashboard ✅

- GitHub Actions workflow (auto-scan on PR open/synchronize)
- PR comment commands (`/treliq score`, `/treliq scan`)
- Static HTML dashboard (dark/light theme, sortable, no build step)
- Single PR scoring (`treliq score -n 123`)
- `--trust-contributors` flag for spam exemption
- Incremental cache (only re-scores changed PRs)
- 9-signal scoring (added test coverage, staleness, mergeability)
- Live demo: [mahsumaktas.github.io/treliq](https://mahsumaktas.github.io/treliq/)

## v0.4 — Platform Mode ✅

- **Server Mode**: REST API via Fastify (`treliq server --port 3000`)
- **GraphQL API**: Single-query PR fetching (~80% fewer API calls vs REST)
- **18-Signal Scoring**: 5 new signals (draft status, milestone, label priority, codeowners, requested reviewers)
- **SQLite Persistence**: Incremental DB with WAL mode for history tracking
- **Webhook Handler**: Real-time PR scoring on push events (HMAC-SHA256 verified)
- **Scheduled Scans**: Cron-based automatic re-scans via node-cron
- **Rate Limit Manager**: Smart GitHub API throttling (auto-pause, slow-down)
- **Parallel LLM Processing**: Concurrent scoring with semaphore-based concurrency control (3x faster)
- **LanceDB Vector Store**: ANN search for semantic dedup (replaces O(n²) brute-force for >50 PRs)
- **Live Dashboard**: API-connected dashboard with server auto-detection
- **Real-time SSE Updates**: Server-Sent Events for live dashboard refresh (scan_complete, pr_scored, pr_closed)
- **GitHub App Manifest**: One-click GitHub App creation for webhook setup
- **Slack/Discord Notifications**: Scan result alerts via webhook URLs
- **New CLI Commands**: `close-spam`, `label-by-score`, `server`

## v0.5 — Distribution (Planned)

- npm publish (`npm install -g treliq`)
- Multi-repo dashboard (unified view across all repos)
- Team-based triage queues (assign PRs to reviewers)
- Custom scoring rule overrides (YAML config)
- Fine-tuned model support (custom LLM for domain-specific scoring)
- GitHub Marketplace App listing

---

## Competitive Positioning

```
                    Code Review ◄────────────────► PR Management
                         │                              │
                   CodeRabbit                      [EMPTY SPACE]
                   Greptile                         = Treliq
                   PR-Agent                              │
                   Graphite                              │
                         │                              │
                    Bug Detection ◄──────────────► Triage/Scoring
```

Treliq occupies the "PR Management + Triage/Scoring" quadrant that no one else serves.
