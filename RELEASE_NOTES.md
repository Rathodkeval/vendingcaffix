# CAFFIX Owner Dashboard — Release Notes (`owner-dashboard-release`)

## 1. Release Summary
This release introduces the multi-tenant **CAFFIX Owner Dashboard (`caffix-owner`)**, multi-machine backend management APIs, per-machine beverage pricing & availability, safe maintenance mode transitions, atomic SHA-256 invitation token onboarding, and 30-second Raspberry Pi 4 Firestore heartbeats—while keeping the existing customer kiosk (`caffix-app`), Razorpay checkout flow, and Arduino GIGA R1 dispensing logic 100% intact.

---

## 2. Completed Functionality by Stage

### Stage 1: Database Schema, Authoritative Firestore Sync & Mode/Connectivity Separation
- Separated Owner/Admin operational mode (`desired_mode`: `'RUNNING'` | `'MAINTENANCE'`) from Raspberry Pi connectivity (`connection_status`: `'ONLINE'` | `'OFFLINE'` computed dynamically from `last_seen` with a 90-second threshold).
- Guaranteed that Raspberry Pi heartbeats (`last_seen`) never overwrite `desired_mode` or `status`, and Owner mode toggles never overwrite `last_seen`.
- Added `owner_id`, `desired_mode`, and `machine_products` schema support across SQLite, serverless `MockDatabase`, and authoritative Firestore collections.
- Explicitly labeled ingredient inventory levels as `inventory_source: "software_estimated"`.

### Stage 2: Secure Owner Invitations, Atomic Password Setup & Live Machine Ownership Enforcement
- Implemented stable UUID-based user identifiers (`usr_<uuid>`) across SQLite, `MockDatabase`, and Firestore (`users/{id}`).
- Added Admin-only owner invitation endpoint (`POST /api/auth/owners/invite`) generating a 256-bit cryptographically random single-use token, storing only its SHA-256 hash (`setup_token_hash`) with a 24-hour expiration.
- Implemented atomic token consumption (`consumeSetupTokenAtomically`) in `POST /api/auth/setup-password` using a Firestore transaction + in-process mutex + conditional SQLite update so concurrent requests with the same token cannot both succeed.
- Implemented `assertMachineOwnershipOrAdmin` to verify live machine ownership in Firestore/SQLite on every protected request rather than trusting static JWT claims.

### Stage 3: Per-Machine Pricing, Product Availability & Safe Maintenance Transition
- Implemented per-machine product price and availability overrides via `GET /api/machines/:id/products` and `PUT /api/machines/:id/products/:productId` (stored in `machine_products` and Firestore `machines/{id}.products`).
- Updated `GET /api/products?machine_id=...` so each kiosk receives its own machine-specific prices and availability while preserving global catalog defaults.
- Enforced server-side price calculation in `POST /api/orders/create`: the backend rejects manipulated frontend amounts (`400 Bad Request`) and stores the actual charged price in `orders.amount` so historical sales reports remain accurate after future price changes.
- Implemented **Safe Maintenance Transition**: switching a machine to `MAINTENANCE` blocks new orders (`POST /api/orders/create`) while allowing already-created/paid orders to finish payment verification (`POST /api/payments/verify`), webhook processing, and physical dispensing (`PUT /api/orders/:id/status`).

### Stage 4: Raspberry Pi 4 Heartbeat Integration
- Added a dedicated daemon thread in [`rpi_order_processor.py`](./rpi_order_processor.py) that updates `machines/{machine_id}.last_seen` in Firestore every 30 seconds (`merge=True`) without overwriting `desired_mode`, `status`, `owner_id`, `products`, or `estimated_inventory`.
- Heartbeat runs independently of the Arduino GIGA R1 USB serial connection and recovers automatically from transient network/Firestore errors without crashing the order processor.
- Updated [`caffix-vending.service`](./caffix-vending.service) to load machine configuration from `/etc/caffix/machine.env` (`EnvironmentFile=-/etc/caffix/machine.env`).
- Added unit test suite [`test_rpi_heartbeat.py`](./test_rpi_heartbeat.py).

### Stage 5 & Final Security Audit: CAFFIX Owner Dashboard (`caffix-owner`)
- Built standalone React 19 + Vite 8 + Tailwind CSS v4 application in [`caffix-owner/`](./caffix-owner) prepared for `https://caffix-owner.vercel.app`.
- Implemented **Overview**, **My Machines**, **Machine Details & Software-Estimated Inventory Refill**, **Products & Per-Machine Pricing**, **Orders**, **Sales & Revenue Reports (Daily/Weekly/Monthly/All-Time)**, **Fleet & Owner Administration (Admin)**, and **Owner Login / Invite Token Activation**.
- **Final Audit Fixes Applied**:
  1. Aligned `ownerApi.changePassword` payload keys (`{ current_password, new_password }`) with `POST /api/auth/change-password`.
  2. Aligned `AdminFleetPage.jsx` pending-setup badge with `must_change_password` from `GET /api/auth/owners`.
  3. Replaced query-string invitation links (`?setup_token=...`) with URL fragments (`#setup_token=...&email=...`) and immediate `window.history.replaceState` cleanup so raw tokens are never sent in HTTP URLs or `Referer` headers.
  4. Replaced wildcard `cors()` in [`caffix-backend/src/index.ts`](./caffix-backend/src/index.ts) with an explicit origin allowlist permitting `https://caffix-owner.vercel.app`, `https://vendingcaffix.vercel.app`, and local development origins.

---

## 3. New Files & Key Modified Files

