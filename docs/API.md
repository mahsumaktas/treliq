# Treliq Server API

Start the server:

```bash
npx treliq server -r owner/repo -p 4747
```

## Server Options

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port` | `4747` | Server port |
| `--host` | `0.0.0.0` | Bind address |
| `--webhook-secret` | — | GitHub webhook HMAC secret |
| `--schedule` | — | Cron expression for auto-scanning |
| `--scheduled-repos` | — | Comma-separated repos to scan on schedule |
| `--slack-webhook` | — | Slack notification webhook URL |
| `--discord-webhook` | — | Discord notification webhook URL |

## REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Dashboard UI |
| `GET` | `/health` | Health check |
| `GET` | `/api/repos` | List tracked repositories |
| `GET` | `/api/repos/:owner/:repo/prs` | List scored PRs (sortable, filterable) |
| `GET` | `/api/repos/:owner/:repo/prs/:number` | Single PR details |
| `POST` | `/api/repos/:owner/:repo/scan` | Trigger a new scan |
| `GET` | `/api/repos/:owner/:repo/scans` | Scan history |
| `GET` | `/api/repos/:owner/:repo/spam` | Spam PRs |
| `GET` | `/api/repos/:owner/:repo/issues` | List scored issues (sortable, filterable) |
| `GET` | `/api/events` | SSE real-time stream |
| `POST` | `/webhooks` | GitHub webhook receiver |
| `GET` | `/setup` | GitHub App setup guide |

## SSE Events

Connect to `/api/events` for live updates:

```javascript
const events = new EventSource('http://localhost:4747/api/events');

events.addEventListener('scan_start', (e) => {
  console.log('Scan started:', JSON.parse(e.data));
});

events.addEventListener('scan_complete', (e) => {
  const { repo, totalPRs, spamCount } = JSON.parse(e.data);
  console.log(`Scanned ${totalPRs} PRs, ${spamCount} spam`);
});

events.addEventListener('pr_scored', (e) => {
  const { prNumber, totalScore } = JSON.parse(e.data);
  console.log(`PR #${prNumber} scored ${totalScore}/100`);
});
```

## Webhook Integration

1. Create a GitHub App or webhook at **Settings -> Webhooks**
2. Set URL to `https://your-server/webhooks`
3. Set content type to `application/json`
4. Select events: `Pull requests`
5. Start server with `--webhook-secret YOUR_SECRET`

Treliq scores PRs on `opened`, re-scores on `synchronize`, and updates state on `closed`/`reopened`.

## Security

- **Rate limiting**: Global 100/min, scan 5/5min (`@fastify/rate-limit`)
- **Security headers**: Helmet CSP, X-Frame-Options, X-Content-Type-Options
- **CORS**: Configurable via `CORS_ORIGINS` environment variable
- **Webhook auth**: HMAC-SHA256 via `crypto.timingSafeEqual`
- **Input validation**: Fastify JSON Schema with owner/repo pattern validation
