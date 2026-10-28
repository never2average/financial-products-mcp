#!/usr/bin/env bash
# Asks for the database connection string at a hidden prompt and stores it on the server, so it never
# appears on a command line, in shell history or in a chat. Run it in your own terminal:
#   bash set-database-url.sh root@<server> [ssh-key]
set -euo pipefail

TARGET=${1:?usage: set-database-url.sh user@server [ssh-key]}
SSH=(ssh -o BatchMode=yes)
[ -n "${2:-}" ] && SSH+=(-i "$2" -o IdentitiesOnly=yes)

read -rsp "Paste the Supabase connection string (Session pooler), then press Enter: " URL
echo
case "$URL" in
  postgres://* | postgresql://*) ;;
  *) echo "That doesn't look like a connection string (it should start with postgresql://). Nothing was saved." >&2; exit 2 ;;
esac
case "$URL" in
  *'[YOUR-PASSWORD]'*) echo "Replace [YOUR-PASSWORD] with your database password first. Nothing was saved." >&2; exit 2 ;;
esac

printf '%s' "$URL" | "${SSH[@]}" "$TARGET" '
  set -eu
  url=$(cat)
  f=/etc/financial-products-mcp/env
  tmp=$(mktemp)
  grep -v "^DATABASE_URL=" "$f" >"$tmp" || true
  printf "DATABASE_URL=%s\n" "$url" >>"$tmp"
  install -m 640 -o root -g fpmcp "$tmp" "$f"
  rm -f "$tmp"
  systemctl restart financial-products-mcp
  for _ in $(seq 20); do
    port=$(grep "^PORT=" "$f" | cut -d= -f2)
    if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then echo "Saved. The server is connected to the database."; exit 0; fi
    sleep 2
  done
  echo "Saved, but the server could not reach the database. Last log lines:" >&2
  journalctl -u financial-products-mcp -n 15 --no-pager -o cat | grep -v "postgres\(ql\)\?://" >&2
  exit 1
'
