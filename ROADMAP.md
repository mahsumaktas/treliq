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

## v0.4 — Real-Time & Persistence (Planned)

- Webhook-based real-time PR updates
- Incremental DB with SQLite for history tracking
- Cross-repo analysis (scan multiple repos at once)
- Custom scoring rule overrides

## v0.5 — Distribution (Planned)

- npm publish (`npm install -g treliq`)
- GitHub Marketplace App (one-click install)
- Slack / Discord notifications
- Team-based triage queues

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
