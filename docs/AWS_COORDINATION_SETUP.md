# AWS Coordination Mode - Full Setup Guide

Complete guide for deploying the Rakuten Credential Checker in distributed mode across AWS EC2 instances using the **AWS Web Console** only.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [AWS Console Setup](#aws-console-setup)
4. [Redis Instance Setup](#redis-instance-setup)
5. [POW Service Setup](#pow-service-setup)
6. [Coordinator Setup](#coordinator-setup)
7. [Worker Setup](#worker-setup)
8. [Verification](#verification)
9. [Operations & Maintenance](#operations--maintenance)
10. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AWS VPC                                        │
│                                                                             │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐          │
│  │   Coordinator   │    │   POW Service   │    │     Redis       │          │
│  │   (t3.small)    │    │  (c6i.large)    │    │   (t3.micro)    │          │
│  │                 │    │                 │    │                 │          │
│  │ • Telegram Bot  │    │ • cres solver   │    │ • Task Queue    │          │
│  │ • Job Queue     │    │ • HTTP API      │    │ • Results       │          │
│  │ • Progress UI   │    │ • Cache         │    │ • Dedupe        │          │
│  └────────┬────────┘    └────────┬────────┘    └────────┬────────┘          │
│           │                      │                      │                   │
│           └──────────────────────┴──────────────────────┘                   │
│                                  │                                          │
│           ┌──────────────────────┼──────────────────────┐                   │
│           │                      │                      │                   │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐          │
│  │    Worker 1     │    │    Worker 2     │    │    Worker N     │          │
│  │  (t3.micro)     │    │  (t3.micro)     │    │  (t3.micro)     │          │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component Summary

| Component | Instance Type | Purpose | Est. Cost |
|-----------|---------------|---------|-----------|
| **Redis** | t3.micro | Task queue, results store, deduplication | ~$8/mo |
| **POW Service** | c6i.large (spot) | CPU-intensive cres computation | ~$30/mo |
| **Coordinator** | t3.small | Telegram bot, job orchestration | ~$15/mo |
| **Workers** | t3.micro (spot) | HTTP credential checking | ~$2/mo each |

---

## Prerequisites

Before starting, gather these:

- [ ] **Telegram Bot Token** - Get from [@BotFather](https://t.me/BotFather)
- [ ] **Target Login URL** - The Rakuten OAuth endpoint
- [ ] **AWS Account** - With EC2 access
- [ ] **SSH Key Pair** - Create in AWS Console if you don't have one

---

## AWS Console Setup

### Create Security Groups

Go to **EC2 → Security Groups → Create security group**

#### 1. Redis Security Group

| Field | Value |
|-------|-------|
| Name | `rakuten-redis-sg` |
| Description | Redis access for rakuten checker |
| VPC | Your default VPC |

**Inbound Rules:**

| Type | Port | Source | Description |
|------|------|--------|-------------|
| Custom TCP | 6379 | `rakuten-coordinator-sg` | Coordinator access |
| Custom TCP | 6379 | `rakuten-worker-sg` | Worker access |
| Custom TCP | 6379 | `rakuten-pow-sg` | POW service access |
| SSH | 22 | Your IP | SSH access |

#### 2. POW Service Security Group

| Field | Value |
|-------|-------|
| Name | `rakuten-pow-sg` |
| Description | POW service HTTP API |

**Inbound Rules:**

| Type | Port | Source | Description |
|------|------|--------|-------------|
| Custom TCP | 8080 | `rakuten-coordinator-sg` | Coordinator access |
| Custom TCP | 8080 | `rakuten-worker-sg` | Worker access |
| SSH | 22 | Your IP | SSH access |

#### 3. Coordinator Security Group

| Field | Value |
|-------|-------|
| Name | `rakuten-coordinator-sg` |
| Description | Coordinator/Telegram bot |

**Inbound Rules:**

| Type | Port | Source | Description |
|------|------|--------|-------------|
| Custom TCP | 9090 | Your IP | Metrics endpoint |
| SSH | 22 | Your IP | SSH access |

#### 4. Worker Security Group

| Field | Value |
|-------|-------|
| Name | `rakuten-worker-sg` |
| Description | Worker instances |

**Inbound Rules:**

| Type | Port | Source | Description |
|------|------|--------|-------------|
| SSH | 22 | Your IP | SSH access |

---

## Redis Instance Setup

### Launch EC2 Instance (AWS Console)

1. Go to **EC2 → Instances → Launch instances**
2. Configure:

| Setting | Value |
|---------|-------|
| Name | `rakuten-redis` |
| AMI | Amazon Linux 2023 |
| Instance type | `t3.micro` |
| Key pair | Your SSH key |
| Security group | `rakuten-redis-sg` |

3. Click **Launch instance**
4. Note the **Private IP** (e.g., `172.31.x.x`)

### SSH Commands for Redis

Connect via SSH, then run these commands:

```bash
# Update system
sudo dnf update -y

# Install Redis
sudo dnf install -y redis6

# Configure Redis for remote access
sudo sed -i 's/bind 127.0.0.1/bind 0.0.0.0/' /etc/redis6/redis6.conf

# Set Redis password (replace YOUR_PASSWORD)
sudo sed -i 's/# requirepass foobared/requirepass YOUR_PASSWORD/' /etc/redis6/redis6.conf

# Enable and start Redis
sudo systemctl enable redis6
sudo systemctl start redis6

# Verify Redis is running
redis6-cli -a YOUR_PASSWORD PING
# Should return: PONG
```

**Save your Redis URL:**
```
redis://:YOUR_PASSWORD@REDIS_PRIVATE_IP:6379
```

Example: `redis://:mypassword123@172.31.10.50:6379`

---

## POW Service Setup

### Launch EC2 Instance (AWS Console)

1. Go to **EC2 → Instances → Launch instances**
2. Configure:

| Setting | Value |
|---------|-------|
| Name | `rakuten-pow-service` |
| AMI | Amazon Linux 2023 |
| Instance type | `c6i.large` (or request Spot) |
| Key pair | Your SSH key |
| Security group | `rakuten-pow-sg` |

3. Click **Launch instance**
4. Note the **Private IP**

### SSH Commands for POW Service

Connect via SSH, then run these commands:

```bash
# Update and install Docker
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ec2-user

# Re-login for docker group to take effect
exit
```

SSH back in, then:

```bash
# Clone repository
git clone https://github.com/roja-projects-only/rakuten.git
cd rakuten

# Build POW service image
docker build -f Dockerfile.pow-service -t rakuten-pow-service .

# Create environment file
sudo mkdir -p /opt/rakuten
sudo tee /opt/rakuten/.env.pow-service << 'EOF'
PORT=8080
LOG_LEVEL=info
NODE_ENV=production
EOF

# Run POW service
docker run -d \
  --name rakuten-pow-service \
  --restart unless-stopped \
  --env-file /opt/rakuten/.env.pow-service \
  -p 8080:8080 \
  rakuten-pow-service

# Verify it's running
curl http://localhost:8080/health
# Should return: {"status":"ok"}
```

**Save your POW Service URL:**
```
http://POW_PRIVATE_IP:8080
```

Example: `http://172.31.20.100:8080`

### POW Service Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8080` | HTTP server port |
| `LOG_LEVEL` | No | `info` | Logging level |
| `REDIS_URL` | No | — | Optional: cache computed results |

### POW Service Commands Reference

```bash
# View logs
docker logs -f rakuten-pow-service

# Restart service
docker restart rakuten-pow-service

# Stop service
docker stop rakuten-pow-service

# Update to new version
cd ~/rakuten
git pull
docker build -f Dockerfile.pow-service -t rakuten-pow-service .
docker stop rakuten-pow-service
docker rm rakuten-pow-service
docker run -d \
  --name rakuten-pow-service \
  --restart unless-stopped \
  --env-file /opt/rakuten/.env.pow-service \
  -p 8080:8080 \
  rakuten-pow-service
```

---

## Coordinator Setup

### Launch EC2 Instance (AWS Console)

1. Go to **EC2 → Instances → Launch instances**
2. Configure:

| Setting | Value |
|---------|-------|
| Name | `rakuten-coordinator` |
| AMI | Amazon Linux 2023 |
| Instance type | `t3.small` |
| Key pair | Your SSH key |
| Security group | `rakuten-coordinator-sg` |

3. Click **Launch instance**

### SSH Commands for Coordinator

Connect via SSH, then run these commands:

```bash
# Update and install Docker
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ec2-user

# Re-login for docker group
exit
```

SSH back in, then:

```bash
# Clone repository
git clone https://github.com/roja-projects-only/rakuten.git
cd rakuten

# Build coordinator image
docker build -f Dockerfile.coordinator -t rakuten-coordinator .

# Create environment file (EDIT VALUES BELOW)
sudo mkdir -p /opt/rakuten
sudo nano /opt/rakuten/.env.coordinator
```

Paste this content (edit the values):

```bash
# ===================
# REQUIRED - Must Set
# ===================
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TARGET_LOGIN_URL=https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F
REDIS_URL=redis://:YOUR_PASSWORD@REDIS_PRIVATE_IP:6379

# ===================
# OPTIONAL
# ===================
FORWARD_CHANNEL_ID=-1001234567890
ALLOWED_USER_IDS=123456789,987654321
PROXY_SERVER=

# ===================
# PERFORMANCE TUNING
# ===================
BATCH_CONCURRENCY=3
BATCH_DELAY_MS=10
BATCH_HUMAN_DELAY_MS=0
BATCH_MAX_RETRIES=2
TIMEOUT_MS=60000

# ===================
# MONITORING
# ===================
LOG_LEVEL=info
METRICS_PORT=9090
```

Save and exit (`Ctrl+X`, `Y`, `Enter`), then run:

```bash
# Run coordinator
docker run -d \
  --name rakuten-coordinator \
  --restart unless-stopped \
  --env-file /opt/rakuten/.env.coordinator \
  -p 9090:9090 \
  rakuten-coordinator

# Verify it's running
docker logs -f rakuten-coordinator
# Should show: "Bot started", "Connected to Redis"
# Press Ctrl+C to exit logs
```

### Coordinator Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token from @BotFather |
| `TARGET_LOGIN_URL` | **Yes** | — | Rakuten OAuth URL |
| `REDIS_URL` | **Yes** | — | Redis connection URL |
| `FORWARD_CHANNEL_ID` | No | — | Channel ID to forward VALID results |
| `ALLOWED_USER_IDS` | No | — | Comma-separated allowed Telegram user IDs |
| `PROXY_SERVER` | No | — | Default proxy for requests |
| `BATCH_CONCURRENCY` | No | `1` | Parallel batch workers |
| `BATCH_DELAY_MS` | No | `50` | Delay between task chunks (ms) |
| `BATCH_HUMAN_DELAY_MS` | No | `0` | Human delay multiplier (0=disabled) |
| `BATCH_MAX_RETRIES` | No | `2` | Retry count for ERROR results |
| `TIMEOUT_MS` | No | `60000` | HTTP request timeout (ms) |
| `LOG_LEVEL` | No | `info` | Log level: debug/info/warn/error |
| `METRICS_PORT` | No | `9090` | Prometheus metrics port |

### Coordinator Commands Reference

```bash
# View logs
docker logs -f rakuten-coordinator

# View last 100 lines
docker logs --tail 100 rakuten-coordinator

# Restart coordinator
docker restart rakuten-coordinator

# Stop coordinator
docker stop rakuten-coordinator

# Edit environment and restart
sudo nano /opt/rakuten/.env.coordinator
docker restart rakuten-coordinator

# Update to new version
cd ~/rakuten
git pull
docker build -f Dockerfile.coordinator -t rakuten-coordinator .
docker stop rakuten-coordinator
docker rm rakuten-coordinator
docker run -d \
  --name rakuten-coordinator \
  --restart unless-stopped \
  --env-file /opt/rakuten/.env.coordinator \
  -p 9090:9090 \
  rakuten-coordinator
```

---

## Worker Setup

### Launch EC2 Instance(s) (AWS Console)

1. Go to **EC2 → Instances → Launch instances**
2. Configure:

| Setting | Value |
|---------|-------|
| Name | `rakuten-worker-1` |
| AMI | Amazon Linux 2023 |
| Instance type | `t3.micro` |
| Key pair | Your SSH key |
| Security group | `rakuten-worker-sg` |
| Number of instances | 1 (or more) |

3. For **Spot instances** (cheaper): Click **Advanced details** → **Purchasing option** → Select **Spot instances**
4. Click **Launch instance**

### SSH Commands for Worker

Connect via SSH, then run these commands:

```bash
# Update and install Docker
sudo dnf update -y
sudo dnf install -y docker git
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ec2-user

# Re-login for docker group
exit
```

SSH back in, then:

```bash
# Clone repository
git clone https://github.com/roja-projects-only/rakuten.git
cd rakuten

# Build worker image
docker build -f Dockerfile.worker -t rakuten-worker .

# Create environment file (EDIT VALUES BELOW)
sudo mkdir -p /opt/rakuten
sudo nano /opt/rakuten/.env.worker
```

Paste this content (edit the values):

```bash
# ===================
# REQUIRED
# ===================
REDIS_URL=redis://:YOUR_PASSWORD@REDIS_PRIVATE_IP:6379

# ===================
# RECOMMENDED
# ===================
POW_SERVICE_URL=http://POW_PRIVATE_IP:8080
TARGET_LOGIN_URL=https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F

# ===================
# PERFORMANCE
# ===================
WORKER_CONCURRENCY=3
TIMEOUT_MS=60000
BATCH_MAX_RETRIES=2

# ===================
# MONITORING
# ===================
LOG_LEVEL=info
```

Save and exit, then run:

```bash
# Run worker
docker run -d \
  --name rakuten-worker \
  --restart unless-stopped \
  --env-file /opt/rakuten/.env.worker \
  rakuten-worker

# Verify it's running
docker logs -f rakuten-worker
# Should show: "Worker registered", "Waiting for tasks..."
# Press Ctrl+C to exit logs
```

### Worker Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_URL` | **Yes** | — | Redis connection URL |
| `POW_SERVICE_URL` | No | — | POW service endpoint (recommended) |
| `TARGET_LOGIN_URL` | No | — | Override login URL |
| `WORKER_CONCURRENCY` | No | `3` | Concurrent tasks per worker (1-50) |
| `TIMEOUT_MS` | No | `60000` | HTTP request timeout (ms) |
| `BATCH_MAX_RETRIES` | No | `2` | Retry count for ERROR results |
| `LOG_LEVEL` | No | `info` | Log level |

### Worker Commands Reference

```bash
# View logs
docker logs -f rakuten-worker

# Restart worker
docker restart rakuten-worker

# Stop worker
docker stop rakuten-worker

# Change concurrency
sudo nano /opt/rakuten/.env.worker
# Change WORKER_CONCURRENCY=5
docker restart rakuten-worker

# Update to new version
cd ~/rakuten
git pull
docker build -f Dockerfile.worker -t rakuten-worker .
docker stop rakuten-worker
docker rm rakuten-worker
docker run -d \
  --name rakuten-worker \
  --restart unless-stopped \
  --env-file /opt/rakuten/.env.worker \
  rakuten-worker
```

### Adding More Workers

Repeat the Worker Setup on new EC2 instances. Each worker automatically registers with the coordinator via Redis.

---

## Verification

### Test Each Component

#### 1. Test Redis (from any instance)

```bash
# Install redis-cli if not present
sudo dnf install -y redis6

# Test connection
redis6-cli -h REDIS_PRIVATE_IP -a YOUR_PASSWORD PING
# Should return: PONG
```

#### 2. Test POW Service

```bash
curl http://POW_PRIVATE_IP:8080/health
# Should return: {"status":"ok"}
```

#### 3. Test Coordinator

```bash
curl http://COORDINATOR_PRIVATE_IP:9090/health
# Should return 200 OK
```

#### 4. Check Workers Connected

On coordinator instance:

```bash
docker logs rakuten-coordinator | grep -i "worker"
# Should show workers registering
```

Or via Redis:

```bash
redis6-cli -h REDIS_PRIVATE_IP -a YOUR_PASSWORD KEYS "worker:*:heartbeat"
# Should list all connected workers
```

### End-to-End Test

1. Open Telegram
2. Send to your bot: `.chk test@example.com:testpassword`
3. Should receive response (INVALID expected for test credentials)
4. Upload a `.txt` file with credentials to test batch processing

---

## Operations & Maintenance

### Quick Status Check

```bash
# On any instance with redis-cli installed:

# Check worker count
redis6-cli -h REDIS_IP -a PASS KEYS "worker:*:heartbeat" | wc -l

# Check queue depth
redis6-cli -h REDIS_IP -a PASS LLEN queue:tasks

# Check active batches
redis6-cli -h REDIS_IP -a PASS KEYS "progress:*"
```

### Clear Stuck State

If system gets stuck after a crash:

```bash
# Connect to Redis
redis6-cli -h REDIS_IP -a YOUR_PASSWORD

# Inside redis-cli:
KEYS "progress:*"
DEL progress:BATCH_ID_HERE

DEL coordinator:heartbeat
KEYS "coordinator:lock:*"
# Delete any locks shown

# Exit redis-cli
exit

# Restart coordinator
# SSH to coordinator instance:
docker restart rakuten-coordinator
```

### Scaling Up

1. **Add workers**: Launch more EC2 instances, run worker setup
2. **Increase concurrency**: Edit `WORKER_CONCURRENCY` in `.env.worker`, restart
3. **Add POW capacity**: Launch second POW instance, update `POW_SERVICE_URL` to comma-separated list

### Scaling Down

1. **Remove workers**: Just terminate EC2 instances (workers de-register automatically)
2. **Reduce concurrency**: Edit `WORKER_CONCURRENCY`, restart

---

## Troubleshooting

### Problem: Workers Not Connecting

**Check:**
1. Security group allows Redis port 6379 from worker SG
2. Redis is running: `redis6-cli -h REDIS_IP -a PASS PING`
3. Worker logs: `docker logs rakuten-worker`

### Problem: Slow Processing

**Solutions:**
1. Verify POW service is reachable
2. Increase `WORKER_CONCURRENCY`
3. Add more worker instances

### Problem: Bot Not Responding

**Check:**
1. Coordinator logs: `docker logs rakuten-coordinator`
2. Verify `TELEGRAM_BOT_TOKEN` is correct
3. Verify Redis connection

### Problem: Coordinator Won't Start (Lock Error)

**Solution:**
```bash
# Clear old lock
redis6-cli -h REDIS_IP -a PASS DEL coordinator:heartbeat
docker restart rakuten-coordinator
```

### Problem: "WRONGTYPE" Redis Error

**Solution:**
```bash
# Clear progress keys
redis6-cli -h REDIS_IP -a PASS
KEYS "progress:*"
# Delete each one:
DEL progress:xxx
exit

docker restart rakuten-coordinator
```

---

## Cost Summary

| Setup | Components | Monthly Cost |
|-------|------------|--------------|
| **Minimal** | Redis + Coordinator + 1 Worker | ~$25 |
| **Small** | Redis + POW + Coordinator + 3 Workers | ~$60 |
| **Medium** | Redis + POW + Coordinator + 5 Workers | ~$70 |
| **Large** | Redis + POW + Coordinator + 10 Workers | ~$90 |

Use **Spot instances** for Workers and POW Service to save 60-90%.
