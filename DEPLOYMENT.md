# CAFFIX Smart Vending Kiosk Deployment & Auto-Boot Guide

This document outlines the step-by-step procedure to deploy the **CAFFIX** application stack (React kiosk frontend, Python FastAPI web host, and Express TypeScript SQLite backend) on a **Raspberry Pi** device (such as Raspberry Pi 4 or 5) running Raspberry Pi OS (Debian-based), with a 7-inch official touchscreen.

---

## 1. System Requirements & Prerequisites

Before starting, ensure that the Raspberry Pi is connected to the internet and updated:

```bash
sudo apt update && sudo apt upgrade -y
```

### Install Required Runtime Packages
Install Node.js, Python, SQLite3, and Chromium:

```bash
# 1. Install Node.js LTS (v20+) and NPM
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install Python 3 & Pip
sudo apt-get install -y python3 python3-pip python3-venv

# 3. Install SQLite3 and GUI tools (optional)
sudo apt-get install -y sqlite3

# 4. Install Chromium and X11 utilities (for kiosk settings)
sudo apt-get install -y chromium-browser x11-xserver-utils unclutter
```

---

## 2. Project Installation & Building

Clone or copy the CAFFIX codebase into `/home/pi/caffix` (or your chosen workspace directory).

### 2.1 Backend Build Setup
Navigate to the `caffix-backend` directory, install packages, and build the TypeScript binaries:

```bash
cd /home/pi/caffix/caffix-backend

# Install package dependencies
npm install

# Build compiled JavaScript outputs into /dist
npm run build
```

### 2.2 Frontend Build Setup
Navigate to the `caffix-app` directory, install package dependencies, and build the static React assets:

```bash
cd /home/pi/caffix/caffix-app

# Install dependencies
npm install

# Build static React production bundle
npm run build
```
This compilation creates the static files in `/home/pi/caffix/caffix-app/dist`.

### 2.3 Python Web Host Setup
Create a virtual environment and install FastAPI and Uvicorn dependencies to host the kiosk:

```bash
cd /home/pi/caffix

# Create a virtual environment
python3 -m venv venv
source venv/bin/activate

# Install requirements
pip install fastapi uvicorn
```

---

## 3. Creating Background Services (systemd)

To make both the Express API backend and FastAPI web host boot automatically in the background on startup, create two `systemd` services.

### 3.1 Backend Service (`caffix-backend.service`)
Create the service unit file:
```bash
sudo nano /etc/systemd/system/caffix-backend.service
```

Paste the following configuration:
```ini
[Unit]
Description=CAFFIX Express SQLite API Backend
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/caffix/caffix-backend
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
Environment=PORT=5000 NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### 3.2 Frontend Service (`caffix-frontend.service`)
Create the service unit file:
```bash
sudo nano /etc/systemd/system/caffix-frontend.service
```

Paste the following configuration:
```ini
[Unit]
Description=CAFFIX FastAPI Static Web Server
After=network.target caffix-backend.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/caffix
ExecStart=/home/pi/caffix/venv/bin/python main.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### 3.3 Enable and Start Services
Reload the systemd daemon, enable the services to start at boot, and run them immediately:

```bash
sudo systemctl daemon-reload

# Enable services for auto-boot
sudo systemctl enable caffix-backend.service
sudo systemctl enable caffix-frontend.service

# Start services now
sudo systemctl start caffix-backend.service
sudo systemctl start caffix-frontend.service

# Check their status
sudo systemctl status caffix-backend.service
sudo systemctl status caffix-frontend.service
```

---

## 4. Configuring Touchscreen Kiosk Auto-Boot

To automatically launch Chromium in full-screen kiosk mode pointing to the user interface, configure the desktop session autostart.

### 4.1 Hide Mouse Cursor
We will use `unclutter` to hide the cursor since it is a touch interface:
```bash
# Handled in the autostart script
```

### 4.2 Create Autostart Script
Create a startup script to set up display configurations and launch the browser:

```bash
mkdir -p /home/pi/.config/caffix
nano /home/pi/.config/caffix/kiosk-start.sh
```

