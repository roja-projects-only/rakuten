# Shared Infrastructure for Distributed Worker Architecture

This directory contains shared utilities for the distributed worker architecture, including Redis client management, key schema definitions, structured logging, and environment configuration.

## Components

### Redis Client (`redis/client.js`)

Robust Redis client wrapper with:
- Connection pooling for high throughput
- Exponential backoff retry logic (1s, 2s, 4s, 8s, 16s max)
- Automatic reconnection on connection loss
- Health monitoring and metrics
- Graceful shutdown handling

**Usage:**

```javascript
const { getRedisClient, initRedisClient } = require('./shared');

// Initialize Redis connection
const redisClient = await initRedisClient();

// Execute commands with automatic retry
await redisClient.executeCommand('set', 'key', 'value');
const value = await redisClient.executeCommand('get', 'key');

// Check health
const isHealthy = await redisClient.isHealthy();

// Get metrics
const metrics = redisClient.getMetrics();

// Close connection
await redisClient.close();
```

### Redis Keys (`redis/keys.js`)

Centralized Redis key schema based on design document Appendix B:

**Key Patterns:**
- `job:{batchId}:{taskId}` - Task lease tracking (5 min TTL)
- `result:{status}:{email}:{password}` - Result cache (30 day TTL)
- `progress:{batchId}` - Batch progress tracking (7 day TTL)
- `proxy:{proxyId}:health` - Proxy health state (5 min TTL)
- `msg:{trackingCode}` - Message tracking (30 day TTL)
- `coordinator:heartbeat` - Coordinator HA (30 sec TTL)
- `worker:{workerId}:heartbeat` - Worker liveness (30 sec TTL)
- `forward:pending:{trackingCode}` - Two-phase commit (2 min TTL)
- `pow:{mask}:{key}:{seed}` - POW cache (5 min TTL)

**Queue Keys:**
- `queue:tasks` - Main task queue (LIST)
- `queue:retry` - Retry queue (LIST)

**Pub/Sub Channels:**
- `forward_events` - VALID credential forwarding
- `update_events` - Status change notifications
- `worker_heartbeats` - Worker health signals

**Usage:**

```javascript
const { REDIS_KEYS, generateBatchId, generateTaskId } = require('./shared');

// Generate IDs
const batchId = generateBatchId();
const taskId = generateTaskId(batchId, 1);

// Generate keys
const leaseKey = REDIS_KEYS.TASK_LEASE.generate(batchId, taskId);
const resultKey = REDIS_KEYS.RESULT_CACHE.generate('VALID', 'user@example.com', 'pass');
const progressKey = REDIS_KEYS.PROGRESS_TRACKER.generate(batchId);

// Get TTL
const ttl = REDIS_KEYS.TASK_LEASE.ttl; // 300 seconds

// Queue operations
await redis.rpush(REDIS_KEYS.JOB_QUEUE.tasks, JSON.stringify(task));
const task = await redis.blpop(REDIS_KEYS.JOB_QUEUE.tasks, 30);

// Pub/Sub
await redis.publish(REDIS_KEYS.PUBSUB_CHANNELS.forwardEvents, JSON.stringify(event));
```

### Structured Logger (`logger/structured.js`)

Enhanced logger with JSON formatting for distributed systems:

**Features:**
- Structured JSON output for log aggregation
- Task completion logging with metrics
- Error tracking with context
- Distributed tracing support
- Performance metrics logging
- Automatic PII masking

**Usage:**

```javascript
const { createStructuredLogger } = require('./shared');

const log = createStructuredLogger('worker');

// Standard logging
log.info('Processing task', { taskId: 'task-123', batchId: 'batch-456' });
log.error('Task failed', { error: error.message, taskId: 'task-123' });

// Specialized logging
log.logTaskCompletion({
  taskId: 'task-123',
  batchId: 'batch-456',
  username: 'user@example.com',
  status: 'VALID',
  duration: 3456,
  proxyId: 'p001',
  workerId: 'w001'
});

log.logWorkerHeartbeat({
  workerId: 'w001',
  tasksCompleted: 42,
  uptime: 3600000,
  memoryUsage: process.memoryUsage()
});

log.logProxyHealth({
  proxyId: 'p001',
  healthy: true,
  successRate: 0.95,
  consecutiveFailures: 0
});

// Create child logger
const taskLog = log.child('task-processor');
```

