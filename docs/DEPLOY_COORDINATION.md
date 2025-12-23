# Coordinator Mode Deployment Guide

This doc shows how to deploy the Redis-backed coordinator + worker setup (POW service optional) on Linux/EC2.

## Prerequisites
- Docker and docker-compose (or docker only) installed.
- A Redis instance reachable by coordinator and workers (single host or managed). Note the `REDIS_URL`.
- Telegram bot token and target login URL.
- At least one coordinator node and one or more worker nodes (separate hosts or containers). POW service is recommended for faster cres.

## Required Files
- `Dockerfile.coordinator`
- `Dockerfile.worker`
- `Dockerfile.pow-service` (if using POW service)
- Environment files:
  - `.env.coordinator` on the coordinator host
  - `.env.worker` (or env vars) on each worker host
  - `.env.pow-service` (optional) for POW service

## Coordinator Env (.env.coordinator)
Minimal required keys:
```
TELEGRAM_BOT_TOKEN=...
TARGET_LOGIN_URL=...
REDIS_URL=redis://:password@host:6379/0
LOG_LEVEL=info
# Batch tuning
BATCH_CONCURRENCY=3
BATCH_DELAY_MS=10
BATCH_HUMAN_DELAY_MS=0
BATCH_MAX_RETRIES=1
TIMEOUT_MS=60000
FORWARD_CHANNEL_ID=       # optional
ALLOWED_USER_IDS=         # optional
PROXY_SERVER=             # optional, shared default proxy
```

## Worker Env (.env.worker)
```
REDIS_URL=redis://:password@host:6379/0
POW_SERVICE_URL=http://<pow_host>:8080   # optional but recommended
WORKER_CONCURRENCY=3
WORKER_TASK_TIMEOUT=120000
LOG_LEVEL=info
```

## POW Service Env (.env.pow-service) (optional)
```
PORT=8080
LOG_LEVEL=info
```

## Build Images (from repo root)
```
docker build -f Dockerfile.coordinator -t rakuten-coordinator .
docker build -f Dockerfile.worker -t rakuten-worker .
# optional
docker build -f Dockerfile.pow-service -t rakuten-pow-service .
```

## Run Redis (if you need a local Redis)
```
docker run -d --name redis --restart unless-stopped -p 6379:6379 redis:7-alpine
```

## Run Coordinator
```
# copy your .env.coordinator to the host first
cp .env.coordinator /opt/rakuten/.env.coordinator

# run
docker run -d --name rakuten-coordinator \
  --restart unless-stopped \
  --env-file /opt/rakuten/.env.coordinator \
  -p 9090:9090 \
  rakuten-coordinator
```

## Run POW Service (optional)
```
# copy .env.pow-service to host if used
cp .env.pow-service /opt/rakuten/.env.pow-service

docker run -d --name rakuten-pow-service \
  --restart unless-stopped \
  --env-file /opt/rakuten/.env.pow-service \
  -p 8080:8080 \
  rakuten-pow-service
```

## Run Worker(s)
Repeat on each worker host:
```
cp .env.worker /opt/rakuten/.env.worker

docker run -d --name rakuten-worker \
  --restart unless-stopped \
  --env-file /opt/rakuten/.env.worker \
  rakuten-worker
```

## Health Checks
- Coordinator metrics/health: `http://<coord_host>:9090/health` (503 during startup is expected; becomes 200 when ready).
- Redis connectivity: `redis-cli -u "$REDIS_URL" PING`.
- Logs: `docker logs -f rakuten-coordinator`, `docker logs -f rakuten-worker`, `docker logs -f rakuten-pow-service`.

## Common Operational Tasks
- Clear stuck progress keys (rare):
```
redis-cli -u "$REDIS_URL" KEYS "progress:*" | xargs -r redis-cli -u "$REDIS_URL" DEL
redis-cli -u "$REDIS_URL" DEL coordinator:heartbeat
redis-cli -u "$REDIS_URL" KEYS "coordinator:lock:*" | xargs -r redis-cli -u "$REDIS_URL" DEL
```
- Restart coordinator after env changes:
```
docker restart rakuten-coordinator
```

## Scaling Guidance
- Increase throughput by raising `WORKER_CONCURRENCY` and/or adding more worker containers/hosts.
- For high queue depth warnings, consider: `BATCH_CONCURRENCY=5`, `BATCH_DELAY_MS=10`, `BATCH_HUMAN_DELAY_MS=0`, and add additional workers.
- Monitor CPU/Memory on workers; scale up cautiously.

## Troubleshooting
- WRONGTYPE during crash recovery: clear `progress:*` keys and heartbeat/locks (see above), then restart coordinator.
- Coordinator refuses to start (another active coordinator): stop old coordinator containers, clear heartbeat/locks, restart.
- Slow POW: ensure POW service reachable and set `POW_SERVICE_URL` in workers.