Paste the following script details:
```bash
#!/bin/bash

# Disable screen blanking, screensaver, and power management (DPMS)
xset s off
xset s noblank
xset -dpms

# Hide mouse cursor after 1 second of inactivity
unclutter -idle 1 -root &

# Wait for servers to fully load
sleep 5

# Launch Chromium in kiosk mode
chromium-browser \
  --noerrdialogs \
  --disable-infobars \
  --kiosk \
  --app=http://localhost:8000 \
  --no-first-run \
  --fast \
  --fast-start \
  --disable-translate \
  --disable-features=TranslateUI \
  --disk-cache-dir=/dev/null \
  --password-store=basic
```

Make the script executable:
```bash
chmod +x /home/pi/.config/caffix/kiosk-start.sh
```

### 4.3 Setup Desktop Autostart Entry
To run this script automatically when the desktop GUI starts:

```bash
mkdir -p /home/pi/.config/autostart
nano /home/pi/.config/autostart/caffix-kiosk.desktop
```

Paste the following configuration:
```ini
[Desktop Entry]
Type=Application
Name=CAFFIX Touch Kiosk
Exec=/home/pi/.config/caffix/kiosk-start.sh
NoDisplay=false
Terminal=false
X-GNOME-Autostart-enabled=true
```

---

## 5. Disabling Touchscreen Sleep & Blanking

By default, Raspberry Pi OS turns off the screen after 10-15 minutes of inactivity. To ensure the vending machine welcome screen is always active, add configuration overrides:

### Wayland (Raspberry Pi OS 12 Bookworm Default)
If your OS is using Wayland/Wayfire, modify the Wayfire configuration file:

```bash
nano /home/pi/.config/wayfire.ini
```

Find or add the `[idle]` section and set DPMS timeout to `0` (disabled):
```ini
[idle]
dpms_timeout = 0
screensaver_timeout = 0
```

### X11 (Raspberry Pi OS 11 Bullseye Default)
If using X11, modify the lightdm config:
```bash
sudo nano /etc/lightdm/lightdm.conf
```

Find the `[Seat:*]` section, and edit the `xserver-command` line to add screen power-saving overrides:
```ini
xserver-command=X -s 0 -dpms
```

---

## 6. Verification & Troubleshooting

### Check Server Logs
If the kiosk screens aren't loading, check systemd logs:
```bash
# View live Express backend logs
sudo journalctl -u caffix-backend.service -f -n 100

# View live FastAPI frontend logs
sudo journalctl -u caffix-frontend.service -f -n 100
```

### Test API Response
Verify the backend responds correctly to queries directly on the Raspberry Pi:
```bash
curl http://localhost:5000/health
```

Expected output:
```json
{"status":"success","message":"Welcome to CAFFIX Vending REST API Server","docs":"/api-docs"}
```

---

## 7. Razorpay Key & Webhook Configuration

To enable payments via Razorpay, environment variables must be declared in `/home/pi/caffix/caffix-backend/.env`:

### 7.1 Required Environment Variables
Add the following variables to `.env`:
```ini
# Razorpay API Credentials
RAZORPAY_KEY_ID=rzp_test_YourKeyIDHere
RAZORPAY_KEY_SECRET=YourSecretKeyHere

# Razorpay Webhook Secret (for cryptographically verifying incoming event payloads)
RAZORPAY_WEBHOOK_SECRET=YourWebhookSecretHere
```

### 7.2 Testing Payments in Razorpay Test Mode
1. **Switch to Test Mode**: Go to the Razorpay Dashboard and toggle the header switch to **Test Mode**.
2. **Generate API Keys**: Navigate to **Account & Settings** → **API Keys** and generate a new key set. Paste them as `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `.env`.
3. **Register Webhook**: 
   - Go to **Account & Settings** → **Webhooks** → **Add New Webhook**.
   - Set the URL to: `https://<your-public-domain-or-ip>/api/payments/webhook`
   - Set the Secret to a custom passcode (e.g. `caffix_webhook_secret_123`) and save it as `RAZORPAY_WEBHOOK_SECRET` in `.env`.
   - Select active events: `order.paid` and `payment.captured`.
4. **Trigger Test Checkout**:
   - Order a beverage on the kiosk screen.
   - When the Razorpay Checkout form launches, select a payment method:
     * **Card**: Use Test Card numbers (e.g. `4111 1111 1111 1111`, Expiry: future date, CVV: `123`) and select "Success".
     * **UPI**: Type any test VPA (e.g., `success@razorpay`) or click the QR code to approve.
     * **Net Banking**: Choose HDFC/SBI, select "Success" on the simulated bank page.
     * **Wallets**: Choose Paytm/PhonePe Wallet options.
