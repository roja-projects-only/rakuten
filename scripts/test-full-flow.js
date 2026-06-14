#!/usr/bin/env node
/**
 * =============================================================================
 * LOCAL FULL-FLOW TEST — In-process coordinator → worker → checker → PoW
 * =============================================================================
 *
 * Runs the complete credential-check flow inside a single local process,
 * using the real production modules — no mocking, no external services required.
 *
 * What this test exercises:
 *   1. Environment loading (.env)
 *   2. Redis connectivity (optional — used for result storage if available)
 *   3. Simulated coordinator job creation
 *   4. Worker task execution via processTaskDirect()
 *   5. PoW/CRES computation (internal modules, automatic local fallback)
 *   6. HTTP credential check flow (navigate → email → password → outcome)
 *   7. Account data capture (if VALID)
 *
 * What this test does NOT do:
 *   - Does not start a Telegram bot
 *   - Does not start coordinator/worker HTTP servers
 *   - Does not require a separately running pow-service instance
 *   - Does not require AWS instances or distributed infrastructure
 *
 * Usage:
 *   npm run test:flow
 *   npm run test:flow -- --email user@example.com --password secret
 *   node scripts/test-full-flow.js
 *
 * Required env:
 *   TARGET_LOGIN_URL    — Rakuten login URL (from .env)
 *   TEST_EMAIL          — test credential email (or --email flag)
 *   TEST_PASSWORD       — test credential password (or --password flag)
 *
 * Optional env:
 *   REDIS_URL           — Redis URL (result storage; gracefully skipped if unavailable)
 *   POW_SERVICE_URL     — POW service URL (falls back to local computation automatically)
 *   PROXY_SERVER        — proxy for credential check
 *   TIMEOUT_MS          — HTTP timeout (default 60000)
 *   LOG_LEVEL           — log level (default 'info')
 *
 * =============================================================================
 */

'use strict';

// Load dotenv FIRST — before any shared module touches process.env
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

// Route all logger output through stdout (avoids PowerShell NativeCommandError on stderr)
process.env.LOCAL_FLOW_TEST = '1';

// Skip POW service connection test — local computation is used directly.
// Avoids ~42s timeout when POW_SERVICE_URL points to an unreachable host.
process.env.POW_SKIP_CONNECTION_TEST = '1';

// ─── Terminal formatting ─────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN  = '\x1b[36m';

function banner(text) {
  console.log(`\n${BOLD}${CYAN}━━━ ${text} ━━━${RESET}`);
}
function ok(text)   { console.log(`  ${GREEN}✔${RESET} ${text}`); }
function fail(text) { console.log(`  ${RED}✘${RESET} ${text}`); }
function warn(text) { console.log(`  ${YELLOW}⚠${RESET} ${text}`); }
function info(text) { console.log(`  ${DIM}→${RESET} ${text}`); }
function result(label, value) {
  console.log(`  ${BOLD}${label}:${RESET} ${value}`);
}
function elapsed(start) { return `${Date.now() - start}ms`; }

// ─── CLI arg parsing ─────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email'    && args[i + 1]) parsed.email    = args[++i];
    if (args[i] === '--password' && args[i + 1]) parsed.password = args[++i];
    if (args[i] === '--proxy'    && args[i + 1]) parsed.proxy    = args[++i];
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node scripts/test-full-flow.js [options]

Options:
  --email <addr>       Test credential email (overrides TEST_EMAIL env)
  --password <pass>    Test credential password (overrides TEST_PASSWORD env)
  --proxy <url>        Proxy URL (overrides PROXY_SERVER env)
  -h, --help           Show this help

Environment variables (from .env):
  TARGET_LOGIN_URL     Required. Rakuten login URL.
  TEST_EMAIL           Test credential email.
  TEST_PASSWORD        Test credential password.
  REDIS_URL            Optional. Redis for result storage (skipped if unavailable).
  POW_SERVICE_URL      Optional. POW service URL (local fallback is automatic).
  PROXY_SERVER         Optional. Proxy URL for credential check.
  TIMEOUT_MS           Optional. HTTP timeout (default 60000).
