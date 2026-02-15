<p align="center">
  <img src="docs/logo.png" alt="Treliq" width="120" />
</p>

<p align="center">
  <strong>AI-Powered PR Triage for Open Source Maintainers</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/version-0.3.0-green.svg" alt="Version 0.3.0" />
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node 20+" />
</p>

---

> *"3,100 PRs. Which ones should I merge?"* — Every maintainer, eventually.

Treliq is an intelligent PR triage system that helps open source maintainers manage the flood of pull requests. It deduplicates, scores, and ranks PRs so you can focus on merging the best ones.

## The Problem

Existing tools review code (CodeRabbit, Greptile, Copilot). None of them answer the maintainer's real question:

- **"These 5 PRs fix the same bug — which one is best?"**
- **"Does this PR align with our roadmap?"**
- **"Show me the top 10 PRs I should review today."**

Code Review ≠ PR Triage. Treliq fills the gap.

## Features

- 🔍 **Semantic PR Dedup** — Embedding similarity via Gemini to find duplicate/related PRs
- 📊 **13-Signal Scoring** — CI, test coverage, merge conflicts, staleness, diff size, commit quality, contributor trust + reputation, issue refs, spam detection, review status, body quality, activity, breaking change detection
- 🤖 **LLM-Assisted Analysis** — Gemini Flash judges practical value, not authorship
- 📋 **Vision Doc Alignment** — Checks PRs against VISION.md/ROADMAP.md
- 💬 **GitHub Action + PR Commands** — `/treliq score`, `/treliq scan` from PR comments
- 🖥️ **Static Dashboard** — Dark/light theme, sortable, no build step
- ⚡ **Incremental Cache** — Only re-scores changed PRs
- 🎯 **Single PR Scoring** — `treliq score -n 123`
- 🛡️ **Smart Spam Detection** — With `--trust-contributors` option

## Quick Start

```bash
# Score a single PR
npx treliq score -r owner/repo -n 123 -f markdown

# Scan all open PRs
npx treliq scan -r owner/repo -m 100 -f json

# Find duplicate PR clusters
npx treliq dedup -r owner/repo

# Trust known contributors (exempt from spam detection)
npx treliq scan -r owner/repo --trust-contributors
```

**Required env vars:**
- `GITHUB_TOKEN` — GitHub personal access token
- `GEMINI_API_KEY` — From [Google AI Studio](https://aistudio.google.com/apikey)

## GitHub Action Setup

Add `.github/workflows/treliq.yml`:

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
          RESULT=$(treliq score -r ${{ github.repository }} -n ${{ github.event.pull_request.number }} -f markdown)
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

**PR Commands:** Comment `/treliq score` or `/treliq scan` on any PR.

## Dashboard

**[Live Demo →](https://mahsumaktas.github.io/treliq/)**

- Paste scan JSON or load from URL
- Sortable PR table by score, files, author
- Duplicate cluster visualization
- Dark/light theme toggle

Generate fresh data: `npm run dashboard`

## Scoring Signals

| Signal | Weight | Description |
|--------|--------|-------------|
| CI Status | 0.20 | Pass / fail / pending from GitHub Checks |
| Test Coverage | 0.15 | Whether test files were changed alongside code |
| Merge Conflicts | 0.15 | Mergeable / conflicting / unknown |
| Contributor Trust | 0.15 | Author association + GitHub reputation (followers, repos, account age) |
| Spam Detection | 0.15 | Heuristic flags: tiny diff, docs-only, single-file |
| Review Status | 0.10 | Approved / changes requested / commented / none |
| Diff Size | 0.10 | Lines changed — penalizes extremes |
| Staleness | 0.10 | Days since PR opened |
| Issue References | 0.10 | Links to issues via `Fixes #123` etc. |
| Commit Quality | 0.05 | Conventional commit format check |
| Body Quality | 0.05 | PR description length, checklists, screenshots |
| Conversation Activity | 0.05 | Comment count — active discussion signals engagement |
| Breaking Change | 0.05 | Detects breaking changes via title, risky files, large deletions |

> Weights total > 1.0 because the final score is a weighted average, not a sum.

When a Gemini API key is provided, an **LLM quality score** (0–100) is blended in at 60% LLM / 40% heuristic.

## Architecture

```
┌─────────────────────────────────────────────┐
│                   CLI (Commander.js)         │
│            scan · score · dedup              │
├──────────┬──────────┬───────────┬────────────┤
│ Octokit  │ LanceDB  │ Gemini    │ SQLite     │
│ GitHub   │ Vector   │ LLM +     │ Cache &    │
│ API      │ Embeddings│ Embeddings│ State      │
├──────────┴──────────┴───────────┴────────────┤
│              Scoring Engine                   │
│  13 signals → weighted avg → LLM blend       │
├──────────────────────────────────────────────┤
│  Vision Checker · Dedup Engine · Spam Filter  │
├──────────────────────────────────────────────┤
│  GitHub Action        │  Static Dashboard     │
│  Auto-scan + Commands │  HTML, no build step  │
└───────────────────────┴──────────────────────┘
```

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
