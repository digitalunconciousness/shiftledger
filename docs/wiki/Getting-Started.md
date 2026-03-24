# Getting Started

## Prerequisites

- **OS**: Debian 12+ (or any Linux with systemd)
- **Node.js**: v20 or later
- **npm**: v10 or later
- **Disk**: ~50 MB for the app + database
- **RAM**: 128 MB minimum (512 MB recommended for LXC)

## Installation

### Option 1: Automated Installer

The included `install.sh` script handles everything:

```bash
git clone https://github.com/digitalunconciousness/shiftledger.git
cd shiftledger
chmod +x install.sh
sudo ./install.sh
```

The installer will:
1. Install Node.js 20 and npm dependencies
2. Create a `shiftledger` system user
3. Deploy files to `/opt/shiftledger/`
4. Generate a random session secret
5. Register and start a systemd service
6. Set up daily 3 AM backup cron job
7. Optionally install an nginx reverse proxy

### Option 2: Manual Installation

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Clone and install
git clone https://github.com/digitalunconciousness/shiftledger.git
cd shiftledger
npm install --omit=dev

# Run directly
node server.js
```

The app will start on port 3000 by default.

## First-Run Setup

When you visit ShiftLedger for the first time (no users in the database), you'll see the **Admin Account Setup** screen.

1. Navigate to `http://<server-ip>:3000`
2. Fill in:
   - **Username** — alphanumeric + underscores, 2–50 characters
   - **Display Name** — the name shown on shifts and in the UI
   - **Password** — minimum 4 characters
3. Click **Create Admin Account**
4. You'll be automatically logged in and redirected to the shift logging view

This first account is always created with **admin** privileges. You can then create additional users in two ways:
- **Admin creates them** — via Settings → User Management in the web app
- **Users self-register** — via the mobile app (which uses `POST /api/auth/signup`) or the API directly

## Verifying the Installation

```bash
# Check if the service is running
systemctl status shiftledger

# Check the API
curl http://localhost:3000/api/auth/status
# Should return: {"status":"setup"} (no users) or {"status":"login"} (users exist)

# View live logs
journalctl -u shiftledger -f
```

## Next Steps

- [[User Guide]] — Learn how to log shifts and use the dashboard
- [[Admin Guide]] — Set up additional user accounts and households
- [[Configuration]] — Customize environment variables
- [[Deployment Guide]] — Set up a reverse proxy for production use
- [[Mobile App]] — Set up the React Native companion app