`);
      process.exit(0);
    }
  }
  return parsed;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const overallStart = Date.now();

  console.log(`\n${BOLD}Rakuten Local Full-Flow Test${RESET}`);
  console.log(`${DIM}Runs coordinator → worker → checker → PoW in-process${RESET}`);
  console.log(`${DIM}${'─'.repeat(55)}${RESET}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 1: Environment
  // ═══════════════════════════════════════════════════════════════════════════
  banner('Step 1: Environment');

  const targetUrl  = process.env.TARGET_LOGIN_URL;
  const email      = args.email    || process.env.TEST_EMAIL;
  const password   = args.password || process.env.TEST_PASSWORD;
  const redisUrl   = process.env.REDIS_URL;
  const proxy      = args.proxy    || process.env.PROXY_SERVER || null;
  const timeoutMs  = parseInt(process.env.TIMEOUT_MS, 10) || 60000;

  result('TARGET_LOGIN_URL', targetUrl ? `${targetUrl.substring(0, 70)}...` : `${RED}NOT SET${RESET}`);
  result('TEST_EMAIL',       email || `${YELLOW}NOT SET${RESET}`);
  result('TEST_PASSWORD',    password ? '***' : `${YELLOW}NOT SET${RESET}`);
  result('REDIS_URL',        redisUrl || `${DIM}not configured${RESET}`);
  result('PROXY_SERVER',     proxy || `${DIM}none (direct)${RESET}`);
  result('TIMEOUT_MS',       String(timeoutMs));

  if (!targetUrl) {
    fail('TARGET_LOGIN_URL is required — set it in .env');
    process.exit(1);
  }
  if (!email || !password) {
    fail('TEST_EMAIL and TEST_PASSWORD are required — set them in .env or pass --email / --password');
    process.exit(1);
  }
  ok('Environment loaded');

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 2: Redis (optional — for result storage only)
  // ═══════════════════════════════════════════════════════════════════════════
  banner('Step 2: Redis');

  let redisClient = null;
  if (!redisUrl) {
    warn('REDIS_URL not set — results will not be stored in Redis (flow still runs)');
  } else {
    const redisStart = Date.now();
    try {
      const { getRedisClient } = require('../src/shared/redis/client');
      redisClient = getRedisClient();
      await redisClient.connect();
      const healthy = await redisClient.isHealthy();
      if (healthy) {
        ok(`Redis connected (${elapsed(redisStart)})`);
      } else {
        warn('Redis health check failed — continuing without Redis');
        redisClient = null;
      }
    } catch (err) {
      warn(`Redis unavailable: ${err.message} — continuing without Redis`);
      redisClient = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 3: Coordinator — create test job
  // ═══════════════════════════════════════════════════════════════════════════
  banner('Step 3: Coordinator — create test job');

  const testTask = {
    username:  email,
    password:  password,
    proxyUrl:  proxy,
    batchId:   'local-flow-test',
    taskId:    `local-${Date.now()}`,
    proxyId:   proxy ? 'env-proxy' : null,
    timeoutMs: timeoutMs,
  };

  result('Task ID',  testTask.taskId);
  result('Batch ID', testTask.batchId);
  result('Username', email);
  result('Proxy',    proxy || 'none');
  ok('Test job created (simulating coordinator enqueue)');

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 4: Worker — execute task via real processTaskDirect
  // ═══════════════════════════════════════════════════════════════════════════
  banner('Step 4: Worker — execute task');

  info('Importing worker execution module...');
  const { processTaskDirect } = require('../src/worker/WorkerNode');

  info('Running credential check (navigate → PoW → email → password → outcome)...');
  info('PoW/CRES will be solved internally (local computation if POW service is not running)');

  const taskStart = Date.now();

  const taskResult = await processTaskDirect(testTask, {
    redis:    redisClient,
    workerId: 'local-test-worker',
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Step 5: Results
  // ═══════════════════════════════════════════════════════════════════════════
  banner('Step 5: Result');

  const statusColor = taskResult.status === 'VALID'   ? GREEN + BOLD
                    : taskResult.status === 'INVALID'  ? RED
                    : taskResult.status === 'BLOCKED'  ? YELLOW
                    : RED;

  result('Status',     `${statusColor}${taskResult.status}${RESET}`);
  result('Duration',   `${taskResult.checkDurationMs}ms`);

  if (taskResult.ipAddress) {
    result('Exit IP',  taskResult.ipAddress);
  }
  if (taskResult.errorCode) {
    result('Message',  taskResult.errorCode);
  }
  if (taskResult.captureError) {
    warn(`Capture error: ${taskResult.captureError}`);
  }

  // Show capture data if present
  if (taskResult.capture) {
    banner('Capture Data');
    const cap = taskResult.capture;
    result('Points',        cap.points ?? 'n/a');
    result('Rank',          cap.rank ?? 'n/a');
    result('Cash',          cap.cash ?? 'n/a');
    result('Latest Order',  cap.latestOrder ?? 'n/a');
    result('Order ID',      cap.latestOrderId ?? 'n/a');
    if (cap.profile) {
      result('Name',        cap.profile.name ?? 'n/a');
      result('Email',       cap.profile.email ?? 'n/a');
      if (cap.profile.cards && cap.profile.cards.length > 0) {
        result('Cards',     String(cap.profile.cards.length));
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cleanup — tear down all in-process resources so the process exits cleanly
  // ═══════════════════════════════════════════════════════════════════════════

  // 1. PoW worker pool (singleton with thread workers)
  try {
    const workerPool = require('../src/shared/fingerprinting/powWorkerPool');
    if (typeof workerPool.shutdown === 'function') await workerPool.shutdown();
  } catch (_) { /* ignore */ }

  // 2. PoW service client (singleton with timers)
  try {
    const powClient = require('../src/shared/fingerprinting/powServiceClient');
    if (typeof powClient.shutdown === 'function') powClient.shutdown();
  } catch (_) { /* ignore */ }

  // 3. Processed store (has its own Redis connection + write buffer timer)
  try {
    const { flushWriteBuffer, closeStore } = require('../src/shared/batch/processedStore');
    await flushWriteBuffer();
    await closeStore();
  } catch (_) { /* ignore */ }

  // 4. Shared Redis client
  if (redisClient) {
    try { await redisClient.close(); } catch (_) { /* ignore */ }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  banner('Summary');
  result('Final result', taskResult.status === 'VALID'
    ? `${GREEN}${BOLD}SUCCESS — credential is VALID${RESET}`
    : taskResult.status === 'INVALID'
      ? `${RED}FAILURE — credential is INVALID${RESET}`
      : taskResult.status === 'BLOCKED'
        ? `${YELLOW}FAILURE — credential is BLOCKED${RESET}`
        : `${RED}FAILURE — ${taskResult.status}: ${taskResult.errorCode || 'unknown'}${RESET}`
  );
  result('Total time', elapsed(overallStart));
  console.log(`${DIM}${'─'.repeat(55)}${RESET}`);

  if (taskResult.status === 'VALID') {
    console.log(`${GREEN}✔ Full-flow test passed. The coordinator/worker/checker/PoW pipeline works.${RESET}\n`);
  } else if (taskResult.status === 'INVALID') {
    // INVALID is still a successful flow — the system correctly detected bad creds
    console.log(`${GREEN}✔ Full-flow test passed. Pipeline works (credential was correctly rejected).${RESET}\n`);
  } else {
    console.log(`${RED}✘ Full-flow test did not reach a definitive VALID/INVALID result.${RESET}`);
    console.log(`${DIM}  Check the error details above. This may indicate a network or configuration issue.${RESET}\n`);
    process.exit(1);
  }

  // Force exit — background timers (processed-store flush, SIGINT handlers)
  // can keep the event loop alive even after explicit cleanup.
  process.exit(0);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`\n${RED}Fatal error:${RESET} ${err.message}`);
  if (err.stack) console.error(`${DIM}${err.stack}${RESET}`);
  process.exit(1);
});