**JSON Output Format:**

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "level": "INFO",
  "scope": "worker",
  "message": "Task completed",
  "event": "task_completion",
  "taskId": "task-123",
  "batchId": "batch-456",
  "status": "VALID",
  "duration": 3456,
  "proxyId": "p001",
  "workerId": "w001",
  "process": {
    "pid": 12345,
    "hostname": "worker-1",
    "nodeVersion": "v18.0.0"
  }
}
```

### Environment Configuration (`config/environment.js`)

Environment variable validation and configuration management:

**Supported Variables:**

**Redis:**
- `REDIS_URL` - Redis connection URL (required for distributed mode)
- `REDIS_HOST` - Redis host (alternative to REDIS_URL)
- `REDIS_PORT` - Redis port (default: 6379)
- `REDIS_PASSWORD` - Redis password
- `REDIS_DB` - Redis database number (default: 0)

**Worker:**
- `WORKER_ID` - Unique worker identifier (auto-generated)
- `WORKER_CONCURRENCY` - Concurrent tasks per worker (default: 5)

**POW Service:**
- `POW_SERVICE_URL` - POW service HTTP endpoint
- `POW_SERVICE_TIMEOUT` - Request timeout in ms (default: 5000)

**Coordinator:**
- `COORDINATOR_MODE` - Enable coordinator mode (default: false)
- `BACKUP_COORDINATOR` - Enable backup coordinator (default: false)

**Batch Processing:**
- `BATCH_MAX_RETRIES` - Max retry attempts (default: 2)
- `BATCH_TIMEOUT_MS` - Task timeout in ms (default: 120000)

**Proxy:**
- `PROXY_POOL` - Comma-separated proxy URLs
- `PROXY_HEALTH_CHECK_INTERVAL` - Health check interval in ms (default: 30000)

**Monitoring:**
- `METRICS_PORT` - Prometheus metrics port (default: 9090)
- `HEALTH_CHECK_PORT` - Health check port (default: 8080)

**Logging:**
- `LOG_LEVEL` - Logging level (default: info)
- `JSON_LOGGING` - Enable JSON logging (default: false)

**Usage:**

```javascript
const { validateEnvironment, getConfig, isDistributedMode } = require('./shared');

// Validate environment for specific mode
const { config, mode, warnings } = validateEnvironment('worker');

// Get configuration
const config = getConfig('worker');

// Check deployment mode
if (isDistributedMode()) {
  console.log('Running in distributed mode');
} else {
  console.log('Running in single-node mode');
}

// Access configuration
console.log('Redis URL:', config.REDIS_URL);
console.log('Worker concurrency:', config.WORKER_CONCURRENCY);
console.log('Max retries:', config.BATCH_MAX_RETRIES);
```

## Deployment Modes

The infrastructure supports multiple deployment modes:

### Single-Node Mode (Existing)
- No Redis required
- In-memory job queue
- JSONL result storage
- Single process handles everything

### Distributed Worker Mode
- Requires: `REDIS_URL`
- Worker pulls tasks from Redis queue
- Stores results in Redis
- Communicates via pub/sub

### Coordinator Mode
- Requires: `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `TARGET_LOGIN_URL`
- Runs Telegram bot
- Manages job queue
- Tracks progress
- Forwards to channel

### POW Service Mode
- Requires: `REDIS_URL`
- Dedicated POW computation service
- HTTP API for workers
- Redis caching

### Backup Coordinator Mode
- Requires: `REDIS_URL`, `TELEGRAM_BOT_TOKEN`, `BACKUP_COORDINATOR=true`
- Monitors primary coordinator
- Takes over on failover
- Resumes in-progress batches

## Testing

Run the test script to verify setup:

```bash
# Without Redis (tests key generation and validation)
node test-redis-setup.js

# With Redis (tests full functionality)
REDIS_URL=redis://localhost:6379 node test-redis-setup.js
```

## Error Handling

All components include robust error handling:

- **Redis Client**: Automatic reconnection with exponential backoff
- **Key Generation**: Validation and parsing utilities
- **Logger**: Graceful degradation if logging fails
- **Config**: Clear error messages for invalid configuration

## Metrics

The Redis client tracks connection metrics:

```javascript
const metrics = redisClient.getMetrics();
console.log(metrics);
// {
//   connectionAttempts: 1,
//   successfulConnections: 1,
//   failedConnections: 0,
//   commandsExecuted: 42,
//   commandsFailed: 0,
//   lastConnectionTime: 1705320645123,
//   lastErrorTime: null,
//   isConnected: true,
//   reconnectDelay: 1000
// }
```

## Best Practices

1. **Always validate environment** before starting services
2. **Use structured logging** for distributed tracing
3. **Generate IDs consistently** using provided utilities
4. **Handle Redis disconnections** gracefully
5. **Monitor metrics** for performance tuning
6. **Use TTLs appropriately** to prevent memory leaks
7. **Close connections** on shutdown

## Migration from Existing Code

The infrastructure is designed to coexist with existing code:

- Existing `processedStore.js` continues to work
- Existing `logger.js` is enhanced, not replaced
- Environment variables are backward compatible
- Single-node mode preserves existing behavior

## Next Steps

After setting up the infrastructure:

1. Implement POW Service (Task 2)
2. Implement Job Queue Manager (Task 5)
3. Implement Worker Node (Task 7)
4. Implement Coordinator components (Tasks 9-11)

See `tasks.md` for the complete implementation plan.