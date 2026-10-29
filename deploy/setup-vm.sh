#!/usr/bin/env bash
# Deploys self-hosted Supabase + the Mynt MCP server on a fresh Ubuntu VM.
# Idempotent: re-run to update. Usage (as root on the VM):
#   bash setup-vm.sh <domain> [git-ref]
set -euo pipefail

DOMAIN=${1:?usage: setup-vm.sh <domain> [git-ref]}
REF=${2:-main}
REPO=https://github.com/never2average/mynt.git
SUPABASE_DIR=/opt/supabase
APP_DIR=/opt/mynt

log() { printf '\n==> %s\n' "$*"; }

log "Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
apt-get install -y -qq git openssl >/dev/null

log "Firewall: SSH, HTTP, HTTPS only"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443 >/dev/null
  ufw --force enable >/dev/null
fi

log "MCP source ($REF)"
mkdir -p "$APP_DIR"
if [ ! -d "$APP_DIR/src/.git" ]; then git clone -q "$REPO" "$APP_DIR/src"; fi
git -C "$APP_DIR/src" fetch -q origin "$REF"
git -C "$APP_DIR/src" checkout -q --detach FETCH_HEAD

log "Supabase (self-hosted)"
if [ ! -d "$SUPABASE_DIR" ]; then
  tmp=$(mktemp -d)
  git clone -q --depth 1 --filter=blob:none --sparse https://github.com/supabase/supabase "$tmp"
  git -C "$tmp" sparse-checkout set docker
  cp -r "$tmp/docker" "$SUPABASE_DIR"
  rm -rf "$tmp"
fi
cd "$SUPABASE_DIR"
if [ ! -f .env ]; then
  cp .env.example .env
  sh utils/generate-keys.sh --update-env >/dev/null
  rm -f .env.old
  sed -i "s|^POOLER_TENANT_ID=.*|POOLER_TENANT_ID=financial-products|" .env
  chmod 600 .env
fi
cp "$APP_DIR/src/deploy/supabase.override.yml" docker-compose.override.yml
docker compose pull -q
docker compose up -d

log "Waiting for Supabase Postgres"
until [ "$(docker inspect -f '{{.State.Health.Status}}' supabase-db 2>/dev/null)" = healthy ]; do sleep 2; done

log "Dedicated database role for the MCP"
ENV_FILE="$APP_DIR/src/deploy/.env"
if [ ! -f "$ENV_FILE" ]; then
  APP_PW=$(openssl rand -hex 24)
  umask 077
  cat >"$ENV_FILE" <<EOF
MCP_DOMAIN=$DOMAIN
APP_DB_PASSWORD=$APP_PW
DATABASE_URL=postgres://financial_products_app:$APP_PW@db:5432/postgres
EOF
fi
APP_PW=$(grep '^APP_DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2)
docker exec -i supabase-db psql -v ON_ERROR_STOP=1 -q -U supabase_admin -d postgres -v pw="$APP_PW" <<'SQL'
SELECT format('CREATE ROLE financial_products_app LOGIN PASSWORD %L', :'pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'financial_products_app') \gexec
ALTER ROLE financial_products_app PASSWORD :'pw';
CREATE SCHEMA IF NOT EXISTS financial_products AUTHORIZATION financial_products_app;
SQL

log "MCP server + Caddy"
cd "$APP_DIR/src/deploy"
docker compose up -d --build --remove-orphans

log "Health"
for _ in $(seq 60); do
  if docker compose exec -T mcp wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo "MCP healthy. Endpoint: https://$DOMAIN/mcp"
    echo "Create users: docker compose -f $APP_DIR/src/deploy/docker-compose.yml exec mcp node dist/index.js users add --name <name> --role <consumer|developer|innovator>"
    exit 0
  fi
  sleep 2
done
echo "MCP did not become healthy; check: docker compose -f $APP_DIR/src/deploy/docker-compose.yml logs mcp" >&2
exit 1
