const util = require('util');

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

const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'];
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

function parseLevel(input) {
  if (!input || typeof input !== 'string') return 'info';
  const normalized = input.trim().toLowerCase();
  return LEVELS.includes(normalized) ? normalized : 'info';
}

const CURRENT_LEVEL = parseLevel(process.env.LOG_LEVEL);

function timestamp() {
  const now = new Date();
  const time = now.toISOString().split('T')[1] || '';
  return time.replace('Z', '');
}

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

function shouldLog(level) {
  const weight = LEVEL_WEIGHTS[level] ?? LEVEL_WEIGHTS.info;
  const current = LEVEL_WEIGHTS[CURRENT_LEVEL] ?? LEVEL_WEIGHTS.info;
  return weight <= current;
}

function logLine(level, scope, args) {
  if (!shouldLog(level)) return;

  const color = LEVEL_COLORS[level] || COLORS.gray;
  const label = LEVEL_LABELS[level] || level.toUpperCase().padEnd(5, ' ');
  const scopeText = scope ? `[${scope}]` : '';
  const line = `${COLORS.gray}${timestamp()}${COLORS.reset} ${color}${label}${COLORS.reset} ${COLORS.blue}${scopeText}${COLORS.reset} ${formatArgs(args)}`.trim();

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
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
    child: (childScope) => createLogger(childScope ? `${scoped}:${childScope}` : scoped),
  };
}

module.exports = {
  createLogger,
};
