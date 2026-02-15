#!/usr/bin/env bash
set -euo pipefail

# ─── Colors & helpers ───────────────────────────────────────────────
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'

print()  { printf "%b\n" "$1"; }
info()   { printf "  %b%b%b %b\n" "$CYAN" "▸" "$RESET" "$1"; }
ok()     { printf "  %b✔%b %b\n" "$GREEN" "$RESET" "$1"; }
warn()   { printf "  %b!%b %b\n" "$YELLOW" "$RESET" "$1"; }
err()    { printf "  %b✘%b %b\n" "$RED" "$RESET" "$1"; }
ask()    { printf "  %b?%b %b" "$YELLOW" "$RESET" "$1"; }
divider(){ printf "  %b─────────────────────────────────────────%b\n" "$DIM" "$RESET"; }

# Read input with a default value
# Usage: value=$(prompt "Label" "default")
prompt() {
  local label="$1"
  local default="${2:-}"
  local input
  if [ -n "$default" ]; then
    ask "${label} ${DIM}(${default})${RESET}: "
  else
    ask "${label}: "
  fi
  read -r input
  echo "${input:-$default}"
}

# Yes/no prompt, returns 0 for yes, 1 for no
# Usage: if confirm "Enable groups?"; then ...
confirm() {
  local input
  ask "$1 ${DIM}[y/N]${RESET}: "
  read -r input
  [[ "$input" =~ ^[Yy]$ ]]
}

# Secret input (no echo)
prompt_secret() {
  local label="$1"
  local input
  ask "${label}: "
  read -rs input
  echo
  echo "$input"
}

# ─── Header ─────────────────────────────────────────────────────────
clear
print ""
print "  ${YELLOW}    ▲${RESET}"
print "  ${YELLOW}   ╱ ╲${RESET}"
print "  ${YELLOW}  ╱   ╲${RESET}"
print "  ${YELLOW} ╱  ${WHITE}K${YELLOW}  ╲${RESET}"
print "  ${YELLOW}╱_______╲${RESET}"
print ""
print "  ${BOLD}${WHITE}Kairo${RESET} ${DIM}— setup wizard${RESET}"
print ""
divider
print ""

# ─── 1. Check prerequisites ─────────────────────────────────────────
print "  ${BOLD}Checking prerequisites${RESET}"
print ""

# Node.js
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
  if [ "$NODE_MAJOR" -gt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -ge 6 ]; }; then
    ok "Node.js ${DIM}v${NODE_VERSION}${RESET}"
  else
    err "Node.js v${NODE_VERSION} found — need >= 20.6"
    print "    Install from ${CYAN}https://nodejs.org${RESET}"
    exit 1
  fi
else
  err "Node.js not found"
  print "    Install from ${CYAN}https://nodejs.org${RESET}"
  exit 1
fi

# pnpm
if command -v pnpm &>/dev/null; then
  PNPM_VERSION=$(pnpm -v)
  ok "pnpm ${DIM}v${PNPM_VERSION}${RESET}"
else
  warn "pnpm not found"
  if confirm "Install pnpm via corepack?"; then
    corepack enable && corepack prepare pnpm@latest --activate
    ok "pnpm installed"
  else
    err "pnpm is required. Install with: npm install -g pnpm"
    exit 1
  fi
fi

print ""
divider
print ""

# ─── 2. Install dependencies ────────────────────────────────────────
print "  ${BOLD}Installing dependencies${RESET}"
print ""

pnpm install --reporter=default 2>&1 | while IFS= read -r line; do
  printf "    ${DIM}%s${RESET}\n" "$line"
done

ok "Dependencies installed"
print ""
divider
print ""

# ─── 3. Environment setup ───────────────────────────────────────────
print "  ${BOLD}Environment configuration${RESET}"
print ""

ENV_FILE=".env"
ENV_CONTENT=""

append_env() {
  ENV_CONTENT="${ENV_CONTENT}$1
"
}

append_comment() {
  ENV_CONTENT="${ENV_CONTENT}
# $1
"
}

# ── Required ──

print "  ${WHITE}Required${RESET}"
print ""

# Telegram bot token
info "Get a bot token from ${CYAN}https://t.me/BotFather${RESET}"
BOT_TOKEN=$(prompt_secret "Telegram bot token")
while [ -z "$BOT_TOKEN" ]; do
  err "Bot token is required"
  BOT_TOKEN=$(prompt_secret "Telegram bot token")
done
append_comment "Telegram"
append_env "BOT_TOKEN=${BOT_TOKEN}"

# Anthropic API key
info "Get an API key from ${CYAN}https://console.anthropic.com/settings/keys${RESET}"
ANTHROPIC_KEY=$(prompt_secret "Anthropic API key")
while [ -z "$ANTHROPIC_KEY" ]; do
  err "Anthropic API key is required"
  ANTHROPIC_KEY=$(prompt_secret "Anthropic API key")
