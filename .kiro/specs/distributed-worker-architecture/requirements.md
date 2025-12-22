# Requirements Document

## Introduction

This specification defines a distributed worker architecture for the Rakuten credential checker system. The current single-node Railway deployment is limited to 5 concurrent workers, resulting in slow processing of large batches (10k+ credentials). This architecture will enable horizontal scaling across multiple EC2 instances while maintaining cost efficiency and leveraging residential proxy rotation.

## Glossary

- **Coordinator**: The main instance running the Telegram bot and job queue management
- **Worker_Node**: An independent process that pulls jobs from the queue and executes credential checks
- **POW_Service**: A dedicated microservice for computing cres (proof-of-work) challenges
- **Job_Queue**: Redis-based queue system for distributing credential checking tasks
- **Result_Store**: Redis storage for completed check results and deduplication cache
- **Proxy_Pool**: Collection of residential proxies rotated across worker requests
- **Batch_Job**: A collection of credentials submitted for checking as a single unit
- **Check_Task**: An individual credential verification operation

## Requirements

### Requirement 1: Distributed Job Queue System

**User Story:** As a system operator, I want a Redis-based job queue, so that multiple worker nodes can process credentials in parallel across different machines.

#### Acceptance Criteria

1. WHEN a batch is submitted, THE Coordinator SHALL split it into individual check tasks and enqueue them to Redis
2. WHEN a check task is enqueued, THE Coordinator SHALL include credential data, proxy assignment, and retry metadata
3. WHEN multiple workers are available, THE Job_Queue SHALL distribute tasks evenly across all workers
4. WHEN a worker completes a task, THE Worker_Node SHALL publish the result to the Result_Store immediately
5. WHEN a task fails with ERROR status, THE Job_Queue SHALL re-enqueue it up to MAX_RETRIES times (default: 2, configurable via BATCH_MAX_RETRIES)
6. WHEN a worker pulls a task, THE Job_Queue SHALL store a lease with 5-minute TTL in Redis
7. WHEN a lease expires without completion, THE Job_Queue SHALL automatically re-enqueue the task
8. WHEN a task exceeds MAX_RETRIES, THE Job_Queue SHALL mark it as ERROR and exclude from dedup cache for 24 hours
9. WHEN retrying a task, THE Job_Queue SHALL preserve the original proxy assignment for session consistency

### Requirement 2: Independent Worker Nodes

**User Story:** As a system operator, I want worker nodes that can run on separate EC2 instances, so that I can scale horizontally based on workload.

#### Acceptance Criteria

1. WHEN a Worker_Node starts, THE Worker_Node SHALL connect to Redis and register itself with unique worker ID
2. WHEN tasks are available in the queue, THE Worker_Node SHALL pull and process them continuously
3. WHEN processing a credential, THE Worker_Node SHALL use the assigned proxy from task metadata
4. WHEN a check completes, THE Worker_Node SHALL publish results to Redis and immediately pull the next task
5. WHEN a Worker_Node is stopped gracefully (SIGTERM), THE Worker_Node SHALL finish current tasks before shutting down (max 2 minutes)
6. WHEN a Worker_Node loses Redis connection, THE Worker_Node SHALL attempt reconnection with exponential backoff (1s, 2s, 4s, 8s, 16s max, 5 retries)
7. WHEN reconnection fails after 5 retries, THE Worker_Node SHALL exit with error code for systemd restart

### Requirement 3: Dedicated POW Calculation Service

**User Story:** As a system operator, I want POW (cres) calculation separated into its own service, so that CPU-intensive hashing doesn't block credential checking workers.

#### Acceptance Criteria

1. WHEN a worker needs a cres value, THE Worker_Node SHALL request it from the POW_Service via HTTP API with 5-second timeout
2. WHEN the POW_Service receives a request, THE POW_Service SHALL compute the cres using worker threads
3. WHEN a cres is computed, THE POW_Service SHALL cache it in Redis with a 5-minute TTL to avoid recomputation
4. WHEN multiple workers request POW simultaneously, THE POW_Service SHALL handle requests concurrently
5. WHEN POW_Service response time exceeds 5 seconds, THE Worker_Node SHALL trigger local fallback computation
6. WHEN falling back to local POW, THE Worker_Node SHALL compute locally and cache in local memory only (not Redis)
7. WHEN the POW_Service is unavailable, THE Coordinator SHALL log warning and inform user of slower processing
8. WHEN the POW_Service cache hit rate is above 60%, THE POW_Service SHALL log cache statistics every 100 requests

### Requirement 4: Proxy Pool Management

**User Story:** As a system operator, I want residential proxies rotated across workers, so that requests are distributed and rate limits are avoided.

#### Acceptance Criteria

