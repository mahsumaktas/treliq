# Contributing to Treliq

Thanks for your interest in contributing! 🎉

## Getting Started

```bash
git clone https://github.com/mahsumaktas/treliq.git
cd treliq
npm install
npm run dev
```

## Project Structure

```
src/
├── index.ts          # Main exports
├── cli.ts            # CLI entry point
├── core/
│   ├── types.ts      # Type definitions
│   ├── scanner.ts    # GitHub PR fetcher
│   ├── dedup.ts      # Duplicate detection (LanceDB)
│   ├── scoring.ts    # Multi-signal scoring
│   └── vision.ts     # Vision document alignment
├── signals/          # Individual scoring signal implementations
└── utils/            # Shared utilities
```

## Development

- **Language:** TypeScript (strict mode)
- **Style:** ESLint + Prettier
- **Tests:** Jest
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, etc.)

## PR Guidelines

1. One feature per PR
2. Include tests for new features
3. Update README if adding user-facing changes
4. Reference related issues (`Fixes #123`)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
