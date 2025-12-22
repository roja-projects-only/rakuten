# Implementation Plan: Distributed Worker Architecture

## Overview

This implementation plan transforms the Rakuten credential checker from a single-node Railway deployment into a horizontally scalable distributed system. The plan follows a phased approach: first extract the POW service, then separate workers, then migrate the coordinator, and finally scale and optimize. Each phase builds incrementally with validation gates to ensure stability.

## Tasks

- [x] 1. Set up Redis infrastructure and shared utilities
  - Create Redis client wrapper with connection pooling and retry logic
  - Implement Redis key schema constants from Appendix B
  - Create shared logger with JSON formatting for structured logging
  - Set up environment variable validation for distributed mode
  - _Requirements: 1.1, 2.1, 10.1, 10.2, 13.1_

- [ ]* 1.1 Write property test for Redis connection resilience
  - **Property 12: Exponential backoff on reconnection**
  - **Validates: Requirements 2.6**

- [-] 2. Implement POW Service as standalone microservice
  - [x] 2.1 Create POW service HTTP server with Express
    - Implement POST /compute endpoint with request validation
    - Implement GET /health endpoint with cache statistics
    - Implement GET /metrics endpoint with Prometheus format
    - _Requirements: 3.1, 3.2, 10.3, 13.6_

  - [x] 2.2 Implement worker thread pool for MurmurHash computation
    - Create worker thread pool using existing powWorkerPool.js
    - Implement cres computation with mask/key/seed validation
    - Add timeout handling (5 seconds per computation)
    - _Requirements: 3.2_

  - [x] 2.3 Add Redis caching layer to POW service
    - Cache computed cres values with 5-minute TTL
    - Implement cache key generation: `pow:{mask}:{key}:{seed}`
    - Track cache hit rate and log statistics every 100 requests
    - _Requirements: 3.3, 3.8_

  - [ ]* 2.4 Write property tests for POW service
    - **Property 14: POW request timeout**
    - **Property 15: POW cache storage**
    - **Property 16: POW concurrency**
    - **Validates: Requirements 3.1, 3.3, 3.4, 3.5**

  - [x] 2.5 Deploy POW service to EC2 c6i.large spot instance
    - Create Dockerfile for POW service
    - Create systemd service file for auto-restart
    - Configure environment variables (REDIS_URL, PORT)
    - Test deployment and health endpoint
    - _Requirements: 6.3, 10.4_

- [x] 3. Checkpoint - Ensure POW service is operational
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Refactor existing code to support POW service client
  - [x] 4.1 Create POW service HTTP client with timeout and fallback
    - Implement HTTP client with 5-second timeout
    - Add fallback to local POW computation on timeout/error
    - Cache fallback results in local memory only (not Redis)
    - _Requirements: 3.1, 3.5, 3.6, 3.7_

  - [ ]* 4.2 Write property tests for POW client fallback
    - **Property 14: POW request timeout**
    - **Property 17: Local POW fallback isolation**
    - **Validates: Requirements 3.5, 3.6**

  - [x] 4.3 Update existing httpFlow.js to use POW service client
    - Replace direct POW computation with POW service client calls
    - Add error handling for POW service unavailability
    - Log warnings when falling back to local computation
    - _Requirements: 3.7_

  - [x] 4.4 Test POW service integration with existing Railway deployment
    - Deploy updated code to Railway
    - Verify POW service is called for credential checks
    - Verify fallback works when POW service is stopped
    - Monitor cache hit rates and response times
    - _Requirements: 3.4, 3.8_

- [x] 5. Implement Job Queue Manager (Coordinator component)
  - [x] 5.1 Create JobQueueManager class with batch enqueue logic
    - Implement enqueueBatch() to split credentials into tasks
    - Query Result_Store for deduplication (30-day cache)
    - Assign proxies using round-robin with ProxyPoolManager
    - RPUSH tasks to Redis list: `queue:tasks`
    - Initialize progress tracker in Redis
    - _Requirements: 1.1, 1.2, 7.1, 7.2_

  - [x] 5.2 Implement retry logic in JobQueueManager
    - Implement retryTask() with MAX_RETRIES enforcement (default: 2)
    - Preserve proxy assignment on retry (sticky proxy)
    - Mark tasks as ERROR with 24-hour exclusion after max retries
    - _Requirements: 1.5, 1.8, 1.9_

  - [x] 5.3 Implement batch cancellation in JobQueueManager
    - Implement cancelBatch() to drain queue by batchId
    - Remove all matching tasks from Redis queue
    - Return count of drained tasks
    - _Requirements: 5.6_

  - [ ]* 5.4 Write property tests for JobQueueManager
    - **Property 1: Batch task splitting**
    - **Property 2: Task structure completeness**
    - **Property 5: Retry limit enforcement**
    - **Property 6: Proxy affinity on retry**
    - **Validates: Requirements 1.1, 1.2, 1.5, 1.8, 1.9, 4.3, 7.1**

