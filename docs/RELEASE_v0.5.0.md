# Treliq v0.5.0

Treliq v0.5.0 focuses on two goals:

- Faster onboarding for new maintainers.
- Stronger confidence in every triage result.

## Highlights

- Added `treliq init` interactive setup wizard.
- Added `treliq demo` for no-key, zero-friction first run.
- Improved free-tier workflow with clearer `--no-llm` guidance.
- Expanded core test coverage across scanner, webhooks, auth, provider, and vectorstore paths.
- Hardened CI quality gates (`build + lint + test --coverage`).

## Quality Snapshot

- 218 passing tests
- 85.12% line coverage
- 84.01% statement coverage
- 70.08% branch coverage
- 91.83% function coverage

## Why this release matters

If you maintain an active OSS repo, v0.5.0 reduces setup friction and raises trust:

- You can start with `treliq demo` in seconds.
- You can configure real scanning with `treliq init` in minutes.
- You get more reliable automation from stronger test and CI gates.

## Quick Start

```bash
npm i -g treliq
treliq demo
treliq init
treliq scan -r owner/repo --no-llm
```
