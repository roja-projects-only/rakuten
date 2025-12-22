# Quick Start Guide - Local Development

This guide helps you quickly set up the distributed Rakuten checker for local development and testing.

## Prerequisites

- Docker and Docker Compose installed
- Node.js 18+ (for local development)
- Redis (or use Docker Compose)
- Telegram Bot Token

## Local Development Setup

### 1. Clone and Setup

```bash
git clone https://github.com/your-org/rakuten-checker.git
cd rakuten-checker

# Copy environment template
cp .env.example .env

# Edit environment variables
nano .env
```

### 2. Configure Environment

Edit `.env` with your values:

```bash
# Required
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
TARGET_LOGIN_URL="https://login.account.rakuten.com/sso/authorize?client_id=rakuten_ichiba_top_web&service_id=s245&response_type=code&scope=openid&redirect_uri=https%3A%2F%2Fwww.rakuten.co.jp%2F"

# Optional
FORWARD_CHANNEL_ID=-1001234567890
ALLOWED_USER_IDS=123456789
```

### 3. Start with Docker Compose

```bash
# Build and start all services
docker-compose up --build

# Or start in background
docker-compose up -d --build

# View logs
docker-compose logs -f coordinator
docker-compose logs -f worker1
```

### 4. Verify Setup

```bash
# Check service health
curl http://localhost:8080/health  # POW Service
curl http://localhost:9090/health  # Coordinator metrics

# Check Redis
docker-compose exec redis redis-cli ping

# Test Telegram bot
# Send: .chk test@example.com:password
```

## Development Workflow

### Running Individual Components

```bash
# Start only Redis and POW service
docker-compose up -d redis pow-service

# Run coordinator locally
npm install
REDIS_URL=redis://localhost:6379 POW_SERVICE_URL=http://localhost:8080 npm start

# Run worker locally
WORKER_ID=dev-worker-1 REDIS_URL=redis://localhost:6379 POW_SERVICE_URL=http://localhost:8080 node worker.js
```

### Scaling Workers

```bash
# Scale to 5 workers
docker-compose up -d --scale worker1=5

# Or add specific workers
docker-compose up -d worker1 worker2 worker3
```

### Debugging

```bash
# View specific service logs
docker-compose logs -f coordinator
docker-compose logs -f pow-service
docker-compose logs -f worker1

# Connect to Redis CLI
docker-compose exec redis redis-cli

# Check queue status
docker-compose exec redis redis-cli LLEN queue:tasks

# Check active workers
docker-compose exec redis redis-cli KEYS "worker:*:heartbeat"
```

## Testing

### Unit Tests

```bash
# Run all tests
npm test

# Run specific test files
npm test -- shared/coordinator/JobQueueManager.test.js
npm test -- shared/worker/WorkerNode.test.js
```

### Integration Tests

```bash
# Start test environment
docker-compose -f docker-compose.test.yml up -d

# Run integration tests
npm run test:integration

# Cleanup
docker-compose -f docker-compose.test.yml down
```

### Load Testing

```bash
# Start full environment
docker-compose up -d

# Submit large batch via Telegram
# Upload file with 1000+ credentials

# Monitor performance
docker stats
curl http://localhost:9090/metrics
```

## Common Issues

### POW Service Build Fails

```bash
# If murmurhash-native fails to build
docker-compose build --no-cache pow-service

# Check build logs
docker-compose logs pow-service
```

### Workers Not Connecting

```bash
# Check Redis connectivity
docker-compose exec worker1 redis-cli -h redis ping

# Check environment variables
docker-compose exec worker1 env | grep REDIS_URL
```

### High Memory Usage

```bash
# Check Redis memory usage
docker-compose exec redis redis-cli INFO memory

# Restart services if needed
docker-compose restart
```

## Production Deployment

Once local development is working:

1. Follow [DEPLOYMENT.md](DEPLOYMENT.md) for AWS EC2 setup
2. Use the provided Dockerfiles and systemd services
3. Configure monitoring and logging
4. Set up auto-scaling based on queue depth

## Useful Commands

```bash
# View all containers
docker-compose ps

# Restart specific service
docker-compose restart coordinator

# Update and rebuild
git pull
docker-compose build
docker-compose up -d

# Clean up
docker-compose down
docker system prune -f

# Export logs
docker-compose logs coordinator > coordinator.log
docker-compose logs worker1 > worker1.log
```