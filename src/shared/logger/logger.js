/**
 * Unified logger for the Rakuten credential checker.
 *
 * One process-wide output mode, controlled by env at startup:
 *   LOG_FORMAT=human (default)  -> single-line ANSI output
 *   LOG_FORMAT=json             -> single-line JSON to stdout
 *   JSON_LOGGING=true           -> legacy alias for LOG_FORMAT=json
 *
 * LOG_LEVEL is read per-call so runtime config-service updates apply
 * immediately to every logger instance.
 *
 * Stream routing:
 *   human mode -> error/warn to stderr, rest to stdout
 *   json  mode -> all levels to stdout (12-factor friendly)
 *   LOCAL_FLOW_TEST=1 -> stdout for both modes (avoids PowerShell
 *   NativeCommandError on stderr from native commands)
 */

const util = require('util');
const os = require('os');

const COLORS = {
  reset: '\u001b[0m',
  gray: '\u001b[90m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
  magenta: '\u001b[35m',
  blue: '\u001b[34m',
};

const VALID_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];
const LEVEL_WEIGHTS = {
  error: 0,
  warn: 1,
  info: 2,
  success: 2,
  debug: 3,
  trace: 4,
};

const LEVEL_COLORS = {
  error: COLORS.red,
  warn: COLORS.yellow,
  info: COLORS.cyan,
  success: COLORS.green,
  debug: COLORS.magenta,
  trace: COLORS.gray,
};

const LEVEL_LABELS = {
  error: 'ERROR',
  warn: 'WARN ',
  info: 'INFO ',
  success: 'OK   ',
  debug: 'DEBUG',
  trace: 'TRACE',
};

// Output mode is fixed at process start; level is read per-call.
const OUTPUT_MODE = resolveOutputMode();

function resolveOutputMode() {
  const format = (process.env.LOG_FORMAT || '').trim().toLowerCase();
  if (format === 'json') return 'json';
  if (format === 'human') return 'human';
  if (process.env.JSON_LOGGING === 'true') return 'json'; // legacy alias
  return 'human';
}

function getCurrentLogLevel() {
  const level = (process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  return VALID_LEVELS.includes(level) ? level : 'info';
}

function shouldLog(level) {
  const weight = LEVEL_WEIGHTS[level] ?? LEVEL_WEIGHTS.info;
  const current = LEVEL_WEIGHTS[getCurrentLogLevel()] ?? LEVEL_WEIGHTS.info;
  return weight <= current;
}

function timestamp() {
  const now = new Date();
  const time = now.toISOString().split('T')[1] || '';
  return time.replace('Z', '');
}

// Human-mode argument formatting (printf-style + compact object inspect).
function formatArgs(args) {
  if (!args || args.length === 0) return '';
  const [first, ...rest] = args;
  if (typeof first === 'string') {
    return util.format(first, ...rest);
  }
  return [first, ...rest]
    .map((val) => (typeof val === 'string' ? val : util.inspect(val, { depth: 4, colors: false, breakLength: 120 })))
    .join(' ');
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Error);
}

// JSON-mode argument parsing: split into a message string + a context object
// so context fields can be spread at the top level of the JSON entry for
// log aggregator indexing.
function parseArgs(args) {
  if (!args || args.length === 0) return { message: '', context: {} };
  const [first, ...rest] = args;
  if (typeof first === 'string') {
    if (rest.length === 0) return { message: first, context: {} };
    if (rest.length === 1 && isPlainObject(rest[0])) return { message: first, context: rest[0] };
    if (rest.length === 1 && rest[0] instanceof Error) {
      return { message: first, context: { errorMessage: rest[0].message, stack: rest[0].stack } };
    }
    return { message: util.format(first, ...rest), context: {} };
  }
  if (first instanceof Error) {
    return { message: first.message, context: { errorMessage: first.message, stack: first.stack } };
  }
  return { message: util.inspect(first, { depth: 4, colors: false, breakLength: 120 }), context: {} };
}

function writeHuman(level, scope, args) {
  const color = LEVEL_COLORS[level] || COLORS.gray;
  const label = LEVEL_LABELS[level] || level.toUpperCase().padEnd(5, ' ');
  const scopeText = scope ? `[${scope}]` : '';
  const line = `${COLORS.gray}${timestamp()}${COLORS.reset} ${color}${label}${COLORS.reset} ${COLORS.blue}${scopeText}${COLORS.reset} ${formatArgs(args)}`.trim();

  if (process.env.LOCAL_FLOW_TEST === '1') {
    console.log(line);
  } else if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function writeJson(level, scope, args) {
  const { message, context } = parseArgs(args);
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    scope,
    message,
    ...context, // context fields spread at top level for aggregator indexing
  };
  // Note: a context key named timestamp/level/scope/message would override the
  // reserved fields above. No current caller does this.
  entry.process = {
    pid: process.pid,
    hostname: process.env.HOSTNAME || os.hostname(),
    nodeVersion: process.version,
  };
  if (context.traceId || process.env.TRACE_ID) {
    entry.traceId = context.traceId || process.env.TRACE_ID;
  }
  // JSON mode: all levels to stdout (12-factor; same stream as LOCAL_FLOW_TEST=1 in human mode).
  console.log(JSON.stringify(entry));
}

function logLine(level, scope, args) {
  if (!shouldLog(level)) return;
  if (OUTPUT_MODE === 'json') {
    writeJson(level, scope, args);
  } else {
    writeHuman(level, scope, args);
  }
}

function createLogger(scope = 'app') {
  const scoped = String(scope);
  return {
    error: (...args) => logLine('error', scoped, args),
    warn: (...args) => logLine('warn', scoped, args),
    info: (...args) => logLine('info', scoped, args),
    success: (...args) => logLine('success', scoped, args),
    debug: (...args) => logLine('debug', scoped, args),
    trace: (...args) => logLine('trace', scoped, args),
  };
}

module.exports = {
  createLogger,
  getCurrentLogLevel,
  shouldLog,
};
