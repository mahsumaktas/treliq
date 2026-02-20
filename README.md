<p align="center">
  <img src="docs/logo.png" alt="Treliq" width="140" />
</p>

<h3 align="center">AI-Powered PR Triage for Maintainers & Enterprise Teams</h3>

<p align="center">
  <em>"Too many open PRs. Which ones should I review and merge first?"</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/treliq"><img src="https://img.shields.io/npm/v/treliq?style=flat-square&color=CB3837&logo=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/treliq"><img src="https://img.shields.io/npm/dm/treliq?style=flat-square&color=CB3837" alt="npm downloads" /></a>
  <a href="https://github.com/mahsumaktas/treliq/actions"><img src="https://img.shields.io/github/actions/workflow/status/mahsumaktas/treliq/ci.yml?branch=main&style=flat-square" alt="CI" /></a>
  <img src="https://img.shields.io/badge/tests-220_passing-2DA44E?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/signals-20-8B5CF6?style=flat-square" alt="20 Signals" />
  <img src="https://img.shields.io/badge/providers-4-FF6600?style=flat-square" alt="4 Providers" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-≥18-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <a href="https://github.com/mahsumaktas/treliq/stargazers"><img src="https://img.shields.io/github/stars/mahsumaktas/treliq?style=flat-square" alt="Stars" /></a>
</p>

---

Treliq is an intelligent PR triage system that **deduplicates, scores, and ranks** pull requests so maintainers can focus on merging what matters. Available as a **CLI tool**, **persistent server with REST API**, and **GitHub Action**.

## The Problem

Existing tools review code (CodeRabbit, Greptile, Copilot). None answer the maintainer's real questions:

- **"These 5 PRs fix the same bug — which one is best?"**
- **"Does this PR align with our roadmap?"**
- **"Show me the top 10 PRs I should review today."**

**Code Review ≠ PR Triage. Treliq fills the gap.**

### 🎯 Who is this for?
- **Enterprise Engineering Teams:** Weekly release cut-offs approaching? Stop guessing which 20 PRs to merge. Treliq prioritizes bug fixes, high test coverage, and small diffs.
- **Open Source Maintainers:** Drowning in open PRs from random contributors? Automatically detect duplicate attempts, filter out spam, and prioritize trusted contributors.
- **Platform/DevOps Teams:** Run Treliq as a central server across multiple internal repositories and provide a unified PR dashboard for the whole company.

### ⚡ Zero Setup / Free Mode
Not ready to trust your codebase with an LLM? Try the 100% free, local heuristic engine with zero API keys required.
```bash
# Score PRs based on 20 signals (CI, coverage, conflicts, etc.) completely locally
npx treliq scan -r owner/repo --no-llm
```

## What's New in v0.5.1

### 🎯 Model Flexibility
- **`--model` flag** — Choose any model within your provider: `--model claude-sonnet-4-6`
- **`TRELIQ_MODEL` env var** — Set globally without CLI flags
- **Auto max_tokens** — Sonnet/Opus get 1024 tokens (extended thinking), Flash/Haiku get 200

### 🌐 OpenRouter Provider
- Route through OpenRouter for unified billing and 200+ model access
- `--provider openrouter --model anthropic/claude-sonnet-4.5`
- Automatic embedding fallback to Gemini/OpenAI

### 🔗 Embedding Auto-Fallback
- Non-embedding providers (Anthropic, OpenRouter) auto-detect `GEMINI_API_KEY` or `OPENAI_API_KEY`
- Dedup works seamlessly regardless of LLM provider

### 🎯 Scope Coherence Signal (NEW)
- Detects unfocused PRs via directory spread analysis
- Labels: `focused` → `normal` → `mixed` → `scattered`
- Title-to-files mismatch detection (e.g., "fix rate-limit" touching `compaction.ts`)

### 🔬 PR Complexity Signal (NEW)
- Lines-per-file ratio analysis (detects dumped/generated code)
- Size threshold penalties (L/XL/XXL with context)
- AI-generated code detection (`AI assisted`, `copilot`, `cursor`, `chatgpt`)
- Simple title + large diff = overengineered flag
- Test-to-code ratio for large PRs
- Labels: `proportional` → `overengineered` → `massive`

