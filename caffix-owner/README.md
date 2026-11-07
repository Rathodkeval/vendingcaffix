# CAFFIX Owner Dashboard (`caffix-owner`)

Separate React + Vite SaaS portal for CAFFIX vending machine owners and administrators.

---

## 1. Architecture Overview
- **Kiosk Frontend (`caffix-app`)**: `https://vendingcaffix.vercel.app` (Unchanged)
- **Owner Portal (`caffix-owner`)**: `https://caffix-owner.vercel.app` (Separate Vercel project deployed from `caffix-owner/`)
- **Shared Backend API (`caffix-backend`)**: `https://vendingcaffix.vercel.app/api`
- **Database**: Firebase Firestore (authoritative in production) + SQLite/MockDatabase cache.

---

## 2. Vercel Deployment Configuration (Option A: Separate Vercel Project)

When importing this repository into Vercel as the new `caffix-owner` project, configure:

| Setting | Value |
| :--- | :--- |
| **Framework Preset** | `Vite` |
| **Root Directory** | `caffix-owner` |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |
| **Install Command** | `npm install` |

### Required Environment Variables (on the `caffix-owner` Vercel Project)

| Variable Name | Production Value | Description |
| :--- | :--- | :--- |
| `VITE_API_BASE_URL` | `https://vendingcaffix.vercel.app/api` | Points the Owner Dashboard to the existing CAFFIX backend API. |

> **Security Note**: Never add `FIREBASE_PRIVATE_KEY`, `RAZORPAY_KEY_SECRET`, or `JWT_SECRET` to the `caffix-owner` frontend Vercel project. All privileged operations and Firestore reads/writes are authenticated through `caffix-backend`.

---

## 3. Local Development & Testing

```bash
cd caffix-owner
npm install

# Run local development server (http://localhost:5174)
npm run dev

# Build production bundle into dist/
npm run build

# Run end-to-end integration test suite
npm test
```

