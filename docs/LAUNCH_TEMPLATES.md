# Treliq Launch Templates

These templates are designed to help you share Treliq across different platforms to gain maximum visibility and traction.

## 🟠 Hacker News (Show HN)

**Title:** Show HN: Treliq - AI-Powered PR Triage that deduplicates & scores pull requests

**Body:**
Hi HN,

I built Treliq because I noticed a gap in the current dev-tooling landscape. While tools like CodeRabbit or GitHub Copilot are great for *Code Review* (explaining what a PR does), they don't solve the core *PR Triage* problem: "I have 50 open PRs across 3 repos. Which ones should I review and merge first to unblock my team?"

Treliq is an open-source CLI and server that scores, deduplicates, and ranks PRs based on 20 different signals (CI status, test coverage, merge conflicts, diff size complexity, and optional LLM quality assessment).

**Key Features:**
- **Zero-Setup Mode:** Run `npx treliq scan -r owner/repo --no-llm` to get a heuristics-only score instantly without any API keys.
- **Deduplication:** Uses LanceDB and embeddings to detect duplicate PRs (e.g., 5 people trying to fix the same open issue) and groups them together.
- **Server/Dashboard:** You can run it as a Fastify server with SSE real-time updates and a dashboard: `npx treliq server -p 4747`.
- **Multi-Model Support:** Plug in Anthropic, OpenAI, OpenRouter, or Gemini to handle the qualitative scoring (60% LLM / 40% heuristic).

If you are a maintainer or work in a busy enterprise engineering team where PRs pile up, I'd love your feedback. 

Repo: https://github.com/mahsumaktas/treliq
Live Demo: https://mahsumaktas.github.io/treliq/

Would love to hear your thoughts, roasts, or feature requests!

---

## 🔴 Reddit (r/opensource, r/typescript, r/webdev)

**Title:** I built an open-source tool to solve "PR Fatigue" for teams and maintainers

**Body:**
Hey everyone,

We all know the pain of staring at a massive backlog of PRs. Code review bots summarize the code, but they don't help you prioritize *which* PRs to look at first.

I built **Treliq** to fix this. It’s an AI-powered PR triage system that scores, ranks, and deduplicates PRs. 

It evaluates PRs across 20 signals:
- Is CI passing? 
- Did they add tests?
- Is it a massive 50-file refactor dumped in a single commit?
- Is it a duplicate of another open PR? 

Then it gives you a clean dashboard or terminal output ranking them from best (merge right now) to worst (spam/conflicting).

**The best part?** If you are tired of AI tools asking for API keys, there is a `--no-llm` mode that runs entirely on local heuristics. Just run:
`npx treliq scan -r owner/repo --no-llm`

Tech stack: TypeScript, Fastify, SQLite, LanceDB (for vector embeddings), and multi-LLM support (Anthropic, OpenAI, OpenRouter, Gemini).

Check it out on GitHub: https://github.com/mahsumaktas/treliq
Demo Dashboard: https://mahsumaktas.github.io/treliq/

Let me know what you think! I'm actively looking for contributors and feedback.

---

## 🐦 Twitter / X

**Thread:**

1/ Code Review bots are cool, but they don't solve the real problem: PR Triage.

"I have 30 open PRs. Which one should I merge right now?"

Meet Treliq: an open-source AI PR Triage engine that deduplicates, scores, and ranks your pull requests. 🧵👇

2/ Treliq looks at 20 different signals: CI passing, test coverage, diff size, merge conflicts, and code quality. It groups duplicate PRs together using vector embeddings so you don't review the same bug fix twice. 🔍

3/ It works in your terminal (`npx treliq scan -r owner/repo`) or as a persistent server with a beautiful dashboard and GitHub webhook support. 📊

4/ Tired of AI wrappers? Treliq has a `--no-llm` mode that runs purely on 20 heuristic signals. 100% free and instant, no API keys needed. ⚡

Check out the repo here (stars appreciated! ⭐): https://github.com/mahsumaktas/treliq
