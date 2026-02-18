# Treliq v0.5.1

Treliq v0.5.1 is a quality-focused release that improves model control, provider flexibility, and PR triage accuracy.

## ✨ Highlights

## 1) `--model` flag + model-aware token defaults
- Select model explicitly per run (`--model`)
- `TRELIQ_MODEL` env override
- Automatic max token defaults:
  - Sonnet/Opus-like models → 1024
  - Flash/Haiku/default models → 200

## 2) OpenRouter provider support
- New provider: `openrouter`
- OpenAI-compatible endpoint support
- Works with model ids like:
  - `anthropic/claude-sonnet-4.5`
  - `openai/gpt-5-codex`

## 3) Embedding auto-fallback
- For providers without embeddings (Anthropic/OpenRouter):
  - Auto use `GEMINI_API_KEY` if available
  - Else auto use `OPENAI_API_KEY`
- Prevents dedup failures due to missing embedding provider

## 4) New triage signals (20 total)
- **Scope Coherence**
  - Detects unfocused/scattered changes via file distribution
  - Flags title-to-files mismatch
- **PR Complexity**
  - Size-aware scoring
  - Overengineering heuristics
  - AI-assisted large-PR scrutiny signals

## 🧪 Example

```bash
# OpenRouter + explicit model
npx treliq scan -r owner/repo --provider openrouter --model anthropic/claude-sonnet-4.5

# Anthropic + embedding fallback from Gemini/OpenAI env
npx treliq scan -r owner/repo --provider anthropic --model claude-sonnet-4-6
```

## ✅ Why this matters
- Better model quality control
- Better support for real-world provider routing
- Better ranking accuracy for maintainers (especially large/scattered PRs)

