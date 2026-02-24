# Show HN: Treliq v0.5.1 — PR triage with 20 signals, OpenRouter, and model control

Hey HN — I built **Treliq**, a CLI + dashboard for open-source maintainers to decide *which PR to review/merge first*.

v0.5.1 just shipped with:
- **20-signal scoring** (new: Scope Coherence + PR Complexity)
- **`--model` flag** (choose model per run)
- **OpenRouter provider** support
- **Embedding auto-fallback** (Anthropic/OpenRouter → Gemini/OpenAI)

Why this exists: code review tools are good at reviewing code, but maintainers still ask:
- Which PR is highest value?
- Which one is overengineered or scattered?
- Which PRs are duplicates?

Treliq focuses on triage/ranking, not replacing review.

Install:
```bash
npm i -g treliq
```

Try:
```bash
treliq scan -r owner/repo --provider openrouter --model anthropic/claude-sonnet-4.5
```

Repo: https://github.com/mahsumaktas/treliq
Release: https://github.com/mahsumaktas/treliq/releases/tag/v0.5.1

Would love feedback from maintainers managing large PR queues.