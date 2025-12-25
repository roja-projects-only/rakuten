# Rakuten Ops Dashboard (web)

React + Vite single-page dashboard with Vercel serverless APIs for coordinator status and recent VALID captures (Redis-backed). This lives in `/web` on branch `web-dashboard` so it can be split into its own repo later.

## Quick start

```bash
npm install
# terminal 1: local API for /api/status and /api/valids
npm run dev:api
# terminal 2: Vite frontend (proxies /api to 3000 by default)
npm run dev
```

The local API server loads `/web/.env.local` explicitly (dotenv), so put your `ALLOWED_IPS`, `REDIS_URL`, and endpoint URLs there.

## Required env (API + frontend)

Set these in Vercel/`.env.local` before deploy:

- `REDIS_URL` — Redis instance used by coordinator/workers.
- `ALLOWED_IPS` — comma list of allowed client IPs (e.g. `203.0.113.10,198.51.100.7`). Empty list blocks all.
- `COORDINATOR_STATUS_URL` — coordinator `/status` endpoint (e.g. `http://coordinator.internal:9090/status`).
- `POW_SERVICE_HEALTH_URL` — pow-service `/health` endpoint.
- `POW_SERVICE_STATS_URL` — pow-service `/stats` endpoint. (If omitted, derives from `POW_SERVICE_URL`.)
- `POW_SERVICE_URL` — base URL for pow-service (used to derive stats/health when explicit URLs are not set).

Optional:
- `REDIS_COMMAND_TIMEOUT` — override Redis command timeout (ms).
- `VITE_API_BASE` — if hosting API separately, point the frontend at it; defaults to same origin.
- `VITE_API_PROXY_TARGET` — Vite dev-only proxy target for `/api` (defaults to `http://localhost:3000`). Use when running `vercel dev` locally.

## What the APIs do

- `GET /api/status` — proxies coordinator status and pow-service health/stats. IP-allowlisted.
- `GET /api/valids?limit=50` — scans Redis `proc:VALID:*` keys, sorts by timestamp, joins `cap:VALID:*` summaries (if present), and returns the latest entries. IP-allowlisted.

## Capture persistence (coordinator mode)

Workers now write trimmed capture summaries to Redis at `cap:VALID:{username}:{password}` with the same TTL as processed creds (30d, or `PROCESSED_TTL_MS`). Fields: username, ipAddress, ts, points, cash, rank, latestOrder, latestOrderId, cards, address, profile. If a capture is missing, the write is skipped.

## Deploying to Vercel

1) Ensure env vars above are set in the project. 2) Deploy; Vercel builds the Vite app (`dist`) and ships `/api` serverless functions via `vercel.json`. 3) Restrict access via `ALLOWED_IPS` and upstream network rules.

## Notes

- IP allowlist is required; an empty list returns 403.
- Redis errors surface as 500 from the API; frontend shows the error banner.
- Frontend auto-refreshes status every 15s and valids every 30s; use the "Refresh now" button to force-refresh.
