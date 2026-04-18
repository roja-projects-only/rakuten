# AWS Setup Guide (Railway Redis)

Complete step-by-step guide for deploying the distributed Rakuten checker on AWS EC2 using the **AWS Web Console**. Redis is hosted on **Railway**.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Prerequisites](#prerequisites)
3. [Phase 1: Security Groups](#phase-1-security-groups)
4. [Phase 2: POW Service (c6i.large Spot)](#phase-2-pow-service)
5. [Phase 3: Coordinator (t3.small)](#phase-3-coordinator)
6. [Phase 4: Worker (t3.micro Spot)](#phase-4-worker)
7. [Phase 5: Verification](#phase-5-verification)
8. [Updating Code](#updating-code)
9. [Scaling](#scaling)
10. [Common Operations](#common-operations)
11. [Troubleshooting](#troubleshooting)
12. [Cost Summary](#cost-summary)

---

## Architecture

```
                        ┌──────────────────┐
                        │  Railway Redis   │
                        │  (external)      │
                        └────────┬─────────┘
                                 │ internet
        ┌────────────────────────┼────────────────────────┐
        │                  AWS VPC                         │
        │                        │                         │
        │  ┌─────────────┐  ┌───┴─────────┐  ┌─────────┐  │
        │  │ Coordinator │  │ POW Service │  │Worker(s)│  │
        │  │ (t3.small)  │  │(c6i.large)  │  │(t3.micro│  │
        │  │             │  │             │  │  spot)  │  │
        │  │• Telegram   │  │• cres solver│  │• HTTP   │  │
        │  │  Bot        │  │• HTTP :8080 │  │  checks │  │
        │  │• Job Queue  │  │• Cache      │  │• Result │  │
        │  │• Progress   │  │             │  │  pub    │  │
        │  └─────────────┘  └─────────────┘  └─────────┘  │
        └──────────────────────────────────────────────────┘
```

| Component | Instance Type | Spot? | Purpose |
|-----------|---------------|-------|---------|
| **POW Service** | c6i.large | Yes | CPU-intensive proof-of-work computation |
| **Coordinator** | t3.small | No | Telegram bot, job orchestration |
| **Worker(s)** | t3.micro | Yes | HTTP credential checking (I/O bound) |
| **Redis** | Railway (external) | — | Task queue, results, deduplication |

---

## Prerequisites

Gather these before you start:

| What | Where to get it |
|---|---|
| **Railway Redis URL** | Railway dashboard → your Redis service → **Connect** tab. Looks like `redis://default:PASSWORD@HOST.railway.app:PORT` |
| **Telegram Bot Token** | Telegram → message [@BotFather](https://t.me/BotFather) → `/newbot` or `/myBots` → API Token |
| **Your Telegram User ID** | Telegram → message [@userinfobot](https://t.me/userinfobot) → it replies with your numeric ID |
| **Forward Channel ID** (optional) | Add bot to channel as admin → forward a channel message to @userinfobot |
| **AWS Account** | With EC2 access |

---

## Phase 1: Security Groups

### Step 1: Navigate to Security Groups

1. Log in to **AWS Console**
2. Search **EC2** in the top bar → click **EC2**
3. Left sidebar → **Network & Security** → **Security Groups**
4. Click **Create security group** (orange button, top right)

### Step 2: Create `rakuten-pow-sg`

| Field | Value |
|---|---|
| **Security group name** | `rakuten-pow-sg` |
| **Description** | `POW service HTTP API` |
| **VPC** | Leave default (pre-selected) |

**Inbound rules** — click **Add rule**:

| Type | Port range | Source | Description |
|---|---|---|---|
| SSH | 22 | **My IP** | SSH access |

> We'll add the cross-reference rules after all SGs exist.

**Outbound rules** — leave default (All traffic 0.0.0.0/0).

Click **Create security group**. Copy the **Security Group ID** (e.g., `sg-0abc...`).

### Step 3: Create `rakuten-coordinator-sg`

Click **Create security group** again.

| Field | Value |
|---|---|
| **Security group name** | `rakuten-coordinator-sg` |
| **Description** | `Coordinator Telegram bot` |
| **VPC** | Leave default |

**Inbound rules** — click **Add rule** for each:

| # | Type | Port range | Source | Description |
|---|---|---|---|---|
| 1 | Custom TCP | `9090` | **My IP** | Metrics endpoint |
| 2 | SSH | `22` | **My IP** | SSH access |

Click **Create security group**.

### Step 4: Create `rakuten-worker-sg`

Click **Create security group** again.

| Field | Value |
|---|---|
| **Security group name** | `rakuten-worker-sg` |
| **Description** | `Worker instances` |
| **VPC** | Leave default |

**Inbound rules** — click **Add rule**:

| Type | Port range | Source | Description |
|---|---|---|---|
| SSH | 22 | **My IP** | SSH access |

Click **Create security group**.

### Step 5: Add cross-references to `rakuten-pow-sg`

Now all 3 SGs exist, go back and add the rules that reference them:

1. In the Security Groups list, **click on `rakuten-pow-sg`**
2. Click the **Inbound rules** tab (bottom panel)
3. Click **Edit inbound rules**
4. Click **Add rule**:
   - **Type**: Custom TCP
   - **Port range**: `8080`
   - **Source**: Click the search box → type `rakuten-coordinator-sg` → **select it** from dropdown
   - **Description**: `Coordinator access`
5. Click **Add rule** again:
   - **Type**: Custom TCP
   - **Port range**: `8080`
   - **Source**: Click the search box → type `rakuten-worker-sg` → **select it** from dropdown
   - **Description**: `Worker access`
6. Click **Save rules**

### Final Security Group State

**`rakuten-pow-sg`** (3 rules):
| Type | Port | Source |
|---|---|---|
| Custom TCP | 8080 | `rakuten-coordinator-sg` |
| Custom TCP | 8080 | `rakuten-worker-sg` |
| SSH | 22 | Your IP |

**`rakuten-coordinator-sg`** (2 rules):
| Type | Port | Source |
|---|---|---|
| Custom TCP | 9090 | Your IP |
| SSH | 22 | Your IP |

**`rakuten-worker-sg`** (1 rule):
| Type | Port | Source |
|---|---|---|
| SSH | 22 | Your IP |

---

## Phase 2: POW Service

### Launch Instance

1. Go to **EC2 → Instances → Launch instances**

| Setting | What to click/type |
|---|---|
| **Name** | `rakuten-pow-service` |
| **AMI** | Search `Ubuntu` → select **Ubuntu Server 24.04 LTS (HVM), SSD** → **64-bit (x86)** |
| **Instance type** | Type `c6i.large` in the dropdown → select it |
| **Key pair** | Select existing, or **Create new key pair** → name `rakuten-key` → RSA → .pem → Create (downloads automatically) |
| **Network settings** | Click **Edit** → **Select existing security group** → pick `rakuten-pow-sg` |

2. Expand **Advanced details** (bottom) → **Purchasing option** → check **Request Spot Instances**
3. Click **Launch instance**
4. Wait for **Running** in the instances list
5. **Write down the Private IPv4 address** — you'll need it for Coordinator and Worker configs

### Connect & Set Up

Click the instance → **Connect** (top right) → **EC2 Instance Connect** tab → **Connect**.

A browser terminal opens. Run commands **one block at a time**:

**Block 1 — Install Docker & Git:**
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io git
sudo systemctl enable docker && sudo systemctl start docker
sudo usermod -aG docker ubuntu
```

**Block 2 — Apply docker group (IMPORTANT):**
```bash
newgrp docker
```

**Block 3 — Clone repo & build Docker image:**
```bash
git clone https://github.com/roja-projects-only/rakuten.git
cd rakuten
docker build -f Dockerfile.pow-service -t rakuten-pow-service .
```
Takes ~2-3 minutes. Wait for `Successfully tagged rakuten-pow-service:latest`.

**Block 4 — Create env file:**
```bash
cat > .env.pow-service << 'EOF'
PORT=3001
LOG_LEVEL=info
REDIS_URL=PASTE_YOUR_RAILWAY_REDIS_URL_HERE
EOF
```

**Block 5 — Edit with your real Railway Redis URL:**
```bash
nano .env.pow-service
```
- Arrow key to `PASTE_YOUR_RAILWAY_REDIS_URL_HERE`, delete it, paste your Railway Redis URL
- Press **Ctrl+X** → **Y** → **Enter** to save

**Block 6 — Run the container:**
```bash
docker run -d \
  --name rakuten-pow-service \
  --restart unless-stopped \
  --env-file .env.pow-service \
  -p 8080:3001 \
  rakuten-pow-service
```
> `-p 8080:3001` maps host port 8080 → container port 3001

**Block 7 — Verify:**
```bash
curl http://localhost:8080/health
```
Expected: `{"status":"ok"}`

If it fails, check logs:
```bash
docker logs rakuten-pow-service
```

---

## Phase 3: Coordinator

### Launch Instance

1. Go to **EC2 → Instances → Launch instances**

| Setting | What to click/type |
|---|---|
| **Name** | `rakuten-coordinator` |
| **AMI** | **Ubuntu Server 24.04 LTS (HVM), SSD** → **64-bit (x86)** |
| **Instance type** | `t3.small` |
| **Key pair** | Same key pair (`rakuten-key`) |
| **Network settings** | **Edit** → **Select existing security group** → pick `rakuten-coordinator-sg` |

2. **Do NOT use Spot** for the coordinator — it needs to stay up
3. Click **Launch instance**
4. Wait for **Running**

### Connect & Set Up

Click instance → **Connect** → **EC2 Instance Connect** → **Connect**.

**Block 1 — Install Docker & Git:**
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io git
sudo systemctl enable docker && sudo systemctl start docker
sudo usermod -aG docker ubuntu
```

**Block 2 — Apply docker group:**
```bash
newgrp docker
```

**Block 3 — Clone & build:**
```bash
git clone https://github.com/roja-projects-only/rakuten.git
cd rakuten
docker build -f Dockerfile.coordinator -t rakuten-coordinator .
```
Wait for `Successfully tagged rakuten-coordinator:latest`.

**Block 4 — Create env file:**
```bash
cat > .env.coordinator << 'EOF'
TELEGRAM_BOT_TOKEN=PASTE_BOT_TOKEN
TARGET_LOGIN_URL=https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F
REDIS_URL=PASTE_YOUR_RAILWAY_REDIS_URL_HERE
COORDINATOR_MODE=true
POW_SERVICE_URL=http://PASTE_POW_PRIVATE_IP:8080
FORWARD_CHANNEL_ID=
ALLOWED_USER_IDS=
BATCH_CONCURRENCY=3
BATCH_DELAY_MS=10
BATCH_MAX_RETRIES=2
TIMEOUT_MS=60000
LOG_LEVEL=info
METRICS_PORT=9090
EOF
```

**Block 5 — Edit with real values:**
```bash
nano .env.coordinator
```

Replace these **3 required** placeholders:
| Placeholder | Replace with |
|---|---|
| `PASTE_BOT_TOKEN` | Your Telegram bot token from @BotFather |
| `PASTE_YOUR_RAILWAY_REDIS_URL_HERE` | Your Railway Redis URL |
| `PASTE_POW_PRIVATE_IP` | Private IPv4 of the POW instance (from Phase 2) |

Optional fields:
| Field | What to put |
|---|---|
| `FORWARD_CHANNEL_ID` | Channel ID to forward VALID results (e.g., `-1001234567890`) |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs (e.g., `123456789,987654321`) |

Press **Ctrl+X** → **Y** → **Enter** to save.

**Block 6 — Run the container:**
```bash
docker run -d \
  --name rakuten-coordinator \
  --restart unless-stopped \
  --env-file .env.coordinator \
  -p 9090:9090 \
  rakuten-coordinator
```

**Block 7 — Verify:**
```bash
docker logs -f rakuten-coordinator
```
You should see:
```
Bot started
Connected to Redis
Coordinator mode enabled
```
Press **Ctrl+C** to exit log view.

---

## Phase 4: Worker

### Launch Instance

1. Go to **EC2 → Instances → Launch instances**

| Setting | What to click/type |
|---|---|
| **Name** | `rakuten-worker-1` |
| **AMI** | **Ubuntu Server 24.04 LTS (HVM), SSD** → **64-bit (x86)** |
| **Instance type** | `t3.micro` |
| **Key pair** | Same key pair (`rakuten-key`) |
| **Network settings** | **Edit** → **Select existing security group** → pick `rakuten-worker-sg` |

2. Expand **Advanced details** → **Purchasing option** → check **Request Spot Instances**
3. Click **Launch instance**

### Connect & Set Up

Click instance → **Connect** → **EC2 Instance Connect** → **Connect**.

**Block 1 — Install Docker & Git:**
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io git
sudo systemctl enable docker && sudo systemctl start docker
sudo usermod -aG docker ubuntu
```

**Block 2 — Apply docker group:**
```bash
newgrp docker
```

**Block 3 — Clone & build:**
```bash
git clone https://github.com/roja-projects-only/rakuten.git
cd rakuten
docker build -f Dockerfile.worker -t rakuten-worker .
```
Wait for `Successfully tagged rakuten-worker:latest`.

**Block 4 — Create env file:**
```bash
cat > .env.worker << 'EOF'
REDIS_URL=PASTE_YOUR_RAILWAY_REDIS_URL_HERE
POW_SERVICE_URL=http://PASTE_POW_PRIVATE_IP:8080
TARGET_LOGIN_URL=https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F
WORKER_CONCURRENCY=3
TIMEOUT_MS=60000
BATCH_MAX_RETRIES=2
LOG_LEVEL=info
EOF
```

**Block 5 — Edit with real values:**
```bash
nano .env.worker
```

Replace:
| Placeholder | Replace with |
|---|---|
| `PASTE_YOUR_RAILWAY_REDIS_URL_HERE` | Your Railway Redis URL |
| `PASTE_POW_PRIVATE_IP` | Private IPv4 of the POW instance |

Press **Ctrl+X** → **Y** → **Enter** to save.

**Block 6 — Run the container:**
```bash
docker run -d \
  --name rakuten-worker \
  --restart unless-stopped \
  --env-file .env.worker \
  rakuten-worker
```

**Block 7 — Verify:**
```bash
docker logs -f rakuten-worker
```
Should show:
```
Worker registered
Waiting for tasks...
```
Press **Ctrl+C** to exit.

### Adding More Workers

Repeat this entire Phase 4 on new EC2 instances. Each worker auto-registers with the coordinator via Redis. Name them `rakuten-worker-2`, `rakuten-worker-3`, etc.

---

## Phase 5: Verification

### Test Each Component

**From POW instance:**
```bash
curl http://localhost:8080/health
# → {"status":"ok"}
```

**From Coordinator instance:**
```bash
# Check coordinator health
curl http://localhost:9090/health

# Check POW is reachable
curl http://POW_PRIVATE_IP:8080/health

# Check workers connected
docker logs rakuten-coordinator | grep -i "worker"
```

### End-to-End Test

1. Open **Telegram**
2. Send to your bot: `.chk test@example.com:testpassword`
3. You should get an **INVALID** response — that means the full pipeline works:
   **Telegram → Coordinator → Redis → Worker → POW → Worker → Redis → Coordinator → Telegram**
4. Upload a `.txt` file with a few credentials to test batch processing

---

## Updating Code

When you push new code to the repo:

### Update POW Service
```bash
cd ~/rakuten
git pull
docker build -f Dockerfile.pow-service -t rakuten-pow-service .
docker stop rakuten-pow-service
docker rm rakuten-pow-service
docker run -d \
  --name rakuten-pow-service \
  --restart unless-stopped \
  --env-file .env.pow-service \
  -p 8080:3001 \
  rakuten-pow-service
```

### Update Coordinator
```bash
cd ~/rakuten
git pull
docker build -f Dockerfile.coordinator -t rakuten-coordinator .
docker stop rakuten-coordinator
docker rm rakuten-coordinator
docker run -d \
  --name rakuten-coordinator \
  --restart unless-stopped \
  --env-file .env.coordinator \
  -p 9090:9090 \
  rakuten-coordinator
```

### Update Worker
```bash
cd ~/rakuten
git pull
docker build -f Dockerfile.worker -t rakuten-worker .
docker stop rakuten-worker
docker rm rakuten-worker
docker run -d \
  --name rakuten-worker \
  --restart unless-stopped \
  --env-file .env.worker \
  rakuten-worker
```

---

## Scaling

### Scale Up

| Action | How |
|---|---|
| **Add workers** | Launch new t3.micro instances → repeat Phase 4 |
| **Increase worker concurrency** | Edit `WORKER_CONCURRENCY` in `.env.worker` → `docker restart rakuten-worker` |
| **More POW capacity** | Launch second POW instance → update `POW_SERVICE_URL` to comma-separated list |

### Scale Down

| Action | How |
|---|---|
| **Remove workers** | Just **terminate** the EC2 instance — workers de-register automatically |
| **Lower concurrency** | Edit `WORKER_CONCURRENCY` → restart |

---

## Common Operations

### View Logs
```bash
# Live follow
docker logs -f rakuten-coordinator
docker logs -f rakuten-worker
docker logs -f rakuten-pow-service

# Last 100 lines
docker logs --tail 100 rakuten-coordinator
```

### Restart a Service
```bash
docker restart rakuten-coordinator
docker restart rakuten-worker
docker restart rakuten-pow-service
```

### Edit Environment Variables
```bash
nano .env.coordinator    # or .env.worker / .env.pow-service
docker restart rakuten-coordinator   # restart for changes to take effect
```

### Check Container Status
```bash
docker ps                    # running containers
docker ps -a                 # all containers (including stopped)
docker stats                 # live CPU/memory usage
```

### Install redis-cli (on any instance, for debugging)
```bash
sudo apt install -y redis-tools
# Then use your Railway Redis URL:
redis-cli -u "redis://default:PASSWORD@HOST.railway.app:PORT"
```

### Check Queue & Workers via Redis
```bash
redis-cli -u "RAILWAY_REDIS_URL" KEYS "worker:*:heartbeat"   # connected workers
redis-cli -u "RAILWAY_REDIS_URL" LLEN queue:tasks             # queued tasks
redis-cli -u "RAILWAY_REDIS_URL" KEYS "progress:*"            # active batches
```

---

## Troubleshooting

### Bot Not Responding

1. Check coordinator logs:
   ```bash
   docker logs --tail 50 rakuten-coordinator
   ```
2. Verify `TELEGRAM_BOT_TOKEN` is correct in `.env.coordinator`
3. Verify Redis connection — look for `Connected to Redis` in logs
4. Make sure another bot instance isn't running elsewhere (only one can poll at a time)

### Workers Not Connecting

1. Check worker logs:
   ```bash
   docker logs --tail 50 rakuten-worker
   ```
2. Verify `REDIS_URL` in `.env.worker` matches your Railway Redis URL
3. Test Redis from the worker instance:
   ```bash
   sudo apt install -y redis-tools
   redis-cli -u "RAILWAY_REDIS_URL" PING
   # → PONG
   ```

### POW Service Not Reachable from Workers

1. From a worker instance, test:
   ```bash
   curl http://POW_PRIVATE_IP:8080/health
   ```
2. If it times out: check that `rakuten-pow-sg` has an inbound rule for port 8080 from `rakuten-worker-sg`
3. Make sure both instances are in the **same VPC**

### Coordinator Won't Start (Lock Error)

Another coordinator instance may have left a stale lock in Redis:
```bash
redis-cli -u "RAILWAY_REDIS_URL" DEL coordinator:heartbeat
docker restart rakuten-coordinator
```

### "WRONGTYPE" Redis Error

Stale progress keys from a crashed batch:
```bash
redis-cli -u "RAILWAY_REDIS_URL"
> KEYS "progress:*"
> DEL progress:BATCH_ID_HERE
> exit

docker restart rakuten-coordinator
```

### Batch Stuck / No Final Summary

```bash
redis-cli -u "RAILWAY_REDIS_URL"
> KEYS "progress:*"
# Delete all shown keys:
> DEL progress:xxx
> KEYS "coordinator:lock:*"
# Delete any locks shown:
> DEL coordinator:lock:xxx
> exit

docker restart rakuten-coordinator
```

### Spot Instance Terminated by AWS

Spot instances can be reclaimed. If it happens:
1. Launch a new instance (same Phase steps)
2. Workers auto-deregister from Redis after heartbeat timeout
3. POW service: update `POW_SERVICE_URL` in coordinator/worker `.env` files if the new IP changed, then restart them

---

## Environment Variable Reference

### Coordinator

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token from @BotFather |
| `TARGET_LOGIN_URL` | **Yes** | — | Rakuten OAuth URL |
| `REDIS_URL` | **Yes** | — | Railway Redis URL |
| `COORDINATOR_MODE` | **Yes** | `false` | Must be `true` for distributed mode |
| `POW_SERVICE_URL` | Recommended | — | POW service endpoint |
| `FORWARD_CHANNEL_ID` | No | — | Channel ID to forward VALID results |
| `ALLOWED_USER_IDS` | No | — | Comma-separated allowed user IDs |
| `BATCH_CONCURRENCY` | No | `1` | Parallel batch workers |
| `BATCH_DELAY_MS` | No | `50` | Delay between task chunks (ms) |
| `BATCH_MAX_RETRIES` | No | `2` | Retry count for ERROR results |
| `TIMEOUT_MS` | No | `60000` | HTTP request timeout (ms) |
| `LOG_LEVEL` | No | `info` | debug / info / warn / error |
| `METRICS_PORT` | No | `9090` | Prometheus metrics port |

### Worker

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | **Yes** | — | Railway Redis URL |
| `POW_SERVICE_URL` | Recommended | — | POW service endpoint |
| `TARGET_LOGIN_URL` | Recommended | — | Override login URL |
| `WORKER_CONCURRENCY` | No | `3` | Concurrent tasks (1-50) |
| `TIMEOUT_MS` | No | `60000` | HTTP request timeout (ms) |
| `BATCH_MAX_RETRIES` | No | `2` | Retry count |
| `LOG_LEVEL` | No | `info` | Log level |

### POW Service

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | Internal HTTP port |
| `REDIS_URL` | No | — | Cache computed results (recommended) |
| `LOG_LEVEL` | No | `info` | Log level |

---

## Cost Summary

| Setup | Components | Monthly Cost |
|---|---|---|
| **Minimal** | Coordinator + 1 Worker | ~$17/mo |
| **Recommended** | Coordinator + POW (spot) + 1 Worker (spot) | ~$47/mo |
| **Medium** | Coordinator + POW (spot) + 3 Workers (spot) | ~$51/mo |
| **Large** | Coordinator + POW (spot) + 5 Workers (spot) | ~$55/mo |

> Redis cost is separate (Railway plan). Spot instances save 60-90% over on-demand.
