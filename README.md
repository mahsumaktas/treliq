<p align="center">
  <img src="docs/logo.png" alt="Treliq" width="140" />
</p>

<h3 align="center">AI-Powered PR & Issue Triage for Maintainers & Enterprise Teams</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/treliq"><img src="https://img.shields.io/npm/v/treliq?style=flat-square&color=CB3837&logo=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/treliq"><img src="https://img.shields.io/npm/dm/treliq?style=flat-square&color=CB3837" alt="npm downloads" /></a>
  <a href="https://github.com/mahsumaktas/treliq/actions"><img src="https://img.shields.io/github/actions/workflow/status/mahsumaktas/treliq/ci.yml?branch=main&style=flat-square" alt="CI" /></a>
  <img src="https://img.shields.io/badge/tests-428_passing-2DA44E?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/signals-21+12-8B5CF6?style=flat-square" alt="33 Signals" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License: MIT" /></a>
</p>

---

Treliq scores, deduplicates, and ranks pull requests **and** issues so maintainers focus on what matters. Available as a **CLI**, **REST server**, and **GitHub Action**.

## The Problem

Code review tools (CodeRabbit, Greptile, Copilot) review diffs. None answer the maintainer's real questions:

- **"These 5 PRs fix the same bug — which one is best?"**
- **"Show me the top 10 PRs I should review today."**
- **"Auto-close all the duplicate PRs and spam issues."**

**Code Review != PR Triage. Treliq fills the gap.**

## Quick Start

```bash
# Install
npm install -g treliq

# Score all open PRs (21 signals, no API key needed)
npx treliq scan -r owner/repo --no-llm

# Score PRs + issues together
npx treliq scan -r owner/repo --include-issues

# Find duplicate PR clusters
npx treliq dedup -r owner/repo

# Score a single PR with LLM (needs GEMINI_API_KEY)
npx treliq score -r owner/repo -n 123 -f markdown

# Interactive setup wizard
npx treliq init
```

## Output Example

```
 #  PR                                          Score  Tier      Scored By
 1  feat: add streaming response support        92     critical  sonnet
 2  fix: resolve memory leak in scanner         87     high      sonnet
 3  refactor: extract scoring engine             71     high      haiku
 4  chore(deps): bump express to v5             45     normal    heuristic
 5  docs: update API reference                  28     low       heuristic

Duplicate Clusters:
  Cluster 1 (93% similarity): #42, #67, #89 — "fix rate limiter"
  Cluster 2 (87% similarity): #15, #31 — "add dark mode"

Spam: #99 (empty diff), #101 (AI-generated boilerplate)
```

## Dashboard

**[Live Demo](https://mahsumaktas.github.io/treliq/)**

<p align="center">
  <img src="docs/screenshots/dashboard-dark.jpg" alt="Treliq Dashboard" width="800" />
</p>

## Key Features

- **21 PR Signals + 12 Issue Signals** — CI status, test coverage, merge conflicts, spam detection, intent classification, contributor trust, and more ([full list](docs/SIGNALS.md))
- **Cascade Pipeline** — Heuristic pre-filter -> Haiku -> Sonnet. ~$13 for 4000 PRs (vs $27 Sonnet-only)
- **Dual Scoring** — `ideaScore` (is the idea valuable?) + `implementationScore` (is the code good?) + `readinessScore` (is it merge-ready?)
- **Cross-type Dedup** — PRs and issues in the same vector space; LLM-verified clusters
- **Auto-Actions** — Close duplicates, close spam, auto-merge, auto-label by intent (dry-run by default)
- **Multi-Provider LLM** — Gemini (free), OpenAI, Anthropic, OpenRouter (200+ models)
- **Server Mode** — Fastify REST API, SSE real-time events, cron scheduler, Slack/Discord webhooks ([API docs](docs/API.md))
- **Zero-Cost Mode** — `--no-llm` runs 21-signal heuristic scoring with zero API calls

## Architecture

```
CLI / GitHub Action / REST API
        |
   PR & Issue Scanner (GitHub GraphQL + REST)
        |
   21-Signal Scoring (TOPSIS) + Intent Classification
        |
   Cascade LLM Pipeline (Heuristic -> Haiku -> Sonnet)
        |
   Diff Analysis + Vision Doc Alignment
        |
   Cross-type Dedup (LanceDB embeddings + LLM verify)
        |
   Semantic Issue-PR Matching + Holistic Re-ranking
        |
   Auto-Actions (close dupes, spam, merge, label)
        |
   Output: table / JSON / markdown / dashboard / SSE
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full Mermaid diagram.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub API access |
| `GEMINI_API_KEY` | For LLM | Gemini scoring + embeddings + vision (free tier) |
| `OPENAI_API_KEY` | For LLM | OpenAI scoring + embeddings |
| `ANTHROPIC_API_KEY` | For LLM | Anthropic scoring (embeddings via Gemini/OpenAI fallback) |
| `OPENROUTER_API_KEY` | For LLM | 200+ models via OpenRouter |
| `TRELIQ_MODEL` | No | Override default model for any provider |

## Auto-Actions

```bash
# Preview (dry-run, safe)
npx treliq scan -r owner/repo \
  --auto-close-dupes --auto-close-spam \
  --auto-merge --merge-threshold 90 \
  --auto-label-intent

# Execute for real
npx treliq scan -r owner/repo \
  --auto-close-dupes --auto-close-spam --auto-merge \
  --auto-label-intent --confirm
```

## Server Mode

```bash
# Start with dashboard
npx treliq server -r owner/repo -p 4747

# With webhooks + cron + notifications
npx treliq server -r owner/repo -p 4747 \
  --webhook-secret $WEBHOOK_SECRET \
  --schedule "0 */6 * * *" \
  --slack-webhook $SLACK_URL
```

See [docs/API.md](docs/API.md) for all endpoints and SSE events.

## GitHub Action

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

## Comparison

| Feature | Treliq | CodeRabbit | Greptile | Copilot |
|---------|--------|-----------|---------|---------|
| PR scoring & ranking | Yes | No | No | No |
| Issue triage | Yes | No | No | No |
| Duplicate detection | Yes | No | No | No |
| Auto-close/merge/label | Yes | No | No | No |
| Heuristic-only mode | Yes | N/A | N/A | N/A |
| Multi-provider LLM | 4 providers | OpenAI | Proprietary | GitHub |
| Self-hosted server | Yes | SaaS | SaaS | SaaS |
| Code review | No | Yes | Yes | Yes |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT (c) [Mahsum Aktas](https://github.com/mahsumaktas)

---

**Docs:** [CHANGELOG](CHANGELOG.md) | [Signals](docs/SIGNALS.md) | [API](docs/API.md) | [Architecture](docs/ARCHITECTURE.md)
