#!/bin/bash
# SessionStart hook: install dependencies so typecheck / test / build work
# immediately in a fresh Claude Code on the web session, without the agent
# having to install them by hand first.
#
# Runs synchronously (blocks session start until deps are ready) — see
# .claude/settings.json. Safe to re-run: npm install is idempotent and the
# container state is cached after the hook completes.
set -euo pipefail

# Only run in the remote (web) environment. On a local machine developers
# manage their own node_modules, so this is a no-op there.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Root app: required for npm run typecheck / test / build.
echo "[session-start] Installing root dependencies…"
npm install --no-audit --no-fund

# Optional Cloudflare Worker subprojects (recipe fetcher + sync backend).
# Best-effort: a session working on the main app doesn't need these, so a
# failure here must not block startup.
#
# --no-package-lock: these installs must not leave the git tree dirty on every
# session. Without it, npm rewrites sync-worker's committed lockfile and
# creates one under worker/ (which has none), which then trips the "uncommitted
# changes" stop-hook. The install still works; it just won't touch lockfiles.
for sub in worker sync-worker; do
  if [ -f "$sub/package.json" ]; then
    echo "[session-start] Installing $sub dependencies (best-effort)…"
    npm install --no-audit --no-fund --no-package-lock --prefix "$sub" || \
      echo "[session-start] WARN: $sub install failed; continuing."
  fi
done

echo "[session-start] Done."