### New Files
- [`caffix-owner/`](./caffix-owner) — Complete standalone Owner Dashboard React + Vite application and integration test suite ([`caffix-owner/src/tests/owner_dashboard.test.mjs`](./caffix-owner/src/tests/owner_dashboard.test.mjs)).
- [`caffix-backend/src/tests/stage2_auth_ownership.test.ts`](./caffix-backend/src/tests/stage2_auth_ownership.test.ts) — Stage 2 authentication, atomic token consumption, and live ownership test suite.
- [`caffix-backend/src/tests/stage3_pricing_maintenance.test.ts`](./caffix-backend/src/tests/stage3_pricing_maintenance.test.ts) — Stage 3 per-machine pricing, availability, and safe maintenance transition test suite.
- [`test_rpi_heartbeat.py`](./test_rpi_heartbeat.py) — Stage 4 Raspberry Pi heartbeat unit test suite.
- [`RELEASE_DEPLOYMENT_CHECKLIST.md`](./RELEASE_DEPLOYMENT_CHECKLIST.md) — Production deployment, verification, and rollback guide.
- [`RELEASE_NOTES.md`](./RELEASE_NOTES.md) — Release documentation.

### Modified Files
- [`caffix-backend/src/index.ts`](./caffix-backend/src/index.ts) — Strict CORS origin allowlist (`isAllowedCorsOrigin`).
- [`caffix-backend/src/config/db.ts`](./caffix-backend/src/config/db.ts) — Schema migrations (`desired_mode`, `owner_id`, `setup_token_hash`, `machine_products`) and serverless `MockDatabase` support.
- [`caffix-backend/src/utils/firebase.ts`](./caffix-backend/src/utils/firebase.ts) — Authoritative Firestore helpers, atomic setup-token transaction, and 90-second heartbeat `connection_status` calculation.
- [`caffix-backend/src/middleware/auth.ts`](./caffix-backend/src/middleware/auth.ts) — `assertMachineOwnershipOrAdmin` live database/Firestore ownership check.
- [`caffix-backend/src/controllers/authController.ts`](./caffix-backend/src/controllers/authController.ts) — `inviteOwner`, `setupPassword`, `changePassword`, `getMe`, `getOwners`.
- [`caffix-backend/src/controllers/machineController.ts`](./caffix-backend/src/controllers/machineController.ts) — Machine mode (`PATCH /api/machines/:id/status`), owner assignment (`PATCH /api/machines/:id/owner`), per-machine products (`GET/PUT /api/machines/:id/products`), heartbeat (`POST /api/machines/:id/heartbeat`), and inventory refills.
- [`caffix-backend/src/controllers/orderController.ts`](./caffix-backend/src/controllers/orderController.ts) — Authoritative per-machine price enforcement, unavailable product rejection, safe maintenance transition, and owner-scoped order history.
- [`caffix-backend/src/controllers/productController.ts`](./caffix-backend/src/controllers/productController.ts) — Machine-specific catalog merging for `GET /api/products?machine_id=...`.
- [`rpi_order_processor.py`](./rpi_order_processor.py) & [`caffix-vending.service`](./caffix-vending.service) — 30-second non-destructive Firestore heartbeat thread and systemd environment configuration.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — Updated Raspberry Pi systemd service documentation.

---

## 4. API Summary

| Method & Endpoint | Access | Description |
| :--- | :--- | :--- |
| `POST /api/auth/login` | Public | Authenticates Admin, Owner, or Kiosk and returns 24h JWT |
| `POST /api/auth/setup-password` | Public (Token) | Atomically consumes single-use SHA-256 invitation token and sets bcrypt password |
| `POST /api/auth/change-password` | Admin, Owner | Updates password after verifying `current_password` |
| `GET /api/auth/me` | Admin, Owner | Returns user profile and live `assigned_machines` list |
| `GET /api/auth/owners` | Admin | Lists all owner accounts and their assigned machines |
| `POST /api/auth/owners/invite` | Admin | Creates owner account, assigns machines, and returns single-use 24h `invite_token` |
| `GET /api/machines` | Admin, Owner | Lists all machines (Admin) or only assigned machines (Owner) |
| `GET /api/machines/:id` | Admin, Owner | Returns machine details, `connection_status`, `desired_mode`, and `estimated_inventory` |
| `PATCH /api/machines/:id/status` | Admin, Owner | Updates `desired_mode` (`RUNNING` \| `MAINTENANCE`) without overwriting `last_seen` |
| `PATCH /api/machines/:id/owner` | Admin | Assigns or unassigns `owner_id` on a machine |
| `POST /api/machines/register` | Admin | Registers a new vending machine and initializes default estimated inventory |
| `GET /api/machines/:id/products` | Admin, Owner | Returns catalog merged with machine-specific price & availability overrides |
| `PUT /api/machines/:id/products/:productId` | Admin, Owner | Sets machine-specific product `price` and/or `is_available` |
| `POST /api/machines/:machine_id/refill` | Admin, Owner | Resets software-estimated ingredient level(s) to 100% |
| `GET /api/orders` | Admin, Owner, Kiosk | Returns orders scoped to the authenticated owner's machines (or filtered by `machine_id`) |

---

## 5. Known Limitations & Outstanding Manual Production Checks
- **Software-Estimated Inventory**: Ingredient percentages are calculated in software from dispensed drink recipes and manual refill resets rather than physical hardware level sensors, and are explicitly labeled **Software-Estimated** across the UI and API.
- **Manual Production Actions Required After Approval**:
  1. Push the `owner-dashboard-release` branch to GitHub and deploy the backend update on Vercel.
  2. Create the `caffix-owner` Vercel project with `VITE_API_BASE_URL=https://vendingcaffix.vercel.app/api`.
  3. Pull the updated `rpi_order_processor.py` and `caffix-vending.service` on each physical Raspberry Pi 4 and restart `caffix-vending.service`.