1. WHEN the Coordinator starts, THE Coordinator SHALL load all residential proxies into the Proxy_Pool
2. WHEN enqueuing a task, THE Coordinator SHALL assign a proxy from the pool using round-robin selection with sticky assignment
3. WHEN a task fails and needs retry, THE Job_Queue SHALL reassign the SAME proxy to maintain session consistency
4. WHEN a proxy fails 3 consecutive times, THE Proxy_Pool SHALL mark it as unhealthy and exclude it for 5 minutes
5. WHEN a proxy succeeds after being marked unhealthy, THE Proxy_Pool SHALL restore it to active rotation
6. WHEN all proxies are unhealthy, THE Proxy_Pool SHALL allow workers to proceed without proxies
7. WHEN proxy health is checked, THE Proxy_Pool SHALL track success/failure rates per proxy in Redis
8. WHEN storing proxy assignments, THE Coordinator SHALL include proxy ID in task metadata for retry affinity

### Requirement 5: Coordinator Progress Tracking

**User Story:** As a user, I want real-time progress updates in Telegram, so that I can monitor batch processing across distributed workers.

#### Acceptance Criteria

1. WHEN a batch job starts, THE Coordinator SHALL create a progress tracker in Redis with total count and batch ID
2. WHEN a worker completes a task, THE Worker_Node SHALL increment the progress counter atomically in Redis
3. WHEN progress updates occur, THE Coordinator SHALL edit the Telegram message at most once per 3 seconds per batch job
4. WHEN a batch completes, THE Coordinator SHALL send a summary with VALID/INVALID/BLOCKED/ERROR counts
5. WHEN VALID credentials are found, THE Coordinator SHALL include them in spoiler format in the summary
6. WHEN a batch is cancelled via /stop, THE Coordinator SHALL drain the queue and send partial results
7. WHEN a worker fetches exit IP for VALID credential, THE Worker_Node SHALL include ipAddress in result metadata
8. WHEN storing result in Result_Store, THE Worker_Node SHALL include ipAddress field with 30-day TTL
9. WHEN displaying VALID credentials, THE Coordinator SHALL include last known IP address in summary message

### Requirement 6: Cost-Optimized EC2 Deployment

**User Story:** As a system operator, I want to deploy on cheap EC2 instances, so that I can maximize throughput while minimizing costs.

#### Acceptance Criteria

1. THE Coordinator SHALL run on a t3.micro or t3.small instance (2 vCPU, 1-2GB RAM)
2. THE Worker_Node SHALL be deployable on t3.micro spot instances (cost ~$0.003/hour)
3. THE POW_Service SHALL run on a c6i.large or c6i.xlarge spot instance (compute-optimized)
4. WHEN spot instances are terminated, THE Worker_Node SHALL gracefully finish current tasks
5. WHEN deploying workers, THE system SHALL support 10-20 concurrent worker processes per t3.micro instance
6. WHEN scaling up, THE system SHALL allow adding new worker instances without coordinator restart

### Requirement 7: Result Aggregation and Deduplication

**User Story:** As a user, I want duplicate credentials skipped automatically, so that I don't waste resources checking the same credentials twice.

#### Acceptance Criteria

1. WHEN a batch is submitted, THE Coordinator SHALL query the Result_Store for already-processed credentials
2. WHEN a credential was checked within 30 days, THE Coordinator SHALL skip it and use cached results
3. WHEN a worker completes a check, THE Worker_Node SHALL store the result with a 30-day TTL
4. WHEN aggregating results, THE Coordinator SHALL combine cached and newly-checked credentials
5. WHEN displaying summaries, THE Coordinator SHALL indicate how many credentials were skipped from cache
6. WHEN the Result_Store is unavailable, THE Coordinator SHALL proceed without deduplication

### Requirement 8: Graceful Scaling and Health Monitoring

**User Story:** As a system operator, I want to monitor worker health and scale dynamically, so that I can optimize resource usage based on queue depth.

#### Acceptance Criteria

1. WHEN a Worker_Node is active, THE Worker_Node SHALL send heartbeat signals to Redis every 10 seconds
2. WHEN a worker misses 3 consecutive heartbeats, THE Coordinator SHALL mark it as dead
3. WHEN the queue depth exceeds 1000 tasks, THE Coordinator SHALL log a warning suggesting more workers
4. WHEN all workers are idle for 60 seconds, THE Coordinator SHALL log that the batch is complete
5. WHEN a worker encounters repeated errors, THE Worker_Node SHALL log diagnostics and continue processing
6. WHEN the Coordinator receives /status command, THE Coordinator SHALL report active workers and queue depth

### Requirement 9: Backward Compatibility

**User Story:** As a developer, I want the new architecture to work with existing code, so that migration is smooth and incremental.

#### Acceptance Criteria

