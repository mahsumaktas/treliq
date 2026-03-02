# Contributing to Treliq

Thanks for your interest in contributing!

## Getting Started

```bash
git clone https://github.com/mahsumaktas/treliq.git
cd treliq
npm install
npm test
```

## Project Structure

```
src/
├── index.ts              # Main exports
├── cli.ts                # CLI entry point (Commander.js)
├── core/
│   ├── types.ts          # Type definitions (PRData, ScoredPR, SignalScore)
│   ├── scanner.ts        # GitHub PR fetcher (GraphQL + REST)
│   ├── scoring.ts        # 21-signal scoring engine (TOPSIS, cascade)
│   ├── dedup.ts          # Duplicate detection (LanceDB + LLM verify)
│   ├── vision.ts         # Vision document alignment
│   ├── intent.ts         # Intent classifier
│   ├── issue-scorer.ts   # 12-signal issue scoring
│   ├── diff-analyzer.ts  # Diff-aware code quality analysis
│   ├── semantic-matcher.ts # Issue-PR matching
│   ├── holistic-ranker.ts  # Tournament-style re-ranking
│   ├── db.ts             # SQLite persistence
│   ├── provider.ts       # LLM provider abstraction
│   ├── graphql.ts        # GitHub GraphQL queries
│   ├── logger.ts         # Pino structured logging
│   ├── cache.ts          # Incremental cache
│   ├── ratelimit.ts      # GitHub API rate limiting
│   ├── vectorstore.ts    # LanceDB wrapper
│   ├── retryable-provider.ts # Exponential backoff
│   ├── concurrency.ts    # Semaphore-based throttling
│   ├── auth.ts           # GitHub auth
│   ├── actions.ts        # Auto-close, merge, label planning
│   ├── action-executor.ts # GitHub API execution
│   └── notifications.ts  # Slack/Discord webhooks
└── server/
    ├── index.ts          # Server entry point
    ├── app.ts            # Fastify routes + middleware
    ├── webhooks.ts       # GitHub webhook handler
    ├── scheduler.ts      # Cron scheduler
    └── sse.ts            # Server-Sent Events

scripts/                  # Utility scripts (bulk scoring, dedup)
dashboard/                # Static HTML dashboard
docs/                     # Documentation (signals, API, architecture)
```

## Development

- **Language:** TypeScript (strict mode)
- **Style:** ESLint
- **Tests:** Jest (428 tests across 28 suites)
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, etc.)

## PR Guidelines

1. One feature per PR
2. Include tests for new features
3. Update README if adding user-facing changes
4. Reference related issues (`Fixes #123`)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