- [x] 6. Implement Proxy Pool Manager (Coordinator component)
  - [x] 6.1 Create ProxyPoolManager class with round-robin assignment
    - Load proxies from environment variable (comma-separated)
    - Implement assignProxy() with round-robin selection
    - Filter out unhealthy proxies from Redis health state
    - Return null proxy if all unhealthy (fallback to direct)
    - _Requirements: 4.1, 4.2, 4.6_

  - [x] 6.2 Implement proxy health tracking
    - Implement recordProxyResult() to update health statistics
    - Mark proxy unhealthy after 3 consecutive failures (5-min TTL)
    - Restore proxy to active rotation on success
    - Store health state in Redis: `proxy:{proxyId}:health`
    - _Requirements: 4.4, 4.5, 4.7_

  - [ ]* 6.3 Write property tests for ProxyPoolManager
    - **Property 18: Round-robin proxy assignment**
    - **Property 19: Proxy health marking**
    - **Property 20: Proxy recovery**
    - **Property 21: Proxy health tracking**
    - **Validates: Requirements 4.2, 4.4, 4.5, 4.7**

- [x] 7. Implement Worker Node as standalone process
  - [x] 7.1 Create WorkerNode class with main processing loop
    - Register worker with unique ID in Redis on startup
    - Implement run() loop: BLPOP from `queue:tasks` (30s timeout)
    - Acquire task lease: SET `job:{batchId}:{taskId}` with 5-min TTL
    - Process task via processTask()
    - Release lease after completion: DEL `job:{batchId}:{taskId}`
    - _Requirements: 2.1, 2.2, 1.6_

  - [x] 7.2 Implement task processing in WorkerNode
    - Extract credential, proxy, batchId from task
    - Request cres from POW service (with fallback)
    - Execute credential check via existing httpChecker.js
    - Fetch exit IP for VALID credentials via ipFetcher.js
    - Capture account data for VALID via httpDataCapture.js
    - Store result in Result_Store with 30-day TTL
    - Increment progress counter: INCR `progress:{batchId}`
    - _Requirements: 2.3, 2.4, 5.7, 5.8, 7.3_

  - [x] 7.3 Implement heartbeat mechanism in WorkerNode
    - Send heartbeat every 10 seconds to Redis
    - SET `worker:{workerId}:heartbeat` with 30-second TTL
    - PUBLISH to `worker_heartbeats` channel with metadata
    - _Requirements: 8.1_

  - [x] 7.4 Implement graceful shutdown in WorkerNode
    - Handle SIGTERM signal
    - Stop pulling new tasks immediately
    - Finish current task (max 2 minutes timeout)
    - Release task lease if timeout exceeded
    - Log incomplete task ID
    - Exit with code 0 for systemd restart
    - _Requirements: 2.5_

  - [ ]* 7.5 Write property tests for WorkerNode
    - **Property 3: Task lease creation**
    - **Property 7: Result atomicity**
    - **Property 8: Worker registration**
    - **Property 9: Continuous task processing**
    - **Property 10: Proxy usage compliance**
    - **Property 11: Worker cycle completion**
    - **Property 13: Worker heartbeat timing**
    - **Property 27: IP address tracking**
    - **Property 29: Result caching**
    - **Validates: Requirements 1.4, 1.6, 2.1, 2.2, 2.3, 2.4, 5.7, 5.8, 7.3, 8.1**

- [x] 8. Checkpoint - Ensure worker nodes can process tasks
  - Ensure all tests pass, ask the user if questions arise.