done
append_env "ANTHROPIC_API_KEY=${ANTHROPIC_KEY}"

print ""
divider
print ""

# ── Bot settings ──

print "  ${WHITE}Bot settings${RESET}"
print ""

BOT_NAME=$(prompt "Bot name" "Kairo")
append_comment "Bot"
append_env "BOT_NAME=${BOT_NAME}"

if confirm "Enable group chat support?"; then
  append_env "ENABLE_GROUPS=true"
  ok "Group chats enabled"
else
  ok "DMs only"
fi

MAX_TOKENS=$(prompt "Context token budget" "16000")
append_env "MAX_CONTEXT_TOKENS=${MAX_TOKENS}"

print ""
divider
print ""

# ── Optional integrations ──

print "  ${WHITE}Integrations${RESET} ${DIM}(all optional — press Enter to skip)${RESET}"
print ""

# Web search (Exa)
if confirm "Enable web search (Exa API)?"; then
  info "Get a key from ${CYAN}https://exa.ai${RESET}"
  EXA_KEY=$(prompt_secret "Exa API key")
  if [ -n "$EXA_KEY" ]; then
    append_comment "Web search"
    append_env "EXA_API_KEY=${EXA_KEY}"
    ok "Web search configured"
  else
    warn "Skipped — no key provided"
  fi
fi

# Notion
if confirm "Enable Notion integration?"; then
  info "Create an integration at ${CYAN}https://www.notion.so/profile/integrations${RESET}"
  NOTION_TOKEN=$(prompt_secret "Notion integration token")
  if [ -n "$NOTION_TOKEN" ]; then
    append_comment "Notion"
    append_env "NOTION_TOKEN=${NOTION_TOKEN}"
    ok "Notion configured"
  else
    warn "Skipped — no token provided"
  fi
fi

# Spotify
if confirm "Enable Spotify integration?"; then
  info "Create an app at ${CYAN}https://developer.spotify.com/dashboard${RESET}"
  info "Set redirect URI to ${CYAN}http://127.0.0.1:8888/callback${RESET}"
  SPOTIFY_ID=$(prompt "Spotify Client ID" "")
  SPOTIFY_SECRET=$(prompt_secret "Spotify Client Secret")
  if [ -n "$SPOTIFY_ID" ] && [ -n "$SPOTIFY_SECRET" ]; then
    SPOTIFY_PORT=$(prompt "Callback port" "8888")
    append_comment "Spotify"
    append_env "SPOTIFY_CLIENT_ID=${SPOTIFY_ID}"
    append_env "SPOTIFY_CLIENT_SECRET=${SPOTIFY_SECRET}"
    append_env "SPOTIFY_REDIRECT_URI=http://127.0.0.1:${SPOTIFY_PORT}/callback"
    append_env "SPOTIFY_CALLBACK_PORT=${SPOTIFY_PORT}"
    ok "Spotify configured"
  else
    warn "Skipped — incomplete credentials"
  fi
fi

print ""
divider
print ""

# ── Advanced ──

if confirm "Configure advanced options?"; then
  print ""
  LOG_LEVEL=$(prompt "Log level (debug/info/warn/error)" "info")
  append_comment "Advanced"
  append_env "LOG_LEVEL=${LOG_LEVEL}"

  PROTECTED=$(prompt "Protected messages (recent messages immune to compaction)" "6")
  append_env "PROTECTED_MESSAGES=${PROTECTED}"

  DB_PATH=$(prompt "Database path" "data/kairo.db")
  append_env "DB_PATH=${DB_PATH}"
  print ""
fi

# ─── 4. Write .env ──────────────────────────────────────────────────
printf "%s" "$ENV_CONTENT" > "$ENV_FILE"
ok ".env written"

print ""
divider
print ""

# ─── 5. Create data directory ───────────────────────────────────────
mkdir -p data
ok "data/ directory ready"

# ─── Summary ─────────────────────────────────────────────────────────
print ""
print "  ${GREEN}${BOLD}Setup complete!${RESET}"
print ""

INTEGRATIONS=""
[ -n "${EXA_KEY:-}" ] && INTEGRATIONS="${INTEGRATIONS} web-search"
[ -n "${NOTION_TOKEN:-}" ] && INTEGRATIONS="${INTEGRATIONS} notion"
[ -n "${SPOTIFY_ID:-}" ] && INTEGRATIONS="${INTEGRATIONS} spotify"

if [ -n "$INTEGRATIONS" ]; then
  info "Integrations:${BOLD}${INTEGRATIONS}${RESET}"
fi

print ""
print "  Run Kairo:"
print ""
print "    ${CYAN}pnpm start${RESET}       ${DIM}# production${RESET}"
print "    ${CYAN}pnpm run dev${RESET}     ${DIM}# development (auto-restart)${RESET}"
print ""