5. **Verify Processing**: The backend verifies the signature header, transitions status to `PAID` (deducting levels in SQLite), and routes to the coffee brewing screen.

---

## 8. Multi-Machine Deployment & Registration

CAFFIX supports running 10, 50, or 100+ vending machines from a single Vercel deployment, single Firebase Firestore database, and single Razorpay account.

### 8.1 Kiosk URLs per Machine
Each Raspberry Pi Chromium browser launches the single Vercel deployment with its `kiosk` credential and `machine_id`:
- **Machine 1**: `https://vendingcaffix.vercel.app/?kiosk=Kx8P2mL9Qv4Rz7Tn5Yh1&machine_id=CFX-MC-01`
- **Machine 2**: `https://vendingcaffix.vercel.app/?kiosk=Kx8P2mL9Qv4Rz7Tn5Yh1&machine_id=CFX-MC-02`
- **Machine 3**: `https://vendingcaffix.vercel.app/?kiosk=Kx8P2mL9Qv4Rz7Tn5Yh1&machine_id=CFX-MC-03`

### 8.2 Per-Machine Kiosk Credentials (Optional Hardening)
You can assign unique secrets per machine via environment variables on Vercel:
```ini
KIOSK_SECRET=Kx8P2mL9Qv4Rz7Tn5Yh1
KIOSK_MACHINE_KEYS=CFX-MC-01:Kx8P2mL9Qv4Rz7Tn5Yh1,CFX-MC-02:Kx8P2mL9Qv4Rz7Tn5Yh2,CFX-MC-03:Kx8P2mL9Qv4Rz7Tn5Yh3
REGISTERED_MACHINES=CFX-MC-01,CFX-MC-02,CFX-MC-03,CFX-MC-04,CFX-MC-05
```
Or register new machines dynamically via `POST /api/machines/register` with an Admin Bearer token.

### 8.3 Raspberry Pi Order Processor Configuration
On each Raspberry Pi, set `MACHINE_ID` in its environment (e.g. `MACHINE_ID="CFX-MC-01"` on Machine 1, `MACHINE_ID="CFX-MC-02"` on Machine 2) and use `MachineOrderProcessor` from `rpi_order_processor.py` to filter Firestore `orders` by `machine_id` and claim orders atomically via Firestore transactions.

---

## 9. Scheduled Pending Order Reconciliation (Vercel Hobby + External Scheduler)

To ensure abandoned checkouts or payments interrupted by kiosk power/network loss do not remain `PENDING` indefinitely, the backend exposes a dedicated reconciliation endpoint secured by `CRON_SECRET`.

Because the project runs on the **Vercel Hobby (Free)** plan—which does not support five-minute native Vercel Crons—`vercel.json` intentionally omits any `"crons"` configuration. Trigger reconciliation every **5 minutes** using an external HTTP scheduler (for example, cron-job.org, GitHub Actions `schedule`, Google Cloud Scheduler, or an external systemd/cron job).

### 9.1 External Scheduler Configuration
- **Production URL**: `https://vendingcaffix.vercel.app/api/cron/reconcile-orders`
- **HTTP Method**: `GET` (`POST` is also accepted for manual authenticated runs)
- **Schedule / Interval**: Every 5 minutes (`*/5 * * * *`)
- **Required Header**:
  ```http
  Authorization: Bearer <CRON_SECRET>
  ```
- **Overlap & Concurrency Protection**: Concurrent invocations share an atomic Firestore lease (`system_locks/order_reconciliation`) and per-order Firestore transactions, returning HTTP `200` (`skipped_due_to_active_run: true`) if another run already holds the lease and preventing duplicate inventory deductions.

### 9.2 Server-Side Environment Variables (`vendingcaffix` Production ONLY)
- **`CRON_SECRET` (Required, Production-only)**:
  - Generate a cryptographically random secret of at least 16 characters (recommended 64 hex chars: `openssl rand -hex 32`).
  - Configure `CRON_SECRET` **only** in the **`vendingcaffix`** Vercel project (`Production` environment) and inside your external scheduler's encrypted/masked secret store.
  - Do **not** add `CRON_SECRET` to `caffix-app`, `caffix-admin`, `caffix-owner`, any `VITE_*` build variable, Preview/Staging variables, browser code, or application logs.