- [x] 9. Implement Progress Tracker (Coordinator component)
  - [x] 9.1 Create ProgressTracker class with batch initialization
    - Implement initBatch() to create progress tracker in Redis
    - Store: total, completed: 0, chatId, messageId, startTime
    - SET `progress:{batchId}` with 7-day TTL
    - _Requirements: 5.1_

  - [x] 9.2 Implement progress update handling with throttling
    - Subscribe to Redis pub/sub for progress events
    - Implement handleProgressUpdate() with 3-second throttle per batch
    - Fetch completed count from Redis: GET `progress:{batchId}:count`
    - Calculate percentage and edit Telegram message
    - Track last update time per batch in Map
    - _Requirements: 5.2, 5.3_

  - [x] 9.3 Implement summary generation
    - Implement sendSummary() to query Result_Store by batchId
    - Aggregate counts: VALID, INVALID, BLOCKED, ERROR
    - Format VALID credentials in spoiler format with IP addresses
    - Send summary message to Telegram
    - Clean up progress tracker: DEL `progress:{batchId}`
    - _Requirements: 5.4, 5.5, 5.9, 7.4, 7.5_

  - [ ]* 9.4 Write property tests for ProgressTracker
    - **Property 22: Progress tracker initialization**
    - **Property 23: Atomic progress increment**
    - **Property 24: Telegram update throttling**
    - **Property 25: Summary accuracy**
    - **Property 26: Spoiler formatting**
    - **Property 30: Result aggregation**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 7.4, 7.5**

- [x] 10. Implement Channel Forwarder (Coordinator component)
  - [x] 10.1 Create ChannelForwarder class with event handlers
    - Subscribe to Redis pub/sub: `forward_events`, `update_events`
    - Implement handleForwardEvent() with capture data validation
    - Validate: latestOrder !== 'n/a' AND cards.length > 0
    - Skip forwarding if validation fails (log reason)
    - _Requirements: 11.1, 11.9_

  - [x] 10.2 Implement two-phase commit for channel forwarding
    - Generate tracking code: `RK-${hash(username+password).substring(0, 8)}`
    - Phase 1: SET `forward:pending:{trackingCode}` with event data (2-min TTL)
    - Phase 2: Format and forward message to Telegram channel
    - Phase 3: Store message reference with 30-day TTL
    - Phase 4: Store reverse lookup: `msg:cred:{username}:{password}`
    - Phase 5: DEL `forward:pending:{trackingCode}`
    - _Requirements: 11.2, 11.3, 12.7_

  - [x] 10.3 Implement status update handling
    - Implement handleUpdateEvent() for INVALID/BLOCKED status changes
    - Query reverse lookup: GET `msg:cred:{username}:{password}`
    - For INVALID: Delete channel message and Redis references
    - For BLOCKED: Edit channel message to show blocked status
    - _Requirements: 11.4, 11.5, 11.6, 11.7, 11.8_

  - [x] 10.4 Implement pending forward retry on coordinator startup
    - Implement retryPendingForwards() to scan `forward:pending:*`
    - Retry forwards older than 30 seconds
    - Delete pending state on success
    - _Requirements: 12.8_

  - [ ]* 10.5 Write property tests for ChannelForwarder
    - **Property 32: Forward event publication**
    - **Property 33: Tracking code storage**
    - **Property 34: Status change event publication**
    - **Property 35: Reverse lookup functionality**
    - **Property 36: Message cleanup on INVALID**
    - **Property 37: Message update on BLOCKED**
    - **Property 38: Capture data validation**
    - **Property 41: Two-phase commit atomicity**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 12.7**

- [x] 11. Implement Coordinator with High Availability
  - [x] 11.1 Create Coordinator class integrating all components
    - Initialize JobQueueManager, ProxyPoolManager, ProgressTracker, ChannelForwarder
    - Maintain existing Telegram bot commands (.chk, /combine, /export, /stop)
    - Route batch submissions to JobQueueManager
    - _Requirements: 9.1, 10.1_

  - [x] 11.2 Implement coordinator heartbeat and crash recovery
    - Send heartbeat every 30 seconds: SET `coordinator:heartbeat` with 30-sec TTL
    - On startup, check Redis for in-progress batches
    - Resume progress tracking for in-progress batches
    - Retry pending channel forwards via ChannelForwarder
    - _Requirements: 12.1, 12.2, 12.5, 12.6_

  - [x] 11.3 Implement distributed locking for multi-coordinator setup
    - Use Redis SETNX for distributed locks: `coordinator:lock:{operation}`
    - Acquire lock before Telegram updates (10-second TTL)
    - Release lock after operation completes
    - _Requirements: 12.3, 12.4_

  - [x] 11.4 Implement health monitoring and status command
    - Background job to detect dead workers (every 30 seconds)
    - Mark workers dead if heartbeat missing for 30 seconds
    - Implement /status command to report active workers and queue depth
    - Log warnings when queue depth exceeds 1000 tasks
    - _Requirements: 8.2, 8.3, 8.6_

  - [ ]* 11.5 Write property tests for Coordinator HA
    - **Property 31: Dead worker detection**
    - **Property 39: Coordinator heartbeat TTL**
    - **Property 40: Distributed lock prevention**
    - **Validates: Requirements 8.2, 12.2, 12.4**

