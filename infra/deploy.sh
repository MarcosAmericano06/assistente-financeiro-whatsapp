#!/usr/bin/env bash
# Atualiza o bot na VM: backup do banco, migrations, setup, código e restart.
# Para no primeiro erro. Configure infra/deploy.env (veja infra/deploy.env.example).
# Uso (na raiz do projeto, no seu computador): bash infra/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source infra/deploy.env   # VM=usuario@ip  SSH_KEY=~/.ssh/sua_chave  REMOTE_DIR=bot-financeiro

SSH=(ssh -o BatchMode=yes -i "$SSH_KEY" "$VM")
DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
export DATABASE_URL

echo "==> 1/6 parando o bot na VM"
"${SSH[@]}" 'sudo systemctl stop bot-wa || true' < /dev/null

echo "==> 2/6 backup do banco"
mkdir -p "$HOME/bot-financeiro-backups" && chmod 700 "$HOME/bot-financeiro-backups"
BACKUP="$HOME/bot-financeiro-backups/db-$(date +%Y%m%d-%H%M).dump"
docker run --rm -e DBURL="$DATABASE_URL" postgres:18-alpine sh -c 'pg_dump --format=custom --no-owner --no-privileges "$DBURL"' > "$BACKUP" < /dev/null
chmod 600 "$BACKUP" && ls -la "$BACKUP"

echo "==> 3/6 migrations"
npx drizzle-kit migrate < /dev/null

echo "==> 4/6 setup (idempotente)"
npx tsx scripts/setup.ts < /dev/null

echo "==> 5/6 código na VM"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude '.env.*' --exclude wa-session --exclude setup.json \
  --exclude .git --exclude .claude --exclude infra/deploy.env \
  -e "ssh -o BatchMode=yes -i $SSH_KEY" ./ "$VM:$REMOTE_DIR/" < /dev/null
"${SSH[@]}" "cd ~/$REMOTE_DIR && npm install --no-audit --no-fund --loglevel=error" < /dev/null

echo "==> 6/6 religando o bot"
"${SSH[@]}" 'sudo systemctl start bot-wa && sleep 20 && systemctl is-active bot-wa && journalctl -u bot-wa --since "-30s" --no-pager | grep -E "iniciado|conectado" | cut -c1-160 || true' < /dev/null
echo "OK. Backup em $BACKUP"
