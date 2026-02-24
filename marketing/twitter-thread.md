# X Thread — Treliq v0.5.1

1/ Shipped **Treliq v0.5.1** 🚀
A PR triage tool for OSS maintainers (CLI + dashboard).

Release: https://github.com/mahsumaktas/treliq/releases/tag/v0.5.1

2/ What’s new:
✅ 20-signal scoring
✅ Scope Coherence signal
✅ PR Complexity signal
✅ OpenRouter provider
✅ `--model` flag
✅ Embedding auto-fallback

3/ Why this matters:
Code review tools answer “is this code okay?”
Maintainers still need “which PR should I merge first?”
Treliq focuses on that ranking/triage gap.

4/ Example:
```bash
treliq scan -r owner/repo --provider openrouter --model anthropic/claude-sonnet-4.5
```

5/ Open source + feedback welcome 🙌
Repo: https://github.com/mahsumaktas/treliq
If you maintain large PR queues, tell me which triage signals you want next.