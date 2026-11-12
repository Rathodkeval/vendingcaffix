# CAFFIX Super Admin Dashboard (`caffix-admin`)

Standalone React + Vite portal exclusively for **CAFFIX Super Admin** accounts (`role === 'admin'`).

## Architecture
- **Admin Portal (`caffix-admin`)**: Super Admin fleet management, owner onboarding, machine registration & assignment, global orders, and global sales analytics.
- **Owner Portal (`caffix-owner`)**: Separate purchaser portal exclusively for machine owners (`role === 'owner'`).
- **Kiosk Frontend (`caffix-app`)**: Unchanged customer kiosk UI.
- **Shared Backend (`caffix-backend`)**: `https://vendingcaffix.vercel.app/api` (or staging preview alias).

## Environment Variables
| Variable | Purpose |
| :--- | :--- |
| `VITE_API_BASE_URL` | Backend REST API URL (`http://localhost:5000/api` in local dev) |
| `VITE_OWNER_PORTAL_URL` | Owner Dashboard base URL used when building `#setup_token=` invite links (`http://localhost:5174` in local dev) |

