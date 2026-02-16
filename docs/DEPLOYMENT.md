# Deployment Guide

Deploy Treliq as a self-hosted GitHub App for automatic PR triage.

## Quick Start (Docker)

```bash
git clone https://github.com/mahsumaktas/treliq.git && cd treliq
cp .env.example .env   # Edit with your tokens
docker compose up -d
# Open http://localhost:4747
```

## Quick Start (npm)

```bash
npm install -g treliq
export GITHUB_TOKEN=ghp_xxx
export GEMINI_API_KEY=xxx
treliq server --port 4747
```

## Authentication Modes

| | PAT Mode | App Mode |
|---|----------|----------|
| **Setup** | Quick (just a token) | Requires GitHub App creation |
| **Security** | Full account access | Scoped to installed repos |
| **Multi-repo** | Manual per-repo | Auto via installation |
| **Best for** | Personal use | Production, teams |

## Environment Variables

| Variable | Mode | Description |
|----------|------|-------------|
| `GITHUB_TOKEN` | PAT | Personal access token |
| `GITHUB_APP_ID` | App | GitHub App ID |
| `GITHUB_PRIVATE_KEY_PATH` | App | Path to .pem file |
| `GITHUB_WEBHOOK_SECRET` | App | Webhook signature secret |
| `GEMINI_API_KEY` | Both | Google Gemini API key |
| `OPENAI_API_KEY` | Both | OpenAI API key (alternative) |
| `ANTHROPIC_API_KEY` | Both | Anthropic API key (alternative) |

## GitHub App Setup

1. Start server: `treliq server --port 4747`
2. Open `http://your-server:4747/setup`
3. Click **"Create GitHub App"**
4. Save credentials from callback page
5. Add to environment, restart server
6. Install app on your repositories

## Production (systemd + nginx)

### systemd service

```ini
[Unit]
Description=Treliq PR Triage
After=network.target

[Service]
Type=simple
User=treliq
WorkingDirectory=/opt/treliq
EnvironmentFile=/opt/treliq/.env
ExecStart=/usr/bin/node dist/cli.js server --port 4747
Restart=always

[Install]
WantedBy=multi-user.target
```

### nginx reverse proxy

```nginx
server {
    listen 443 ssl;
    server_name treliq.example.com;
    ssl_certificate /etc/letsencrypt/live/treliq.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/treliq.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4747;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;  # Required for SSE
    }
}
```
