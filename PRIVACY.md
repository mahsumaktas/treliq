# Privacy Policy

**Treliq** is a self-hosted, open-source tool. This privacy policy explains how data is handled.

## Data Collection

Treliq is self-hosted — **we do not collect, store, or transmit any data** to external servers controlled by the Treliq project.

All data stays on your infrastructure.

## What Treliq Accesses

When installed as a GitHub App, Treliq accesses the following via GitHub's API:

| Permission | Access | Purpose |
|------------|--------|---------|
| Pull Requests | Read/Write | Score, rank, and comment on PRs |
| Contents | Read | Analyze changed files and test coverage |
| Checks | Read | Evaluate CI/CD status |
| Issues | Write | Post triage comments |

## Data Storage

- **SQLite database**: PR metadata, scores, and scan history are stored locally on your server
- **No cloud storage**: Data never leaves your infrastructure
- **No analytics**: Treliq does not include telemetry or analytics

## Third-Party Services

Treliq connects to services **you configure**:

| Service | When Used | Data Sent |
|---------|-----------|-----------|
| GitHub API | Always | API requests for PR data |
| Gemini/OpenAI/Anthropic | If configured | PR title + body for scoring |
| Slack/Discord | If configured | Scan result summaries |

**You provide your own API keys.** Treliq does not proxy requests through any intermediary.

## Security

- Webhook payloads are verified using HMAC-SHA256 signatures
- GitHub App tokens are scoped to installed repositories only
- Private keys are stored on your server, never transmitted
- See [SECURITY.md](SECURITY.md) for vulnerability reporting

## Contact

For privacy questions: **mahsum@mahsumaktas.com**

*Last updated: February 2025*
