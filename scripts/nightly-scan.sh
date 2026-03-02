#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

# Load .env
if [ -f .env ]; then
  set -a; source .env; set +a
fi

mkdir -p results/logs
LOG_FILE="results/logs/$(date +%Y-%m-%d).log"

echo "[$(date)] Nightly scan starting..." | tee -a "$LOG_FILE"

# macOS: gtimeout (coreutils), Linux: timeout
TIMEOUT_CMD="timeout"
command -v gtimeout &>/dev/null && TIMEOUT_CMD="gtimeout"
command -v $TIMEOUT_CMD &>/dev/null || TIMEOUT_CMD=""

${TIMEOUT_CMD:+$TIMEOUT_CMD 14400} npx tsx scripts/bulk-score.ts \
  --nightly \
  --limit 500 \
  --sort newest \
  --skip-cached \
  --include-closed 28d \
  2>&1 | tee -a "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}

echo "[$(date)] Exit code: $EXIT_CODE" | tee -a "$LOG_FILE"

# Clean logs older than 30 days
find results/logs -name "*.log" -mtime +30 -delete 2>/dev/null || true

exit $EXIT_CODE