- [x] 12. Implement zombie task recovery background job
  - Scan Redis for expired leases: `job:*` with TTL = -2
  - Re-enqueue tasks with expired leases
  - Run every 60 seconds as background job
  - _Requirements: 1.7_

- [ ]* 12.1 Write property test for zombie task recovery
  - **Property 4: Zombie task recovery**
  - **Validates: Requirements 1.7**

- [x] 13. Implement observability and metrics
  - [x] 13.1 Add structured JSON logging to all components
    - Log task completions with: status, duration, proxyId, workerId, timestamp
    - Log errors with: errorCode, stack trace, context
    - Use existing logger.js with JSON format
    - _Requirements: 13.1_

  - [x] 13.2 Implement Prometheus metrics endpoint in Coordinator
    - Expose /metrics endpoint with Prometheus format
    - Track: tasks_processed_total, cache_hit_rate, avg_check_duration_seconds, queue_depth
    - Update metrics on task completion and progress updates
    - _Requirements: 13.2, 13.3_

  - [x] 13.3 Implement error rate monitoring
    - Track error rate over rolling 100-task window
    - Log warning when error rate exceeds 5%
    - Include error breakdown by error code
    - _Requirements: 13.4_

  - [ ]* 13.4 Write property tests for observability
    - **Property 42: Structured logging format**
    - **Property 43: Metrics endpoint content**
    - **Property 44: Error rate warning**
    - **Validates: Requirements 13.1, 13.3, 13.4**

- [x] 14. Checkpoint - Ensure all components integrate correctly
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Create deployment configurations
  - [x] 15.1 Create Dockerfile for Coordinator
    - Multi-stage build with Node.js 18
    - Copy only necessary files (exclude tests)
    - Set environment variables
    - Expose ports for Telegram bot and metrics
    - _Requirements: 10.5_

  - [x] 15.2 Create Dockerfile for Worker Node
    - Multi-stage build with Node.js 18
    - Include murmurhash-native for local POW fallback
    - Set environment variables (REDIS_URL, POW_SERVICE_URL)
    - _Requirements: 10.5_

  - [x] 15.3 Create systemd service files for EC2 deployment
    - Create coordinator.service with auto-restart
    - Create worker.service with auto-restart
    - Create pow-service.service with auto-restart
    - Configure restart policies and logging
    - _Requirements: 10.4_

  - [x] 15.4 Create Docker Compose for local testing
    - Define services: coordinator, worker (×3), pow-service, redis
    - Configure networking and environment variables
    - Add health checks for all services
    - _Requirements: 10.5_

  - [x] 15.5 Write deployment documentation
    - Document AWS EC2 setup (instance types, security groups)
    - Document environment variable configuration
    - Document scaling procedures (adding workers)
    - Document monitoring setup (CloudWatch, Prometheus)
    - Include cost estimates for different deployment models
    - _Requirements: 10.6_

- [x] 16. Implement backward compatibility and fallback modes
  - [x] 16.1 Add single-node mode detection
    - Detect if REDIS_URL is not set
    - Fall back to in-memory job queue
    - Use existing processedStore.js for deduplication
    - Log warning about single-node mode
    - _Requirements: 9.2, 9.3_

  - [x] 16.2 Add graceful degradation for service unavailability
    - Handle Redis unavailable: fall back to in-memory
    - Handle POW service unavailable: use local computation
    - Handle Telegram API unavailable: retry with backoff
    - Log warnings for all degradation scenarios
    - _Requirements: 9.4, 3.7_

  - [x] 16.3 Maintain existing environment variable compatibility
    - Support all existing env vars (TELEGRAM_BOT_TOKEN, TARGET_LOGIN_URL, etc.)
    - Add new env vars with sensible defaults
    - Document all environment variables
    - _Requirements: 9.6_