- **Optional Tuning Environment Variables**:
  - `ORDER_RECONCILIATION_MAX_AGE_MINUTES` (default: `10`, minimum: `1`): Only `PENDING` orders older than this threshold are evaluated.
  - `ORDER_RECONCILIATION_BATCH_LIMIT` (default: `50`, range: `1..200`): Maximum eligible orders processed per invocation, oldest first.

### 9.3 Safe Endpoint Verification
Verify without exposing `CRON_SECRET` in logs or shared terminal history:
1. **Unauthenticated check** (expects HTTP `401 Unauthorized`, or `503` if `CRON_SECRET` is unset):
   ```bash
   curl -i https://vendingcaffix.vercel.app/api/cron/reconcile-orders
   ```
2. **Authenticated check** (pass the secret via a temporary environment variable and avoid printing the command/secret in CI logs; expects HTTP `200` JSON summary):
   ```bash
   curl -sS -f -X GET "https://vendingcaffix.vercel.app/api/cron/reconcile-orders" \
     -H "Authorization: Bearer ${CRON_SECRET}"
   ```
   A healthy response returns counters (`scanned`, `eligible`, `reconciled_paid`, `marked_failed`, `marked_cancelled`, `kept_pending`, `skipped`, `too_recent`, `errors`, `cutoff_iso`) without modifying recent (`< 10m`) or non-`PENDING` orders.

### 9.4 Reconciliation Rules & Environment Isolation
- **Captured payment** (payment `captured` or Razorpay order `paid` with full `amount_paid`): atomically transitions order to `PAID` and deducts inventory once.
- **Definitively failed payment** (only `failed` payment attempts and no active/captured payment): transitions order to `FAILED` without inventory deduction.
- **Abandoned checkout** (Razorpay order `created` with `attempts === 0` and zero payment records): transitions order to `CANCELLED` without inventory deduction.
- **Authorized / in-flight (`created`) payment or Razorpay API error**: preserves `PENDING` for retry on a future run.
- **Strict Isolation**: `VERCEL_ENV=production` requires `FIREBASE_PROJECT_ID=caffix-vending` and real Live/configured Razorpay credentials + `CRON_SECRET` (otherwise returns HTTP `503`). `VERCEL_ENV=preview` requires `FIREBASE_PROJECT_ID=caffix-staging` and rejects `rzp_live_*` Razorpay Live keys with HTTP `503`.

---

## 10. Production Super Admin Bootstrap (One-Time Local Script)

In `VERCEL_ENV=production`, automatic creation of default staging users (`users/1` / `admin123`) is disabled. Before signing into `caffix-admin` for the first time on Production, run the one-time local bootstrap script from a trusted interactive terminal.

### 10.1 Safety Precautions
- Run **only** after rotating and provisioning the Production `caffix-vending` Firebase service account credentials.
- Never commit `.env` files, service-account JSONs, private keys, or passwords.
- Never pipe a plaintext password via stdin or pass it on the command line (password entry requires interactive hidden TTY input).
- The script enforces `FIREBASE_PROJECT_ID=caffix-vending`, refuses `caffix-staging` or Preview environments, and executes an atomic create-only Firestore transaction (aborting if the email or any existing Super Admin already exists).

### 10.2 Execution Steps
1. Export only the required Production Firebase Admin SDK variables in your **ephemeral** shell session (PowerShell example; close terminal afterward):
   ```powershell
   $env:VERCEL_ENV = "production"
   $env:FIREBASE_PROJECT_ID = "caffix-vending"
   $env:FIREBASE_CLIENT_EMAIL = "<your-production-service-account-email>"
   $env:FIREBASE_PRIVATE_KEY = "<your-production-private-key>"
   ```
2. Run the bootstrap script interactively from `caffix-backend/`:
   ```powershell
   Push-Location caffix-backend
   npx.cmd ts-node --transpile-only src\scripts\bootstrapProdSuperAdmin.ts
   Pop-Location
   ```
   (Or run the compiled JavaScript build: `node caffix-backend\dist\scripts\bootstrapProdSuperAdmin.js`.)
3. When prompted:
   - Type `caffix-vending` to confirm the target project.
   - Enter Super Admin full name and email.
   - Enter and confirm a strong password (`>= 12` chars with uppercase, lowercase, digit, and special character; input is hidden).
4. Close the terminal session to clear ephemeral credentials from memory, then verify login via the **`caffix-admin`** Super Admin portal.


