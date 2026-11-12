# CAFFIX Owner Dashboard (`caffix-owner`)

Standalone React + Vite portal exclusively for **CAFFIX Machine Owners** (`role === 'owner'`). Administrator accounts (`role === 'admin'`) are rejected with HTTP `403` and must use `caffix-admin`.

---

## 1. Architecture Overview
- **Owner Portal (`caffix-owner`)**: Purchaser portal for assigned machines, per-machine pricing & product availability, software-estimated inventory refills, maintenance mode control, and assigned-machine orders & reports.
- **Admin Portal (`caffix-admin`)**: Separate Super Admin portal (`role === 'admin'`).
- **Kiosk Frontend (`caffix-app`)**: Customer vending kiosk UI (`https://vendingcaffix.vercel.app`).
- **Shared Backend API (`caffix-backend`)**: `https://vendingcaffix.vercel.app/api`
- **Database**: Firebase Firestore (authoritative in deployed environments).

---

## 2. Production Vercel Configuration

| Setting | Value |
| :--- | :--- |
| **Framework Preset** | `Vite` |
| **Root Directory** | `caffix-owner` |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |
| **Install Command** | `npm install` |

### Required Frontend Environment Variables (`caffix-owner`)

| Variable Name | Production Value Example | Description |
| :--- | :--- | :--- |
| `VITE_API_BASE_URL` | `https://vendingcaffix.vercel.app/api` | Shared CAFFIX backend API URL (defaults to `http://localhost:5000/api` on localhost). |
| `VITE_ADMIN_PORTAL_URL` | `https://caffix-admin.vercel.app` | Optional Super Admin portal URL displayed when an admin tries to sign into the Owner Dashboard. |

### Backend CORS & Token Isolation
- `caffix-owner` stores JWTs under `caffix_owner_jwt`, sends `portal: "owner"` on `POST /api/auth/login`, verifies sessions via `GET /api/auth/me?portal=owner`, and parses one-time invitation links via URL fragments (`#setup_token=...&email=...`) so tokens never appear in query strings.
- If `caffix-owner` uses a custom domain not listed in `DEFAULT_ALLOWED_ORIGINS`, add it to `CORS_ALLOWED_ORIGINS` on the backend Vercel project.
- **Security Note**: Never add `FIREBASE_PRIVATE_KEY`, `RAZORPAY_KEY_SECRET`, `ADMIN_PASSCODE`, or `JWT_SECRET` to the `caffix-owner` Vercel project.

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
