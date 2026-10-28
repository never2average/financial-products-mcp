#!/usr/bin/env bash
# Installs the MCP server on a host without Docker that already runs Caddy as a system service
# (e.g. a software-factory app server). State lives in an external Postgres such as Supabase Cloud.
# Idempotent. Usage (as root on the server):
#   bash install-host.sh <domain> [git-ref] [port]
# Then set DATABASE_URL in /etc/financial-products-mcp/env (see set-database-url.sh) and the service starts.
set -euo pipefail

DOMAIN=${1:?usage: install-host.sh <domain> [git-ref] [port]}
REF=${2:-main}
PORT=${3:-3100}
REPO=https://github.com/never2average/financial-products-mcp.git
BASE=/opt/financial-products-mcp
ENV_DIR=/etc/financial-products-mcp
SITES=/etc/caddy/sites.d
SITE_FILE=$SITES/financial-products-mcp.caddy

log() { printf '\n==> %s\n' "$*"; }

if command -v docker >/dev/null; then echo "note: Docker is present; this installer does not use it" >&2; fi
command -v caddy >/dev/null || { echo "Caddy (system service) is required" >&2; exit 2; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' ||
  { echo "Node.js >= 22.13 is required" >&2; exit 2; }
if ss -ltnH "sport = :$PORT" | grep -q . && ! systemctl is-active -q financial-products-mcp; then
  echo "port $PORT is already in use; pass another port" >&2; exit 2
fi

log "Service user"
id fpmcp >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin fpmcp

log "Release ($REF)"
mkdir -p "$BASE/releases"
SRC=$BASE/src
if [ ! -d "$SRC/.git" ]; then git clone -q "$REPO" "$SRC"; fi
git -C "$SRC" fetch -q origin "$REF"
SHA=$(git -C "$SRC" rev-parse --short FETCH_HEAD)
REL=$BASE/releases/$SHA
if [ ! -f "$REL/dist/index.js" ]; then
  rm -rf "$REL"
  git -C "$SRC" archive FETCH_HEAD | (mkdir -p "$REL" && tar -x -C "$REL")
  (cd "$REL" && npm ci --no-audit --no-fund --loglevel=error && npx tsc && npm prune --omit=dev --no-audit --no-fund --loglevel=error)
fi
chown -R root:root "$REL"
ln -sfn "$REL" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"

log "Environment ($ENV_DIR/env)"
install -d -m 750 -o root -g fpmcp "$ENV_DIR"
if [ ! -f "$ENV_DIR/env" ]; then
  install -m 640 -o root -g fpmcp /dev/null "$ENV_DIR/env"
  echo "PORT=$PORT" >>"$ENV_DIR/env"
fi
grep -q '^PORT=' "$ENV_DIR/env" || echo "PORT=$PORT" >>"$ENV_DIR/env"
PORT=$(grep '^PORT=' "$ENV_DIR/env" | cut -d= -f2)

log "systemd unit"
install -m 644 "$REL/deploy/host/financial-products-mcp.service" /etc/systemd/system/financial-products-mcp.service
systemctl daemon-reload
systemctl enable -q financial-products-mcp
if grep -q '^DATABASE_URL=' "$ENV_DIR/env"; then
  systemctl restart financial-products-mcp
else
  echo "DATABASE_URL is not set yet; the service starts once it is (set-database-url.sh)"
fi

log "Caddy site for $DOMAIN"
install -d -m 755 "$SITES"
sed -e "s|@DOMAIN@|$DOMAIN|g" -e "s|@PORT@|$PORT|g" "$REL/deploy/host/site.caddy" >"$SITE_FILE.new"
mv "$SITE_FILE.new" "$SITE_FILE"
# The main Caddyfile must import the sites folder. A software-factory server's generator adds this line itself;
# on any other server (or before its next deploy) it is appended here.
grep -qF "import $SITES/*.caddy" /etc/caddy/Caddyfile || printf '\nimport %s/*.caddy\n' "$SITES" >>/etc/caddy/Caddyfile
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile >/dev/null
systemctl reload caddy

if systemctl is-active -q financial-products-mcp; then
  log "Health"
  for _ in $(seq 30); do
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then echo "healthy: https://$DOMAIN/mcp ($SHA)"; exit 0; fi
    sleep 2
  done
  journalctl -u financial-products-mcp -n 30 --no-pager >&2
  exit 1
fi
