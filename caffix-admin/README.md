# CAFFIX Super Admin Dashboard (`caffix-admin`)

Standalone React + Vite portal exclusively for **CAFFIX Super Admin** accounts (`role === 'admin'`).

## Architecture
- **Admin Portal (`caffix-admin`)**: Super Admin fleet management, machine registration & assignment, owner onboarding, per-machine pricing & availability, inventory refill, maintenance mode control, orders, and global sales analytics.
- **Owner Portal (`caffix-owner`)**: Separate purchaser portal exclusively for machine owners (`role === 'owner'`).
- **Kiosk Frontend (`caffix-app`)**: Customer vending kiosk frontend.
- **Shared Backend (`caffix-backend`)**: `https://vendingcaffix.vercel.app/api`

## Production Vercel Configuration

| Setting | Value |
| :--- | :--- |
| **Framework Preset** | `Vite` |
| **Root Directory** | `caffix-admin` |
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |
| **Install Command** | `npm install` |

### Required Frontend Environment Variables (`caffix-admin`)

| Variable | Production Value Example | Purpose |
| :--- | :--- | :--- |
| `VITE_API_BASE_URL` | `https://vendingcaffix.vercel.app/api` | Shared CAFFIX backend API URL (`http://localhost:5000/api` on localhost). |
| `VITE_OWNER_PORTAL_URL` | `https://caffix-owner.vercel.app` | Base URL of the Owner Portal used when building `#setup_token=...` invite links (`http://localhost:5174` on localhost). |

### Backend CORS & Token Isolation
- `caffix-admin` stores JWTs under `caffix_admin_jwt`, sends `portal: "admin"` on `POST /api/auth/login`, and verifies sessions via `GET /api/auth/me?portal=admin`.
- If `caffix-admin` is hosted on a custom domain or preview URL not in `DEFAULT_ALLOWED_ORIGINS`, add that origin to `CORS_ALLOWED_ORIGINS` on the backend Vercel project.
- **Security Note**: Never add `JWT_SECRET`, `ADMIN_PASSCODE`, `FIREBASE_*`, or `RAZORPAY_*` environment variables to the `caffix-admin` Vercel project.
