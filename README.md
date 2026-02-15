<p align="center">
  <img src="docs/logo.png" alt="Treliq" width="120" />
</p>

<h1 align="center">Treliq</h1>

<p align="center">
  <strong>AI-Powered PR Triage for Open Source Maintainers</strong>
</p>

> *"3,100 PRs. Which ones should I merge?"* — Every maintainer, eventually.

Treliq is an intelligent PR triage system that helps open source maintainers manage the flood of pull requests. It deduplicates, scores, and ranks PRs so you can focus on merging the best ones.

## The Problem

Existing tools review code (CodeRabbit, Greptile, Copilot). None of them answer the maintainer's real question:

- **"These 5 PRs fix the same bug — which one is best?"**
- **"Does this PR align with our roadmap?"**
- **"Show me the top 10 PRs I should review today."**

Code Review ≠ PR Triage. Treliq fills the gap.

## Features

### v0.1 — Foundation (Current)
- [ ] 🔍 **PR Dedup** — Semantic similarity detection across open PRs
- [ ] 📊 **Multi-Signal Scoring** — Code quality, test coverage, CI status, commit quality, contributor history
- [ ] 📋 **Vision Doc Alignment** — Check if PR matches project roadmap/guidelines
- [ ] 🏆 **"Best PR" Selection** — When multiple PRs solve the same issue, pick the winner
- [ ] 🚫 **Spam Filter** — Heuristic + AI spam/low-effort detection
- [ ] 📦 **Batch Scan** — Analyze all open PRs at once (not just event-driven)

### v0.2 — Planned
- [ ] 🖥️ **Dashboard** — Web UI for maintainer overview
- [ ] 👤 **Contributor Reputation** — Track contributor history and trust scores
- [ ] 🔄 **Cross-Repo Search** — Find related PRs across organization
- [ ] 💬 **PR Commands** — `/treliq review`, `/treliq score`, `/treliq compare`

## Architecture

```
├── GitHub App (Webhook)     — Real-time event listening
├── TypeScript + Probot      — GitHub API integration
├── LanceDB                  — PR/Issue embeddings (serverless, no infra)
├── Gemini/Claude API        — Deep review + vision alignment
├── SQLite                   — State/history persistence
├── CLI                      — Batch scan ("scan all open PRs")
└── Dashboard (React)        — Maintainer overview (v0.2)
```

## How It Works

```
New PR opened
    │
    ▼
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Spam Filter │────▶│  Dedup Check  │────▶│  Multi-Signal │────▶│   Vision Doc  │
│  (Heuristic) │     │  (Embedding)  │     │   Scoring     │     │  Alignment    │
└─────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
                                                                       │
                                                                       ▼
                                                              ┌──────────────┐
                                                              │  PR Comment   │
                                                              │  + Dashboard  │
                                                              └──────────────┘
```

### Scoring Signals

| Signal | Weight | Source |
|--------|--------|--------|
| Semantic similarity to other PRs | High | LanceDB embeddings |
| CI pass/fail | High | GitHub Checks API |
| Test coverage delta | Medium | CI artifacts |
| Code quality (lint, complexity) | Medium | LLM analysis |
| Commit message quality | Low | Conventional commits check |
| Contributor history | Medium | GitHub API (past PRs, merge rate) |
| Breaking change detection | High | LLM diff analysis |
| Vision doc alignment | High | LLM + VISION.md comparison |

## Quick Start

### As GitHub Action
```yaml
# .github/workflows/treliq.yml
name: Treliq PR Triage
on:
  pull_request:
    types: [opened, synchronize]
  workflow_dispatch:
    inputs:
      scan_all:
        description: 'Scan all open PRs'
        type: boolean

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: mahsumaktas/treliq@v0.1
        with:
          gemini-api-key: ${{ secrets.GEMINI_API_KEY }}
          vision-doc: './VISION.md'  # Optional: project roadmap
```

### As CLI
```bash
npx treliq scan --repo owner/repo --token $GITHUB_TOKEN
npx treliq compare --pr 123 456 789  # Compare 3 PRs
npx treliq score --pr 123            # Score a single PR
```

## Inspired By

| Tool | What We Learned |
|------|----------------|
| [Qodo PR-Agent](https://github.com/qodo-ai/pr-agent) | `/review` command pattern |
| [Greptile](https://greptile.com) | Full codebase context matters |
| [ai-duplicate-detector](https://github.com/mackgorski/ai-duplicate-detector) | Embedding threshold system |
| [Simili-bot](https://github.com/similigh/simili-bot) | Modular triage pipeline |
| [PRShield](https://github.com/kunalsz/PRShield) | Simple heuristic scoring as first filter |

## Why TypeScript?

- **Probot** framework for GitHub Apps
- **Octokit** for GitHub API
- **Vercel AI SDK** for LLM integration
- Best ecosystem for GitHub tooling
- Claude Code writes it fluently

## Contributing

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © [Mahsum Aktaş](https://github.com/mahsumaktas)

---

*Built because Dify was too expensive, Simili-bot was too limited, and 3,100 PRs won't triage themselves.*
