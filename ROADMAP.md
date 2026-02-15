# Treliq Roadmap

## v0.1 — Foundation (MVP)
**Goal:** Scan a repo's open PRs, find duplicates, score them, output results.

### Core Features
1. **CLI Scanner** — `treliq scan --repo owner/repo`
   - Fetch all open PRs via GitHub API
   - Extract: title, description, diff stats, files changed, CI status
   - Store PR embeddings in LanceDB

2. **Semantic Dedup** — Find PR groups that solve the same problem
   - Embed PR title + description + file paths using Gemini embedding-001
   - Cosine similarity search (threshold: 0.85 = duplicate, 0.80 = related)
   - Group duplicates into clusters

3. **Multi-Signal Scoring** — Rate each PR on 8 dimensions
   - CI status (pass/fail/pending)
   - Diff size (additions + deletions)
   - File count
   - Commit count and message quality
   - Contributor history (first PR? repeat contributor?)
   - Issue reference (fixes #123?)
   - Conventional commits compliance
   - Spam heuristics (single file, tiny change, docs-only)

4. **Vision Doc Alignment** — Optional VISION.md check
   - If repo has VISION.md or ROADMAP.md, compare PR against it
   - LLM judges: "Does this PR align with project direction?"
   - Output: ✅ Aligned / ⚠️ Tangential / ❌ Off-roadmap

5. **Output Formats**
   - Terminal table (default)
   - JSON (for automation)
   - Markdown (for GitHub comments)
   - GitHub PR comment (via `--comment` flag)

### Tech Stack
- TypeScript + Node.js
- @octokit/rest (GitHub API)
- @lancedb/lancedb (vector embeddings)
- better-sqlite3 (state/cache)
- Gemini API (embedding + review)
- commander (CLI)

---

## v0.2 — GitHub Integration
- GitHub Actions workflow
- GitHub App (webhook-based, real-time)
- `/treliq` PR comment commands
- Probot framework

## v0.3 — Dashboard
- Next.js web UI
- PR overview with scores
- Duplicate groups visualization
- Contributor leaderboard

## v0.4 — Enterprise
- Cross-repo analysis
- Custom scoring rules
- Team-based triage queues
- Slack/Discord notifications

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