- [x] 17. Integration testing and validation
  - [x] 17.1 Test end-to-end batch processing
    - Submit 100-credential batch via Telegram
    - Verify tasks enqueued correctly
    - Verify workers process tasks
    - Verify progress updates in Telegram
    - Verify final summary with correct counts
    - _Requirements: 1.1, 2.2, 5.3, 5.4_

  - [x] 17.2 Test coordinator failover
    - Start primary coordinator with batch processing
    - Kill primary coordinator mid-batch
    - Verify backup coordinator takes over
    - Verify batch completes successfully
    - Verify pending forwards are retried
    - _Requirements: 12.3, 12.5, 12.8_

  - [x] 17.3 Test worker crash recovery
    - Start worker processing task
    - Kill worker mid-task
    - Verify lease expires after 5 minutes
    - Verify task re-enqueued by zombie recovery job
    - Verify task completes on retry
    - _Requirements: 1.7, 2.5_

  - [x] 17.4 Test proxy rotation and health tracking
    - Submit batch with multiple proxies
    - Verify round-robin assignment
    - Simulate proxy failures
    - Verify unhealthy proxies excluded
    - Verify successful proxies restored
    - _Requirements: 4.2, 4.4, 4.5_

  - [x] 17.5 Test POW service degradation
    - Start batch with POW service running
    - Stop POW service mid-batch
    - Verify workers fall back to local computation
    - Verify batch completes (slower)
    - Restart POW service and verify workers reconnect
    - _Requirements: 3.5, 3.6, 3.7_

  - [x] 17.6 Test deduplication across batches
    - Submit batch A with 100 credentials
    - Wait for completion
    - Submit batch B with 50 same + 50 new credentials
    - Verify 50 credentials skipped from cache
    - Verify summary shows cache skip count
    - _Requirements: 7.1, 7.2, 7.5_

- [ ] 18. Performance testing and optimization
  - [ ] 18.1 Load test with 10k credential batch
    - Deploy 20 worker instances (t3.micro spot)
    - Submit 10k credential batch
    - Monitor queue depth, worker CPU, Redis memory
    - Verify completion in <2 hours (target SLO)
    - Measure actual throughput (credentials/minute)
    - _Requirements: 6.5_

  - [ ] 18.2 Test concurrent batch processing
    - Submit 3 batches simultaneously (1k each)
    - Verify fair task distribution across batches
    - Verify progress tracking per batch
    - Verify no cross-batch contamination
    - _Requirements: 1.3, 5.1, 5.2_

  - [ ] 18.3 Measure POW cache hit rate
    - Submit batch with repeated mask/key/seed patterns
    - Monitor POW service cache hit rate
    - Verify >60% cache hit rate (target SLO)
    - Verify cache TTL behavior (5 minutes)
    - _Requirements: 3.3, 3.8_

  - [ ] 18.4 Validate proxy fairness
    - Process 1000 tasks with 10 proxies
    - Measure tasks per proxy
    - Verify each proxy gets 100 ±10 tasks (target SLO)
    - _Requirements: 4.2_

- [ ] 19. Final checkpoint - Production readiness validation
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 20. Migration from Railway to AWS EC2
  - [ ] 20.1 Deploy POW service to EC2 (Phase 1)
    - Launch c6i.large spot instance
    - Deploy POW service Docker container
    - Configure security groups (allow HTTP from workers)
    - Test health endpoint and metrics
    - Update Railway deployment to use POW service
    - Monitor for 48 hours
    - _Requirements: 6.3_

  - [ ] 20.2 Deploy worker cluster to EC2 (Phase 2)
    - Launch 5× t3.micro spot instances
    - Deploy worker Docker containers
    - Configure environment variables (REDIS_URL, POW_SERVICE_URL)
    - Test workers pulling from queue
    - Run parallel with Railway for 1 week
    - Validate results match between old and new systems
    - _Requirements: 6.2, 6.5_

  - [ ] 20.3 Deploy coordinator to EC2 (Phase 3)
    - Launch t3.small on-demand instance
    - Deploy coordinator Docker container
    - Migrate Telegram bot webhook to new coordinator
    - Test all Telegram commands
    - Keep Railway as backup for 1 week
    - _Requirements: 6.1_

  - [ ] 20.4 Scale and optimize (Phase 4)
    - Add 10-20 workers based on load testing results
    - Deploy backup coordinator for HA
    - Set up CloudWatch monitoring and alerts
    - Optimize proxy rotation based on metrics
    - Decommission Railway deployment
    - _Requirements: 6.6, 12.3_

## Notes

- Tasks marked with `*` are optional property-based tests and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at reasonable breaks
- Property tests validate universal correctness properties across all inputs
- Unit tests validate specific examples and edge cases
- Integration tests validate end-to-end flows across distributed components
- Performance tests validate SLO targets from Appendix E
- Migration follows phased rollout from Appendix H with rollback capability