### 📊 Model Benchmark Results
Tested on OpenClaw PRs with 4 models:
| Model | Scoring Style | Best For |
|---|---|---|
| Gemini 2.0 Flash | Generous (85-95) | Free tier, high volume |
| Haiku 4.5 | Balanced (72-92) | Fast, cheap daily scans |
| Sonnet 4.5 | Conservative (72-92) | Accurate triage |
| **Sonnet 4.6** | Most selective | Best quality, vision scoring |

## What's New in v0.5

### 🧪 Test Suite (218 tests)
- 15 test suites covering core modules and integration paths
- Unit tests: 18 scoring signals, concurrency, rate limiting, webhooks, auth, config, cache
- Integration tests: SQLite DB, full scoring engine pipeline
- Test fixtures: `createPRData()`, `createScoredPR()`, `MockLLMProvider`
- Coverage: 85.12% lines, 84.01% statements, 70.08% branches
- CI runs build, lint, and coverage with artifact upload

### 🔒 Security Hardening
- **Rate limiting** — Global 100/min, scan 5/5min (`@fastify/rate-limit`)
- **Security headers** — Helmet CSP, X-Frame-Options, X-Content-Type-Options (`@fastify/helmet`)
- **CORS** — Configurable via `CORS_ORIGINS` environment variable
- **XSS protection** — `escapeHtml()` applied to all 18 innerHTML usages in dashboard
- **SQL injection** — `sortBy` allowlist with 10 safe sort options
- **Timing-safe auth** — Webhook signature verification via `crypto.timingSafeEqual`
- **Input validation** — Fastify JSON Schema with owner/repo pattern validation
- **Error sanitization** — Generic error messages in production mode

### 📋 Structured Logging (Pino)
- 216 `console.error/warn` → Pino structured logging
- 11 source files migrated (CLI output preserved for user-facing commands)
- Dev: colorized pretty-print | Production: JSON format
- Auto-redaction of sensitive fields: `token`, `apiKey`, `privateKey`, `secret`, `password`
- `LOG_LEVEL` and `NODE_ENV` environment variable support

### v0.4 Highlights
- 🖥️ **Server Mode** — Persistent Fastify server with REST API, dashboard UI, and scheduled scanning
- 📡 **Real-time SSE** — Live dashboard updates via Server-Sent Events
- 🔗 **GitHub Webhooks** — Auto-score PRs on open/update/close with HMAC-SHA256 verification
- 🔍 **GraphQL Fetching** — ~80% fewer API calls using GitHub's GraphQL API
- 📊 **20-Signal Scoring** — Includes new Scope Coherence + PR Complexity analysis
- 🗄️ **SQLite Persistence** — Full scan history, PR state tracking, repository management
- ⚡ **Parallel LLM Scoring** — Concurrency-controlled parallel scoring with configurable limits
- 🚦 **Rate Limit Manager** — Intelligent GitHub API pacing with automatic backoff
- ⏰ **Cron Scheduler** — Automatic periodic scanning with Slack/Discord notifications
- 📢 **Notifications** — Slack and Discord webhook integration for scan results and high-priority PRs

## Dashboard

