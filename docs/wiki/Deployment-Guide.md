# Deployment Guide

ShiftLedger is designed to run as a lightweight service on a Linux server, Proxmox LXC container, or any system with Node.js and systemd.

---

## Proxmox LXC Setup (Recommended)

### 1. Create the Container

In the Proxmox web UI:

- **Template**: Debian 12 (Bookworm) standard
- **CPU**: 1 core
- **RAM**: 512 MB
- **Disk**: 4 GB (plenty for the app + years of data)
- **Network**: DHCP or static IP on your LAN

### 2. Install ShiftLedger

SSH into the container and run:

```bash
apt-get update && apt-get install -y git
git clone https://github.com/digitalunconciousness/shiftledger.git
cd shiftledger
chmod +x install.sh
./install.sh
```

The installer handles everything — see [[Getting Started]] for details.

### 3. Verify

```bash
systemctl status shiftledger
curl http://localhost:3000/api/auth/status
```

---

## systemd Service

The installer creates `/etc/systemd/system/shiftledger.service`:

```ini
[Unit]
Description=ShiftLedger Earnings Tracker
After=network.target

[Service]
Type=simple
User=shiftledger
WorkingDirectory=/opt/shiftledger
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DB_PATH=/opt/shiftledger/shifts.db
Environment=SESSION_SECRET=<generated>
ExecStart=/usr/bin/node /opt/shiftledger/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=shiftledger

[Install]
WantedBy=multi-user.target
```

### Key Design Choices

- **Dedicated user** (`shiftledger`) — non-root, no login shell
- **Auto-restart** — if the process crashes, systemd restarts it after 5 seconds
- **Journal logging** — stdout/stderr go to journald

### Common Commands

```bash
sudo systemctl start shiftledger      # start
sudo systemctl stop shiftledger       # stop
sudo systemctl restart shiftledger    # restart
sudo systemctl status shiftledger     # check status
sudo systemctl enable shiftledger     # start on boot
sudo systemctl disable shiftledger    # don't start on boot
journalctl -u shiftledger -f          # follow live logs
journalctl -u shiftledger --since "1 hour ago"  # recent logs
```

---

## nginx Reverse Proxy

The installer optionally configures nginx on port 80. To set it up manually:

### Install nginx

```bash
sudo apt-get install -y nginx
```

### Configure

Create `/etc/nginx/sites-available/shiftledger`:

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   Connection        '';
        proxy_buffering    off;
    }
}
```

### Enable

```bash
sudo ln -sf /etc/nginx/sites-available/shiftledger /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

### With SSL (Let's Encrypt)

If exposing directly to the internet (without a tunnel):

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## Updating ShiftLedger

To update to a new version:

```bash
# On your development machine or wherever the repo lives
cd /path/to/shiftledger
git pull

# Copy files to the deployment directory
sudo cp server.js /opt/shiftledger/
sudo cp -r public/ /opt/shiftledger/
sudo cp package.json /opt/shiftledger/

# Install any new dependencies
cd /opt/shiftledger
sudo -u shiftledger npm install --omit=dev

# Restart
sudo systemctl restart shiftledger
```

Database migrations run automatically on startup — no manual steps needed.

---

## Running Without systemd

For development or non-systemd systems:

```bash
cd /path/to/shiftledger
npm install
PORT=3000 SESSION_SECRET=$(openssl rand -hex 32) node server.js
```

---

## Docker (DIY)

ShiftLedger doesn't ship a Dockerfile, but creating one is straightforward:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
```

Run with:
```bash
docker run -d -p 3000:3000 \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e DB_PATH=/app/data/shifts.db \
  -v shiftledger-data:/app/data \
  shiftledger
```

---

## Resource Usage

Typical resource consumption:

- **Memory**: ~30–50 MB RSS
- **CPU**: Negligible (SQLite queries are fast)
- **Disk**: Database grows ~1 KB per shift. 10,000 shifts ≈ 10 MB.
- **Network**: Minimal — only serves the SPA and JSON API responses
