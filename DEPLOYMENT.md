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