**[Live Demo →](https://mahsumaktas.github.io/treliq/)**

<p align="center">
  <img src="docs/screenshots/dashboard-dark.jpg" alt="Treliq Dashboard" width="800" />
</p>

- 100 PRs scored and ranked at a glance
- Sidebar navigation: Overview, Pull Requests, Clusters
- Score distribution chart (High/Medium/Low)
- Duplicate cluster visualization with similarity percentages
- Spam detection, conflict status, LLM risk assessment
- Tokyo Night dark theme with light mode toggle

## Architecture

```mermaid
graph TB
    subgraph Ingestion
        GH_REST[GitHub REST API]
        GH_GQL[GitHub GraphQL API]
        WH[GitHub Webhooks]
    end

    subgraph Core
        Scanner[Scanner]
        Scoring[20-Signal Scoring Engine]
        LLM[Multi-Provider LLM<br/>Gemini · OpenAI · Anthropic · OpenRouter]
        Dedup[Embedding Dedup<br/>LanceDB]
        Vision[Vision Doc Alignment]
        Rep[Contributor Reputation]
    end

    subgraph Persistence
        SQLite[(SQLite)]
        Cache[Incremental Cache]
    end

    subgraph Server["Server Mode (Fastify)"]
        REST[REST API]
        SSE[SSE Real-time Events]
        Scheduler[Cron Scheduler]
        Notif[Slack / Discord]
    end

    subgraph Clients
        CLI[CLI]
        Dashboard[Web Dashboard]
        Action[GitHub Action]
    end

    GH_REST & GH_GQL --> Scanner
    WH --> REST
    Scanner --> Scoring
    Scoring --> LLM
    Scanner --> Dedup
    Scanner --> Vision
    Scoring --> Rep
    Scoring --> SQLite
    Cache --> Scanner
    REST --> Scanner
    REST --> SSE
    Scheduler --> Scanner
    Scheduler --> Notif
    CLI --> Scanner
    Dashboard --> REST
    Dashboard --> SSE
    Action --> CLI
```

## Quick Start

### Install

```bash
# Global install
npm install -g treliq

# Or run directly with npx (no install needed)
npx treliq@latest --help
```

### CLI Mode

```bash
# Score a single PR
npx treliq score -r owner/repo -n 123 -f markdown

# Scan all open PRs (up to 100)
npx treliq scan -r owner/repo -m 100 -f json

# Find duplicate PR clusters
npx treliq dedup -r owner/repo

# Trust known contributors (exempt from spam detection)
npx treliq scan -r owner/repo --trust-contributors
```

### Server Mode

```bash
# Start server with dashboard on port 4747
npx treliq server -r owner/repo -p 4747

# With webhooks and scheduled scanning
npx treliq server -r owner/repo -p 4747 \
  --webhook-secret $WEBHOOK_SECRET \
  --schedule "0 */6 * * *" \
  --slack-webhook $SLACK_URL

# With multiple scheduled repositories
npx treliq server -r owner/repo -p 4747 \
  --schedule "0 8 * * *" \
  --scheduled-repos "org/repo1,org/repo2"
```

The server exposes:

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard UI |
| `GET /health` | Health check |
| `GET /api/repos` | List tracked repositories |
| `GET /api/repos/:owner/:repo/prs` | List scored PRs (sortable, filterable) |
| `GET /api/repos/:owner/:repo/prs/:number` | Single PR details |
| `POST /api/repos/:owner/:repo/scan` | Trigger a new scan |
| `GET /api/repos/:owner/:repo/scans` | Scan history |
| `GET /api/repos/:owner/:repo/spam` | Spam PRs |
| `GET /api/events` | SSE real-time stream |
| `POST /webhooks` | GitHub webhook receiver |
| `GET /setup` | GitHub App setup guide |

### Multi-Provider LLM

```bash
# Default: Gemini Flash (free)
npx treliq scan -r owner/repo

# Choose a specific model
npx treliq scan -r owner/repo -p anthropic --model claude-sonnet-4-6

# OpenRouter (200+ models, unified billing)
npx treliq scan -r owner/repo -p openrouter --model anthropic/claude-sonnet-4.5

# OpenAI
npx treliq scan -r owner/repo -p openai --api-key sk-...

# Anthropic (embeddings auto-fallback to Gemini/OpenAI)
npx treliq scan -r owner/repo -p anthropic --api-key sk-ant-...

# Heuristic-only (no API keys needed, 20 signals)
npx treliq scan -r owner/repo --no-llm
```

### 🔧 Setup (recommended)

```bash
npx treliq init
```

`treliq init` runs an interactive setup wizard, validates your GitHub token, prompts for provider keys, and saves everything to `.treliq.yaml`.

### 🆓 Free Mode (no API keys needed)

```bash
# See example output
npx treliq demo

# Heuristic-only scoring (20 signals, no LLM)
npx treliq scan -r owner/repo --no-llm
```

### 🤖 GitHub Action

1. Copy this workflow into `.github/workflows/treliq.yml`.
2. Add the `GEMINI_API_KEY` repository secret.
3. Open or update a PR and Treliq will auto-score it.

```yaml
name: Treliq PR Triage
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g treliq@latest
      - name: Score PR
        id: score
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        run: |
          BODY=$(treliq score -r ${{ github.repository }} -n ${{ github.event.pull_request.number }} -f markdown)
          echo "body<<EOF" >> $GITHUB_OUTPUT
          echo "$BODY" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT
      - uses: actions/github-script@v7
        env:
          SCORE_BODY: ${{ steps.score.outputs.body }}
        with:
          script: |
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.payload.pull_request.number,
              body: process.env.SCORE_BODY,
            });
```

## 20-Signal Scoring

| # | Signal | Weight | Description |
|---|--------|--------|-------------|
| 1 | CI Status | 0.15 | Pass / fail / pending from GitHub Checks |
| 2 | Test Coverage | 0.12 | Whether test files changed alongside code |
| 3 | Merge Conflicts | 0.12 | Mergeable / conflicting / unknown |
| 4 | Contributor Trust | 0.12 | Author association + reputation score |
| 5 | Spam Detection | 0.12 | Tiny diff, docs-only, AI language markers |
| 6 | Draft Status | 0.08 | Draft PRs deprioritized |
| 7 | Review Status | 0.08 | Approved / changes requested / commented |
| 8 | Label Priority | 0.08 | High-priority labels boosted (p0, critical, security) |
| 9 | Milestone | 0.07 | PRs attached to milestones score higher |
| 10 | Diff Size | 0.07 | Lines changed — penalizes extremes |
| 11 | Staleness | 0.07 | Days since opened — fresh PRs preferred |
| 12 | Issue References | 0.07 | Links to issues via `Fixes #123` |
| 13 | CODEOWNERS | 0.05 | Author owns affected code paths |
| 14 | Requested Reviewers | 0.05 | Reviewers assigned signals process maturity |
| 15 | Commit Quality | 0.04 | Conventional commit format |
| 16 | Body Quality | 0.04 | Description length, checklists, screenshots |
| 17 | Activity | 0.04 | Comment count — engagement signal |
| 18 | Breaking Change | 0.04 | Risky files, large deletions, `!:` in title |
| 19 | **Scope Coherence** | 0.06 | Directory spread, title-to-files alignment |
| 20 | **PR Complexity** | 0.05 | Size analysis, AI detection, overengineering |

When an LLM provider is configured, a **quality score** (0–100) is blended at **60% LLM / 40% heuristic**.

## Configuration

### Environment Variables

| Variable | Provider | Required For |
|----------|----------|-------------|
| `GITHUB_TOKEN` | GitHub | All commands |
| `GEMINI_API_KEY` | Gemini (default) | LLM scoring, embeddings, vision |
| `OPENAI_API_KEY` | OpenAI | LLM scoring, embeddings |
| `ANTHROPIC_API_KEY` | Anthropic | LLM scoring (embeddings via fallback) |
| `OPENROUTER_API_KEY` | OpenRouter | Multi-model gateway (200+ models) |
| `TRELIQ_MODEL` | Any | Override default model for any provider |

### Server Configuration

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port` | `4747` | Server port |
| `--host` | `0.0.0.0` | Bind address |
| `--webhook-secret` | — | GitHub webhook HMAC secret |
| `--schedule` | — | Cron expression for auto-scanning |
| `--scheduled-repos` | — | Comma-separated repos to scan on schedule |
| `--slack-webhook` | — | Slack notification webhook URL |
| `--discord-webhook` | — | Discord notification webhook URL |

## SSE Real-time Events

Connect to `/api/events` for live updates:

```javascript
const events = new EventSource('http://localhost:4747/api/events');

events.addEventListener('scan_start', (e) => {
  console.log('Scan started:', JSON.parse(e.data));
});

events.addEventListener('scan_complete', (e) => {
  const { repo, totalPRs, spamCount } = JSON.parse(e.data);
  console.log(`Scanned ${totalPRs} PRs, ${spamCount} spam`);
});

events.addEventListener('pr_scored', (e) => {
  const { prNumber, totalScore } = JSON.parse(e.data);
  console.log(`PR #${prNumber} scored ${totalScore}/100`);
});
```

## Webhook Integration

1. Create a GitHub App or webhook at **Settings → Webhooks**
2. Set URL to `https://your-server/webhooks`
3. Set content type to `application/json`
4. Select events: `Pull requests`
5. Start server with `--webhook-secret YOUR_SECRET`

Treliq automatically scores PRs on `opened`, re-scores on `synchronize`, and updates state on `closed`/`reopened`.

## Inspired By

| Tool | What We Learned |
|------|----------------|
| [Qodo PR-Agent](https://github.com/qodo-ai/pr-agent) | `/review` command pattern |
| [Greptile](https://greptile.com) | Full codebase context matters |
| [ai-duplicate-detector](https://github.com/mackgorski/ai-duplicate-detector) | Embedding threshold system |

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Use conventional commits (`feat:`, `fix:`, `docs:`, etc.)
4. Add tests for new functionality
5. Open a PR — Treliq will score it automatically 😉

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

## License

MIT © [Mahsum Aktaş](https://github.com/mahsumaktas)

---

<p align="center">
  <em>Built because 3,100 PRs won't triage themselves.</em>
</p>
