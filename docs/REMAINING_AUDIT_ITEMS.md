# Remaining Audit Items

Items from the audit that were **not implemented** — either deferred for later or classified as too risky to touch without a specific bug.

## R1. `WorkerNode.js` (1627 lines) — Single-file refactor

**Status**: Do not touch unless there is a proven bug.

**What it is**: The worker is a single file handling task dequeuing, credential checking, result storage, progress tracking, heartbeats, metrics, HTTP status server, and shutdown. A natural target for splitting.

**Why deferred**: The file works, is self-contained, and the execution flow is the most critical path in the system. `processTaskDirect` at the bottom is also used by `test-full-flow.js` — refactoring could break the test harness. No bugs reported.

**If ever touched**: Extract HTTP status server → `src/worker/httpServer.js`, extract metrics → `src/worker/metrics.js`, extract heartbeat → `src/worker/heartbeat.js`. Leave the core flow (`run → dequeue → process → store → publish`) intact.

---

## R2. HTTP client replacement (axios → undici/got/native fetch)

**Status**: Do not touch. No benefit justifies the risk.

**What it is**: The shared HTTP module uses `axios` + `axios-cookiejar-support` + `tough-cookie`. Replacing it would require re-testing every step of the Rakuten login flow (redirects, SSO forms, POW challenges, cookie management).

**Why deferred**: The login flow has many edge cases that are tested and working. Switching clients would introduce unknown regressions.

---

## R3. Processed store / dedup architecture changes

**Status**: Do not touch unless a specific dedup bug is found.

**What it is**: The `processedStore` and `channelForwardStore` work correctly with Redis-only dedup (no JSONL fallback). The coordinator shutdown flushes the write buffer.

**Why deferred**: The dedup system is critical for correctness — wrong changes can cause duplicate channel forwards or missed credentials. Current architecture is correct and battle-tested.

---

## N2. Re-export facade files

**Status**: Resolved — the referenced re-export files (`batchHandlers.js`, `messages.js`) no longer exist. All imports use the correct subdirectory paths (`batch/index.js`, `messages/index.js`). No action needed.

---

## N3. Single-node channel forwarder redundancy

**Status**: Deferred — medium risk, needs careful testing.

**What it is**: Two channel forwarder implementations exist:
- `src/telegram/channelForwarder.js` — imported by `telegramHandler.js`, `batchExecutor.js`, `combineBatchRunner.js`
- `src/coordinator/ChannelForwarder.js` — distributed forwarder via pub/sub (used in production)

In production, the `src/telegram/channelForwarder.js` `forwardValidToChannel()` function is still called by `.chk` and batch runners in coordinator mode, bypassing the distributed forwarder's two-phase commit protocol.

**How to do it**:
1. Route `.chk` single forwards through the coordinator's `ChannelForwarder` (publish `forward_event` to pub/sub)
2. Route batch forwards the same way
3. Remove the standalone `forwardValidToChannel` function from `src/telegram/channelForwarder.js`
4. Verify: forwards from `.chk`, batches, and combine batches all appear in the channel at most once

---

## H5b. Progress polling — second polling system (startTracking)

**Status**: Already consolidated in this round — `startTracking()` is now a no-op. The per-batch interval was removed. If issues with progress display appear, tune the global `pollingFrequency` in `ProgressTracker.js` (currently 8s).

---

## N4. Containerized deployment improvements

**Status**: Not a priority unless deploying via Docker Compose.

Minor items still open:
- The `docker-compose.yml` healthcheck for the POW service uses `wget` but the `pow-service` image has `curl` installed — inconsistent but works
- Coordinator log/data volumes (`../../logs:/app/logs`, `../../data:/app/data`) — the data directory doesn't exist in the project root
- Env variable duplication in docker-compose (each worker repeats the same block) — could use YAML anchors

---

## H6b. Additional Redis keys to migrate to `keys.js`

**Status**: Low remaining items — most key strings were migrated in this round.

Remaining hardcoded strings that should use the schema:
- `src/coordinator/ChannelForwarder.js` lines 190, 225, 234, 242, 259, 302, 313, 348–349 — `forward:pending:*`, `msg:*`, `msg:cred:*` — these use the keys.js constants now via imports for scan operations, but the inline `setex`/`get`/`del` calls still use hardcoded `forward:pending:${code}` patterns instead of `FORWARD_PENDING.generate(code)`.
