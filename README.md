# grains-backend

Node.js + Express API for Vittorios Grains & Cereals — multi-branch wholesale e-commerce and order management. See the repo root `CLAUDE.md` for full architecture notes (multi-tenancy, order lifecycle, notifications, etc.).

## Setup

```bash
npm install
cp .env.example .env   # or create .env manually — see "Environment variables" below
npm run dev            # nodemon, http://localhost:5000
```

Requires Node `>=20 <23` and a reachable MongoDB instance (Atlas dev/staging cluster — never point local dev at the production cluster).

## Scripts

| Script | Purpose |
|---|---|
| `npm start` | Run the server (production mode, no reload) |
| `npm run dev` | Run with nodemon (auto-reload) |
| `npm run prod` | Run under PM2 (`ecosystem.config.js`) |
| `npm test` | Run the backend test suite (`node --test`) |
| `npm run sync:indexes` | Sync Mongoose indexes against the connected DB |

## Tests

`backend/tests/` uses Node's built-in `node:test` runner (no separate test framework) plus `mongodb-memory-server` to spin up an isolated single-node replica set, since most services use multi-document transactions. Run with:

```bash
npm test
```

Current coverage: order lifecycle (placement, approval, rejection, cancellation), stock reservation/release (including concurrent-oversell protection), coupon usage (race-safe increment/release), M-Pesa callback handling, and product import/export helpers. Everything else (controllers/routes, admin flows, frontend) is still manual — see the repo root `PRODUCTION-TODO.md`.

## Environment variables

Two environments: **local dev** (`backend/.env`, gitignored) and **production** (env vars set directly in the Render dashboard, never committed). Full reference lists live in the repo root `CLAUDE.md` under "Environment Variables" — this is the authoritative source; keep both in sync when adding a new var.

Key groups: server (`PORT`, `NODE_ENV`, `FRONTEND_URL`), MongoDB (`MONGODB_URI`), JWT secrets, Cloudinary, M-Pesa Daraja, Africa's Talking SMS, Gmail SMTP, Sentry, and backup storage (`BACKUP_STORAGE_DIR`).

## Deployment

Deployed on Render (`grains-backend-b3n0.onrender.com`), `NODE_ENV=production`. Push to the branch Render tracks to trigger an auto-deploy — this is a standalone git repo (not the outer `Grains-System` folder), so `git push` from `backend/` deploys directly.