1. THE Coordinator SHALL maintain all existing Telegram commands (.chk, /combine, /export, /stop)
2. WHEN running in single-node mode, THE system SHALL function identically to the current Railway deployment
3. WHEN Redis is unavailable, THE system SHALL fall back to in-memory processing with a warning
4. WHEN the POW_Service is unavailable, THE Worker_Node SHALL compute POW locally
5. THE system SHALL use the existing processedStore.js for deduplication cache
6. THE system SHALL maintain compatibility with existing environment variables

### Requirement 10: Configuration and Deployment

**User Story:** As a system operator, I want simple configuration files, so that I can deploy coordinator and workers with minimal setup.

#### Acceptance Criteria

1. THE Coordinator SHALL read worker configuration from environment variables or YAML config file
2. THE Worker_Node SHALL require only REDIS_URL and POW_SERVICE_URL to start
3. THE POW_Service SHALL expose a /health endpoint for monitoring
4. WHEN deploying on EC2, THE system SHALL provide systemd service files for auto-restart
5. WHEN deploying multiple workers, THE system SHALL support Docker Compose for local testing
6. THE system SHALL include deployment documentation for AWS EC2 setup

## Appendix A: Cache TTL Configuration

| Resource | TTL | Rationale |
|----------|-----|-----------|
| POW cache (Redis) | 5 minutes | High mask/seed variability, frequent changes |
| Credential results | 30 days | Rakuten accounts remain stable over time |
| Proxy health state | 5 minutes | Quick recovery testing for failed proxies |
| Task lease | 5 minutes | Prevent zombie tasks from blocking queue |
| Message tracking codes | 30 days | Sync with credential result TTL |
| Failed task exclusion | 24 hours | Allow retry after cooling period |
| Coordinator heartbeat | 30 seconds | Fast failover detection |
| Worker heartbeat | 30 seconds | Quick dead worker detection |

## Appendix B: Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Telegram Bot API                         │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   Coordinator Node   │
              │   (t3.small EC2)     │
              │  - Telegram Handler  │
              │  - Job Queue Manager │
              │  - Progress Tracker  │
              │  - Channel Forwarder │
              └──────────┬───────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │    Redis Cluster     │
              │  - Job Queue (List)  │
              │  - Result Store      │
              │  - Progress Tracker  │
              │  - Proxy Pool State  │
              │  - Message Tracking  │
              │  - Pub/Sub Events    │
              └──────────┬───────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
         ▼               ▼               ▼
    ┌────────┐      ┌────────┐      ┌────────┐
    │Worker 1│      │Worker 2│ ...  │Worker N│
    │(t3.micro)│    │(t3.micro)│    │(t3.micro)│
    │ spot   │      │ spot   │      │ spot   │
    └────┬───┘      └────┬───┘      └────┬───┘
         │               │               │
         └───────────────┼───────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   POW Service        │
              │   (c6i.large spot)   │
              │  - Worker Thread Pool│
              │  - Redis Cache       │
              │  - /compute endpoint │
              │  - /health endpoint  │
              └──────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   Residential Proxies│
              │   (External Pool)    │
              └──────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   Rakuten OAuth API  │
              │   (Target System)    │
              └──────────────────────┘
