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

### v0.1 — Foundation
- ✅ 🔍 **PR Dedup** — Semantic similarity detection across open PRs
- ✅ 📊 **Multi-Signal Scoring** — Code quality, test coverage, CI status, commit quality, contributor history
- ✅ 📋 **Vision Doc Alignment** — Check if PR matches project roadmap/guidelines
- ✅ 🏆 **"Best PR" Selection** — When multiple PRs solve the same issue, pick the winner
- ✅ 🚫 **Spam Filter** — Heuristic + AI spam/low-effort detection
- ✅ 📦 **Batch Scan** — Analyze all open PRs at once

### v0.2 — LLM Integration
- ✅ 🤖 **Gemini AI Scoring** — Deep PR quality analysis via Gemini
- ✅ 🔗 **Embedding Dedup** — Vector similarity for duplicate detection

### v0.3 — PR Commands & Dashboard ✨ NEW
- ✅ 💬 **PR Commands** — `/treliq score`, `/treliq scan` via GitHub Action
- ✅ 🖥️ **Dashboard** — Static HTML dashboard for PR overview (gh-pages ready)
- ✅ 🎯 **Single PR Scoring** — `treliq score -r owner/repo -n 123`
- ✅ ⚡ **Auto-scan** — Automatically score new PRs on open/synchronize

## Quick Start

### CLI

```bash
# Score a single PR
npx treliq score -r owner/repo -n 123 -f markdown

# Scan all open PRs
npx treliq scan -r owner/repo -m 100 -f json

# Find duplicates
npx treliq dedup -r owner/repo

# Trust known contributors (exempt from spam detection)
npx treliq scan -r owner/repo --trust-contributors
```

### GitHub Action

Add to your repo's `.github/workflows/treliq-scan.yml`:

```yaml
name: Treliq PR Triage
on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  auto-scan:
    if: github.event_name == 'pull_request'
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
          RESULT=$(npx treliq score -r ${{ github.repository }} -n ${{ github.event.pull_request.number }} -f markdown)
          echo "result<<EOF" >> $GITHUB_OUTPUT
          echo "$RESULT" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT
      - uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.payload.pull_request.number,
              body: process.env.SCORE_RESULT,
            });
        env:
          SCORE_RESULT: ${{ steps.score.outputs.result }}
```

**Required secrets:**
- `GEMINI_API_KEY` — Get from [Google AI Studio](https://aistudio.google.com/apikey)
- `GITHUB_TOKEN` — Automatic, no setup needed

**PR Commands:**
- Comment `/treliq score` on any PR to get its triage score
- Comment `/treliq scan` on any PR to scan all open PRs

### Dashboard

Open `dashboard/index.html` in a browser or deploy to GitHub Pages:

**[Live Demo →](https://mahsumaktas.github.io/treliq/)**

- Paste scan JSON or load from URL
- Sortable PR table by score, files, author
- Duplicate cluster visualization
- Spam detection flags

Generate fresh data: `npm run dashboard`

## Architecture

```
├── CLI (Commander.js)        — scan, score, dedup commands
├── GitHub Action             — Auto-scan + PR commands
├── LanceDB                   — PR/Issue embeddings (serverless)
├── Gemini API                — Deep review + vision alignment
├── SQLite                    — State/history persistence
├── Dashboard (Static HTML)   — Single-file, no build step
└── Octokit                   — GitHub API integration
```

### Scoring Signals

| Signal | Weight | Source |
|--------|--------|--------|
| Semantic similarity to other PRs | High | LanceDB embeddings |
| CI pass/fail | High | GitHub Checks API |
| Code quality (lint, complexity) | Medium | LLM analysis |
| Commit message quality | Low | Conventional commits check |
| Contributor history | Medium | GitHub API |
| Breaking change detection | High | LLM diff analysis |
| Vision doc alignment | High | LLM + VISION.md comparison |

## Inspired By

| Tool | What We Learned |
|------|----------------|
| [Qodo PR-Agent](https://github.com/qodo-ai/pr-agent) | `/review` command pattern |
| [Greptile](https://greptile.com) | Full codebase context matters |
| [ai-duplicate-detector](https://github.com/mackgorski/ai-duplicate-detector) | Embedding threshold system |

## License

MIT © [Mahsum Aktaş](https://github.com/mahsumaktas)

---

*Built because 3,100 PRs won't triage themselves.*
