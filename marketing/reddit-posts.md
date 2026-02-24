# Reddit Campaign — Treliq v0.5.1

## r/opensource

Built a new release of **Treliq** (OSS) for PR triage: rank and prioritize open PRs using 20 signals + optional LLM scoring.

v0.5.1 adds:
- Scope Coherence signal (detect scattered PRs)
- PR Complexity signal (size/overengineering awareness)
- OpenRouter provider support
- `--model` flag for per-run model control
- Embedding auto-fallback (Anthropic/OpenRouter workflows)

Repo: https://github.com/mahsumaktas/treliq
Release: https://github.com/mahsumaktas/treliq/releases/tag/v0.5.1

Happy to hear what signals are missing for real maintainer workflows.

---

## r/github

If you maintain repos with many incoming PRs, I just shipped Treliq v0.5.1.

It’s a triage layer (not another reviewer):
- scores PRs,
- finds likely duplicates,
- surfaces risky/overengineered/scattered PRs faster.

New in v0.5.1:
- 20-signal scoring
- Scope Coherence + Complexity signals
- OpenRouter support
- `--model` CLI option

Repo: https://github.com/mahsumaktas/treliq

---

## r/programming (short)

Shipped **Treliq v0.5.1** — open-source PR triage tool.

New bits:
- 20-signal ranking
- Scope coherence detection
- Complexity/overengineering detection
- OpenRouter + model selection (`--model`)

If you review lots of OSS PRs, I’d love your feedback.
https://github.com/mahsumaktas/treliq