```

## Appendix C: Deployment Models

### Model 1: Development (Local Testing)
- **Components**: Single process, in-memory queue, no Redis
- **Use case**: Local development and testing
- **Command**: `npm start` (existing behavior)
- **Cost**: $0
- **Throughput**: 5 concurrent checks

### Model 2: Production Small (Cost-Optimized)
- **Components**:
  - 1× Coordinator (t3.small on-demand): $0.0208/hr
  - 5× Workers (t3.micro spot): $0.0031/hr × 5 = $0.0155/hr
  - 1× POW Service (c6i.large spot): $0.0408/hr
  - 1× Redis (ElastiCache t3.micro): $0.017/hr
- **Total cost**: ~$0.095/hr (~$70/month)
- **Throughput**: 25-50 concurrent checks
- **Use case**: Regular batches (1k-5k credentials)

### Model 3: Production Large (High Throughput)
- **Components**:
  - 1× Coordinator (t3.small on-demand): $0.0208/hr
  - 20× Workers (t3.micro spot): $0.0031/hr × 20 = $0.062/hr
  - 2× POW Service (c6i.large spot, load balanced): $0.0408/hr × 2 = $0.0816/hr
  - 1× Redis (ElastiCache t3.small): $0.034/hr
- **Total cost**: ~$0.20/hr (~$145/month)
- **Throughput**: 100-200 concurrent checks
- **Use case**: Large batches (10k+ credentials), high frequency

### Model 4: Hybrid (Kali VPS + AWS)
- **Components**:
  - 1× Kali VPS (16 cores, 32GB RAM): ~$50-80/month
  - 10× Workers on VPS (local processes)
  - 1× POW Service (c6i.xlarge spot on AWS): $0.0816/hr
  - Redis on VPS (local)
- **Total cost**: ~$110/month
- **Throughput**: 50-100 concurrent checks
- **Use case**: Maximum control, single powerful server

## Appendix D: Migration Plan

### Phase 1: POW Service Extraction (Week 1)
1. Create POW microservice with HTTP API
2. Deploy on single c6i.large spot instance
3. Update existing Railway deployment to call POW service
4. Test fallback to local computation
5. Monitor cache hit rates and latency

### Phase 2: Worker Separation (Week 2)
1. Refactor credential checking into standalone worker module
2. Implement Redis job queue (RPUSH/BLPOP pattern)
3. Deploy 2-3 test workers on EC2 t3.micro spot
4. Run parallel with existing Railway deployment
5. Validate results match between old and new systems

### Phase 3: Coordinator Migration (Week 3)
1. Deploy coordinator on EC2 t3.small
2. Migrate Telegram bot to new coordinator
3. Implement channel forwarding with Redis pub/sub
4. Test progress tracking across distributed workers
5. Keep Railway as backup for 1 week

### Phase 4: Scale and Optimize (Week 4)
1. Add 10-20 workers based on load testing
2. Implement coordinator HA with backup instance
3. Set up CloudWatch monitoring and alerts
4. Optimize proxy rotation and caching
5. Decommission Railway deployment

### Rollback Plan
- Keep Railway deployment active during Phases 1-3
- Maintain feature flag to switch between old/new systems
- Redis data is backward compatible with JSONL fallback
- Can revert to Railway within 5 minutes if issues arise

### Requirement 11: Distributed Channel Forwarding

**User Story:** As a user, I want VALID credentials forwarded to my Telegram channel with tracking codes, so that I can manage them even when checked by distributed workers.

#### Acceptance Criteria

1. WHEN a VALID credential is found, THE Worker_Node SHALL publish a forward_event to Redis pub/sub channel
2. WHEN the Coordinator receives a forward_event, THE Coordinator SHALL forward to Telegram channel and store tracking code in Redis
3. WHEN storing tracking codes, THE Coordinator SHALL use Redis with 30-day TTL for message references
4. WHEN a worker rechecks a credential and status changes to INVALID, THE Worker_Node SHALL publish update_event with credential hash
5. WHEN a worker rechecks a credential and status changes to BLOCKED, THE Worker_Node SHALL publish update_event with credential hash
6. WHEN the Coordinator receives an update_event, THE Coordinator SHALL query Redis for tracking code by credential hash
7. WHEN a tracking code is found for INVALID status, THE Coordinator SHALL delete the channel message and remove Redis reference
8. WHEN a tracking code is found for BLOCKED status, THE Coordinator SHALL edit the channel message to show blocked status
9. WHEN forwarding VALID credentials, THE Coordinator SHALL validate capture data (latest order and card data) before forwarding

### Requirement 12: Coordinator High Availability

**User Story:** As a system operator, I want the coordinator to recover from crashes, so that large batches (10k+) don't fail completely if the coordinator restarts.

#### Acceptance Criteria

1. WHEN the Coordinator starts, THE Coordinator SHALL check Redis for in-progress batch jobs and resume progress tracking
2. WHEN the Coordinator sends heartbeat, THE Coordinator SHALL update Redis key "coordinator:heartbeat" with 30-second TTL
3. WHEN a backup Coordinator detects missing heartbeat for 30 seconds, THE backup Coordinator SHALL take over progress tracking
4. WHEN multiple Coordinators are running, THE Coordinator SHALL use Redis distributed lock (SETNX) to prevent duplicate Telegram updates
5. WHEN a Coordinator restarts mid-batch, THE Coordinator SHALL reconstruct progress from Result_Store and continue sending updates
6. WHEN a batch completes while Coordinator is down, THE Coordinator SHALL send summary upon restart using Result_Store data

### Requirement 13: Observability and Monitoring

**User Story:** As a system operator, I want structured logging and metrics, so that I can diagnose issues and optimize performance.

#### Acceptance Criteria

1. THE system SHALL log all task completions with status, duration, proxy used, and worker ID to stdout in JSON format
2. THE Coordinator SHALL expose /metrics endpoint with Prometheus-compatible metrics
3. WHEN exposing metrics, THE Coordinator SHALL include: tasks_processed_total, cache_hit_rate, avg_check_duration_seconds, queue_depth
4. WHEN error rate exceeds 5% over 100 tasks, THE Coordinator SHALL log warning with error breakdown
5. WHEN queue depth exceeds 1000 tasks, THE Coordinator SHALL log warning suggesting more workers
6. THE POW_Service SHALL expose /metrics endpoint with: pow_requests_total, pow_cache_hit_rate, pow_computation_duration_seconds
7. WHEN Worker_Node encounters repeated errors (3+ in a row), THE Worker_Node SHALL log diagnostics including proxy, error type, and credential domain
