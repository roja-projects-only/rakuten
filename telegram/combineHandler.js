const { Markup } = require('telegraf');
const { parseColonCredential, isAllowedHotmailUser } = require('../automation/batch/parse');
const { createLogger } = require('../logger');
const {
  escapeV2,
  codeV2,
  boldV2,
  formatBytes,
  buildBatchParseFailed,
} = require('./messages');

const log = createLogger('combine');

// In-memory store for combine sessions per chat
const combineSessions = new Map(); // chatId -> { files: [], createdAt }

// Session TTL (30 minutes)
const SESSION_TTL_MS = 30 * 60 * 1000;

// Max files per session
const MAX_FILES = 20;

// Telegram file limit
const TELEGRAM_FILE_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * Creates or retrieves a combine session for a chat
 */
function getOrCreateSession(chatId) {
  let session = combineSessions.get(chatId);
  
  // Check if session expired
  if (session && Date.now() - session.createdAt > SESSION_TTL_MS) {
    combineSessions.delete(chatId);
    session = null;
  }
  
  if (!session) {
    session = {
      files: [],
      createdAt: Date.now(),
    };
    combineSessions.set(chatId, session);
  }
  
  return session;
}

/**
 * Checks if a combine session exists
 */
function hasSession(chatId) {
  const session = combineSessions.get(chatId);
  if (!session) return false;
  
  // Check if expired
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    combineSessions.delete(chatId);
    return false;
  }
  
  return true;
}

/**
 * Clears a combine session
 */
function clearSession(chatId) {
  combineSessions.delete(chatId);
}

/**
 * Add file to session
 */
function addFileToSession(chatId, fileData) {
  const session = getOrCreateSession(chatId);
  if (session.files.length >= MAX_FILES) {
    return { success: false, error: `Maximum ${MAX_FILES} files allowed per session` };
  }
  session.files.push(fileData);
  return { success: true, count: session.files.length };
}

/**
 * Build combine prompt message
 */
function buildCombinePrompt() {
  return (
    '📦 ' + boldV2('Combine Mode Active') +
    '\n\n' + escapeV2('Send files to combine them together.') +
    '\n\n' + boldV2('Instructions:') +
    '\n• Send credential files one by one' +
    '\n• Files will be combined and deduped' +
    '\n• Use /done when finished' +
    '\n• Use /cancel to exit combine mode' +
    '\n\n' + escapeV2(`Max files: ${MAX_FILES}`) +
    '\n' + escapeV2(`Session expires in 30 minutes`)
  );
}

/**
 * Build file added message
 */
function buildFileAdded({ filename, size, totalFiles, totalSize }) {
  return (
    '✅ ' + boldV2('File Added') +
    `\n• Name: ${codeV2(filename)}` +
    `\n• Size: ${escapeV2(formatBytes(size))}` +
    '\n\n' + boldV2('Session') +
    `\n• Files: ${codeV2(String(totalFiles))}` +
    `\n• Total size: ${escapeV2(formatBytes(totalSize))}` +
    '\n\n' + escapeV2('Send more files or /done to process')
  );
}

/**
 * Build combine summary before processing
 */
function buildCombineSummary({ fileCount, totalSize, credentialCount, duplicatesRemoved }) {
  return (
    '📊 ' + boldV2('Combined Files Summary') +
    '\n\n' + boldV2('Files') +
    `\n• Count: ${codeV2(String(fileCount))}` +
    `\n• Total size: ${escapeV2(formatBytes(totalSize))}` +
    '\n\n' + boldV2('Credentials') +
    `\n• Total found: ${codeV2(String(credentialCount + duplicatesRemoved))}` +
    `\n• Duplicates removed: ${codeV2(String(duplicatesRemoved))}` +
    `\n• Unique: ${codeV2(String(credentialCount))}` +
    '\n\n' + escapeV2('Choose processing type:')
  );
}

/**
 * Build processing type selection
 */
function buildProcessingChoice() {
  return (
    escapeV2('Choose how to filter credentials:') +
    '\n\n' + '📧 ' + boldV2('HOTMAIL') + escapeV2(' - .jp Microsoft domains') +
    '\n' + '📄 ' + boldV2('ULP') + escapeV2(' - Rakuten domain filter') +
    '\n' + '🇯🇵 ' + boldV2('JP Domains') + escapeV2(' - Any *.jp domain') +
    '\n' + '📋 ' + boldV2('ALL') + escapeV2(' - No filtering')
  );
}

/**
 * Build no files message
 */
function buildNoFiles() {
  return escapeV2('⚠️ No files in session. Send files first, then use /done.');
}

/**
 * Build session cleared message
 */
function buildSessionCleared() {
  return escapeV2('❎ Combine session cleared.');
}

/**
 * Build not in combine mode message
 */
function buildNotInCombineMode() {
  return escapeV2('⚠️ Not in combine mode. Use /combine to start.');
}

/**
 * Build processing message
 */
function buildCombineProcessing() {
  return escapeV2('⏳ Processing combined files...');
}

