#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  ShiftLedger — Proxmox LXC Install Script
#  Run this inside a fresh Debian 12 LXC container as root
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="/opt/shiftledger"
APP_USER="shiftledger"
PORT="${SHIFTLEDGER_PORT:-3000}"
NODE_VERSION="20"

echo ""
echo "  ╔══════════════════════════════════╗"
echo "  ║       SHIFTLEDGER INSTALLER      ║"
echo "  ╚══════════════════════════════════╝"
echo ""

# ── 1. System update ─────────────────────────────────────────────
echo "▶ Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget gnupg2 ca-certificates lsb-release

# ── 2. Node.js ───────────────────────────────────────────────────
echo "▶ Installing Node.js ${NODE_VERSION}..."
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.split(".")[0].replace("v",""))')" -lt "$NODE_VERSION" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - 2>/dev/null
  apt-get install -y -qq nodejs
fi
echo "   Node: $(node -v)  |  npm: $(npm -v)"

# ── 3. Create app user ───────────────────────────────────────────
echo "▶ Creating service user..."
if ! id "$APP_USER" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin -d "$APP_DIR" "$APP_USER"
fi

# ── 4. Install app files ─────────────────────────────────────────
echo "▶ Setting up app directory..."
mkdir -p "$APP_DIR/public"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cp "$SCRIPT_DIR/package.json"      "$APP_DIR/"
cp "$SCRIPT_DIR/server.js"         "$APP_DIR/"
cp "$SCRIPT_DIR/backup.sh"         "$APP_DIR/"
chmod +x "$APP_DIR/backup.sh"
cp -r "$SCRIPT_DIR/public/."       "$APP_DIR/public/"

# ── 5. Install npm dependencies ──────────────────────────────────
echo "▶ Installing npm dependencies..."
cd "$APP_DIR"
npm install --omit=dev --silent

# ── 6. Set permissions ───────────────────────────────────────────
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 7. Generate session secret ───────────────────────────────────
SESSION_SECRET=$(openssl rand -hex 32)

# ── 8. Systemd service ───────────────────────────────────────────
echo "▶ Creating systemd service..."
cat > /etc/systemd/system/shiftledger.service <<EOF
[Unit]
Description=ShiftLedger Earnings Tracker
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment=DB_PATH=${APP_DIR}/shifts.db
Environment=SESSION_SECRET=${SESSION_SECRET}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=shiftledger

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable shiftledger
systemctl restart shiftledger

sleep 2

# ── 9. Setup backup cron ─────────────────────────────────────────
echo "▶ Setting up daily backup cron..."
mkdir -p "$APP_DIR/backups"
chown "$APP_USER:$APP_USER" "$APP_DIR/backups"
(crontab -l 2>/dev/null | grep -v shiftledger; echo "0 3 * * * ${APP_DIR}/backup.sh ${APP_DIR}/shifts.db ${APP_DIR}/backups") | crontab -

# ── 10. Status check ─────────────────────────────────────────────
if systemctl is-active --quiet shiftledger; then
  echo ""
  echo "  ┌─────────────────────────────────────────┐"
  echo "  │  ✓  ShiftLedger is running!              │"
  echo "  │                                          │"
  printf "  │  URL: http://%-27s│\n" "$(hostname -I | awk '{print $1}'):${PORT}"
  echo "  │  DB:  ${APP_DIR}/shifts.db"
  echo "  │                                          │"
  echo "  │  First visit will prompt you to create   │"
  echo "  │  an admin account.                       │"
  echo "  │                                          │"
  echo "  │  Manage:                                 │"
  echo "  │    systemctl status shiftledger          │"
  echo "  │    systemctl restart shiftledger         │"
  echo "  │    journalctl -u shiftledger -f          │"
  echo "  └─────────────────────────────────────────┘"
  echo ""
else
  echo ""
  echo "  ✗ Service failed to start. Check logs:"
  echo "    journalctl -u shiftledger --no-pager -n 30"
  exit 1
fi

# ── Optional: nginx reverse proxy ────────────────────────────────
read -rp "Install nginx reverse proxy on port 80? [y/N] " NGINX_ANSWER
if [[ "${NGINX_ANSWER,,}" == "y" ]]; then
  apt-get install -y -qq nginx

  cat > /etc/nginx/sites-available/shiftledger <<NGINX
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   Connection        '';
        proxy_buffering    off;
    }
}
NGINX

  ln -sf /etc/nginx/sites-available/shiftledger /etc/nginx/sites-enabled/
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl restart nginx
  echo "  ✓ nginx configured → http://$(hostname -I | awk '{print $1}')/"
fi

# ── Optional: Cloudflare Tunnel ──────────────────────────────────
read -rp "Install Cloudflare Tunnel for public HTTPS access? [y/N] " CF_ANSWER
if [[ "${CF_ANSWER,,}" == "y" ]]; then
  echo "▶ Installing cloudflared..."
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared

  echo ""
  echo "  cloudflared installed. To complete setup:"
  echo ""
  echo "  1. Authenticate:  cloudflared tunnel login"
  echo "  2. Create tunnel: cloudflared tunnel create shiftledger"
  echo "  3. Configure DNS: cloudflared tunnel route dns shiftledger shifts.greybardserver.com"
  echo "  4. Create config file /etc/cloudflared/config.yml:"
  echo ""
  echo "     tunnel: <TUNNEL_ID>"
  echo "     credentials-file: /root/.cloudflared/<TUNNEL_ID>.json"
  echo "     ingress:"
  echo "       - hostname: shifts.greybardserver.com"
  echo "         service: http://localhost:${PORT}"
  echo "       - service: http_status:404"
  echo ""
  echo "  5. Install as service: cloudflared service install"
  echo "  6. Start: systemctl start cloudflared"
  echo ""
fi

echo ""
echo "  Done. Enjoy ShiftLedger!"
echo ""
