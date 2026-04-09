#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

mkdir -p .agents
touch .agents/claude_logs.txt .agents/copilot_logs.txt .agents/matcher_logs.txt .agents/backend_logs.txt
[ -f .agents/search_request.json ] || echo '{}' > .agents/search_request.json
[ -f .agents/analyzed_profiles.json ] || echo '[]' > .agents/analyzed_profiles.json
[ -f .agents/final_match.json ] || echo '{}' > .agents/final_match.json

if [ ! -d node_modules ]; then
  npm install
fi

PYTHON_BIN="${PYTHON_BIN:-python}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python is not available in PATH."
  exit 1
fi

cleanup() {
  kill "${BACKEND_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Installing Python backend dependencies..."
"$PYTHON_BIN" -m pip install -r backend/requirements.txt >/dev/null

echo "Starting Python backend on http://localhost:5001 ..."
"$PYTHON_BIN" backend/server.py &
BACKEND_PID=$!

echo "Starting Next.js app on http://localhost:3000 ..."
npm run dev