/**
 * Parse credentials from text content
 */
function parseCredentialsFromText(text) {
  const lines = text.split(/\r?\n/);
  const creds = [];
  
  for (const line of lines) {
    const parsed = parseColonCredential(line, { allowPrefix: true });
    if (parsed) {
      creds.push({
        username: parsed.user,
        password: parsed.pass,
      });
    }
  }
  
  return creds;
}

/**
 * Dedupe credentials by username:password
 */
function dedupeCredentials(creds) {
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  
  for (const cred of creds) {
    const key = `${cred.username.toLowerCase()}:${cred.password}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(cred);
    } else {
      duplicates++;
    }
  }
  
  return { unique, duplicates };
}

/**
 * Filter credentials by type
 */
function filterCredentials(creds, type) {
  switch (type) {
    case 'hotmail':
      return creds.filter(c => isAllowedHotmailUser(c.username));
    
    case 'ulp':
      return creds.filter(c => {
        const domain = c.username.split('@')[1];
        return domain && domain.toLowerCase().includes('rakuten');
      });
    
    case 'jp':
      return creds.filter(c => {
        const domain = c.username.split('@')[1];
        return domain && domain.toLowerCase().endsWith('.jp');
      });
    
    case 'all':
    default:
      return creds;
  }
}

/**
 * Download and parse all files in session
 */
async function processSessionFiles(ctx, session) {
  const allCreds = [];
  
  for (const file of session.files) {
    try {
      const response = await fetch(file.fileUrl);
      if (!response.ok) {
        log.warn(`Failed to download file: ${file.filename}`);
        continue;
      }
      const text = await response.text();
      const creds = parseCredentialsFromText(text);
      allCreds.push(...creds);
      log.debug(`Parsed ${creds.length} credentials from ${file.filename}`);
    } catch (err) {
      log.warn(`Error processing file ${file.filename}: ${err.message}`);
    }
  }
  
  return allCreds;
}

/**
 * Register combine handlers
 */
function registerCombineHandlers(bot, options, helpers) {
  const checkCredentials = options.checkCredentials;

  // /combine command - start combine mode
  bot.command('combine', async (ctx) => {
    const chatId = ctx.chat.id;
    
    // Clear any existing session and start fresh
    clearSession(chatId);
    getOrCreateSession(chatId);
    
    log.info(`[combine] session started chatId=${chatId}`);
    
    await ctx.reply(buildCombinePrompt(), {
      parse_mode: 'MarkdownV2',
    });
  });

  // /done command - finish adding files and show options
  bot.command('done', async (ctx) => {
    const chatId = ctx.chat.id;
    
    if (!hasSession(chatId)) {
      await ctx.reply(buildNotInCombineMode(), { parse_mode: 'MarkdownV2' });
      return;
    }
    
    const session = combineSessions.get(chatId);
    if (!session.files.length) {
      await ctx.reply(buildNoFiles(), { parse_mode: 'MarkdownV2' });
      return;
    }
    
    // Send processing message
    const processingMsg = await ctx.reply(buildCombineProcessing(), { parse_mode: 'MarkdownV2' });
    
    try {
      // Download and parse all files
      const allCreds = await processSessionFiles(ctx, session);
      
      if (!allCreds.length) {
        await ctx.telegram.editMessageText(
          chatId,
          processingMsg.message_id,
          undefined,
          escapeV2('⚠️ No credentials found in the uploaded files.'),
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }
      
      // Dedupe credentials
      const { unique, duplicates } = dedupeCredentials(allCreds);
      
      // Store combined credentials in session
      session.combinedCreds = unique;
      session.totalRaw = allCreds.length;
      
      const totalSize = session.files.reduce((sum, f) => sum + (f.size || 0), 0);
      
      log.info(`[combine] processed files=${session.files.length} raw=${allCreds.length} unique=${unique.length} dupes=${duplicates}`);
      
      // Show summary with processing options
      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        buildCombineSummary({
          fileCount: session.files.length,
          totalSize,
          credentialCount: unique.length,
          duplicatesRemoved: duplicates,
        }),
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('📧 HOTMAIL', 'combine_type_hotmail'),
              Markup.button.callback('📄 ULP', 'combine_type_ulp'),
            ],
            [
              Markup.button.callback('🇯🇵 JP Domains', 'combine_type_jp'),
              Markup.button.callback('📋 ALL', 'combine_type_all'),
            ],
            [Markup.button.callback('⛔ Cancel', 'combine_cancel')],
          ]),
        }
      );
    } catch (err) {
      log.error(`[combine] processing failed: ${err.message}`);
      await ctx.telegram.editMessageText(
        chatId,
        processingMsg.message_id,
        undefined,
        buildBatchParseFailed(err.message),
        { parse_mode: 'MarkdownV2' }
      );
    }
  });

  // /cancel command in combine mode
  bot.command('cancel', async (ctx) => {
    const chatId = ctx.chat.id;
    
    if (hasSession(chatId)) {
      clearSession(chatId);
      log.info(`[combine] session cancelled chatId=${chatId}`);
      await ctx.reply(buildSessionCleared(), { parse_mode: 'MarkdownV2' });
    }
  });

  // Handle combine type selection callbacks
  const handleCombineType = async (ctx, type) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id;
    
    const session = combineSessions.get(chatId);
    if (!session || !session.combinedCreds) {
      await ctx.reply(escapeV2('⚠️ Session expired. Use /combine to start again.'), {
        parse_mode: 'MarkdownV2',
      });
      return;
    }
    
    // Filter credentials based on type
    const filtered = filterCredentials(session.combinedCreds, type);
    
    if (!filtered.length) {
      const typeLabels = {
        hotmail: 'Microsoft .jp',
        ulp: 'Rakuten',
        jp: '.jp domain',
        all: 'valid',
      };
      await ctx.reply(escapeV2(`⚠️ No ${typeLabels[type]} credentials found after filtering.`), {
        parse_mode: 'MarkdownV2',
      });
      return;
    }
    
    log.info(`[combine] type=${type} filtered=${filtered.length}/${session.combinedCreds.length}`);
    
    // Store batch data
    const batchKey = `combine_${chatId}_${Date.now()}`;
    session.pendingBatch = {
      key: batchKey,
      creds: filtered,
      type,
      count: filtered.length,
      filename: `combined_${session.files.length}_files`,
    };
    
    const typeEmoji = { hotmail: '📧', ulp: '📄', jp: '🇯🇵', all: '📋' };
    const typeLabel = { hotmail: 'HOTMAIL', ulp: 'ULP', jp: 'JP Domains', all: 'ALL' };
    
    // Update message with confirmation
    try {
      await ctx.telegram.editMessageText(
        chatId,
        ctx.update.callback_query.message.message_id,
        undefined,
        `${typeEmoji[type]} ${boldV2(`${typeLabel[type]} Mode`)}\n\n` +
        `${boldV2('Ready to process')}\n` +
        `• Credentials: ${codeV2(String(filtered.length))}\n` +
        `• Source: ${codeV2(`${session.files.length} combined files`)}\n\n` +
        escapeV2('Start batch check?'),
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Proceed', `combine_confirm_${type}`),
              Markup.button.callback('⛔ Cancel', 'combine_cancel'),
            ],
          ]),
        }
      );
    } catch (err) {
      log.warn(`Failed to update combine message: ${err.message}`);
    }
  };

  bot.action('combine_type_hotmail', (ctx) => handleCombineType(ctx, 'hotmail'));
  bot.action('combine_type_ulp', (ctx) => handleCombineType(ctx, 'ulp'));
  bot.action('combine_type_jp', (ctx) => handleCombineType(ctx, 'jp'));
  bot.action('combine_type_all', (ctx) => handleCombineType(ctx, 'all'));

  bot.action('combine_cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    const chatId = ctx.chat.id;
    
    clearSession(chatId);
    
    try {
      await ctx.telegram.editMessageText(
        chatId,
        ctx.update.callback_query.message.message_id,
        undefined,
        buildSessionCleared(),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (_) {
      await ctx.reply(buildSessionCleared(), { parse_mode: 'MarkdownV2' });
    }
  });

  // Confirm and start batch
  bot.action(/combine_confirm_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const type = ctx.match[1];
    const chatId = ctx.chat.id;
    
    const session = combineSessions.get(chatId);
    if (!session || !session.pendingBatch) {
      await ctx.reply(escapeV2('⚠️ Session expired. Use /combine to start again.'), {
        parse_mode: 'MarkdownV2',
      });
      return;
    }
    
    const batch = session.pendingBatch;
    
    // Import and use runBatchExecution from batchHandlers
    // Instead of duplicating, we'll emit a custom event or call the batch processor directly
    const { runCombineBatch } = require('./combineBatchRunner');
    
    await runCombineBatch(ctx, batch, options, helpers, checkCredentials);
    
    // Clear session after starting
    clearSession(chatId);
  });

  // Handle abort for combine batch
  bot.action(/combine_abort_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Aborting...');
    const chatId = parseInt(ctx.match[1], 10);
    
    const { abortCombineBatch } = require('./combineBatchRunner');
    if (abortCombineBatch(chatId)) {
      log.info(`[combine] abort requested chatId=${chatId}`);
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          ctx.update.callback_query.message.message_id,
          undefined,
          escapeV2('⏹ Aborting combine batch, please wait...'),
          { parse_mode: 'MarkdownV2' }
        );
      } catch (_) {}
    } else {
      await ctx.reply(escapeV2('⚠️ No active combine batch to abort.'), {
        parse_mode: 'MarkdownV2',
      });
    }
  });

  return {
    hasSession,
    addFileToSession,
    getSession: (chatId) => combineSessions.get(chatId),
  };
}

module.exports = {
  registerCombineHandlers,
  hasSession,
  addFileToSession,
  clearSession,
  getOrCreateSession,
  TELEGRAM_FILE_LIMIT_BYTES,
};
