#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
CLAUDE_ROOT="${CLAUDE_HOME:-$HOME/.claude}"
CODEX_SKILL="$CODEX_ROOT/skills/agent-room"
CLAUDE_SKILL="$CLAUDE_ROOT/skills/agent-room"
# Backups live OUTSIDE skills/: anything under skills/ with a SKILL.md is a live
# skill, and a backup left there is listed next to the real one with the same
# description. On 2026-09-02 agents picked a stale backup and opened local rooms.
CODEX_BACKUPS="$CODEX_ROOT/skills-backups"
CLAUDE_BACKUPS="$CLAUDE_ROOT/skills-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

if ! command -v bun >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
  echo "Agent Room requires Bun or Node.js 20+." >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [ "$NODE_MAJOR" -lt 20 ] && ! command -v bun >/dev/null 2>&1; then
    echo "Agent Room requires Bun or Node.js 20+. Found Node.js $(node --version)." >&2
    exit 1
  fi
fi

mkdir -p "$CODEX_ROOT/skills" "$CLAUDE_ROOT/skills" "$CODEX_BACKUPS" "$CLAUDE_BACKUPS"

SOURCE_REAL="$(cd "$SOURCE_DIR" && pwd -P)"
DEST_REAL=""
if [ -d "$CODEX_SKILL" ]; then
  DEST_REAL="$(cd "$CODEX_SKILL" && pwd -P)"
fi

if [ "$SOURCE_REAL" != "$DEST_REAL" ]; then
  if [ -e "$CODEX_SKILL" ] || [ -L "$CODEX_SKILL" ]; then
    mv "$CODEX_SKILL" "$CODEX_BACKUPS/agent-room.backup-$STAMP"
    echo "Backed up existing Codex skill to $CODEX_BACKUPS/agent-room.backup-$STAMP"
  fi
  mkdir -p "$CODEX_SKILL/agents" "$CODEX_SKILL/scripts"
  cp "$SOURCE_DIR/SKILL.md" "$CODEX_SKILL/SKILL.md"
  cp "$SOURCE_DIR/agents/openai.yaml" "$CODEX_SKILL/agents/openai.yaml"
  cp "$SOURCE_DIR/scripts/agent_room.mjs" "$CODEX_SKILL/scripts/agent_room.mjs"
  chmod +x "$CODEX_SKILL/scripts/agent_room.mjs"
fi

if [ -e "$CLAUDE_SKILL" ] || [ -L "$CLAUDE_SKILL" ]; then
  CURRENT_TARGET="$(readlink "$CLAUDE_SKILL" 2>/dev/null || true)"
  if [ "$CURRENT_TARGET" != "$CODEX_SKILL" ]; then
    mv "$CLAUDE_SKILL" "$CLAUDE_BACKUPS/agent-room.backup-$STAMP"
    echo "Backed up existing Claude skill to $CLAUDE_BACKUPS/agent-room.backup-$STAMP"
  else
    rm "$CLAUDE_SKILL"
  fi
fi

ln -s "$CODEX_SKILL" "$CLAUDE_SKILL"

echo
echo "Agent Room installed."
echo "Codex:  $CODEX_SKILL"
echo "Claude: $CLAUDE_SKILL -> $CODEX_SKILL"
echo
echo "Restart Codex and Claude Code to refresh their skill lists."
