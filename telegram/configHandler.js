/**
 * Telegram Config Handler
 * 
 * Provides /config commands for managing runtime configuration via Telegram.
 * Changes are stored in Redis and propagated to all instances via pub/sub.
 * 
 * Commands:
 *   /config              - List all config with current values
 *   /config list         - Same as above
 *   /config get <key>    - Get details for a specific key
 *   /config set <key> <value> - Set a config value
 *   /config reset <key>  - Reset to env/default value
 */

const { getConfigService } = require('../shared/config/configService');
const { getSchema } = require('../shared/config/configSchema');
const { escapeV2, codeV2, boldV2 } = require('./messages/helpers');
const { createLogger } = require('../logger');

const log = createLogger('config-handler');

/**
 * Format a single config item for display
 */
function formatConfigItem(item) {
  const sourceIcon = {
    redis: '🔴',
    env: '🟡',
    default: '⚪'
  }[item.source] || '❓';

  let valueDisplay = item.value;
  if (valueDisplay === '' || valueDisplay === undefined || valueDisplay === null) {
    valueDisplay = '(not set)';
  } else if (typeof valueDisplay === 'string' && valueDisplay.length > 50) {
    valueDisplay = valueDisplay.slice(0, 47) + '...';
  }

  return `${sourceIcon} ${codeV2(item.key)}: ${codeV2(String(valueDisplay))}`;
}

/**
 * Format config list grouped by category
 */
function formatConfigList(items) {
  const byCategory = {};
  
  for (const item of items) {
    const cat = item.category || 'other';
    if (!byCategory[cat]) {
      byCategory[cat] = [];
    }
    byCategory[cat].push(item);
  }

  const lines = [
    boldV2('⚙️ Configuration'),
    '',
    `${escapeV2('Legend: 🔴 Redis | 🟡 Env | ⚪ Default')}`,
    ''
  ];

  const categoryOrder = ['batch', 'proxy', 'forward', 'cache', 'worker', 'logging'];
  const categoryNames = {
    batch: '📦 Batch Processing',
    proxy: '🌐 Proxy',
    forward: '📤 Forwarding',
    cache: '💾 Cache',
    worker: '👷 Worker',
    logging: '📝 Logging'
  };

  for (const cat of categoryOrder) {
    if (byCategory[cat] && byCategory[cat].length > 0) {
      lines.push(boldV2(categoryNames[cat] || cat));
      for (const item of byCategory[cat]) {
        lines.push(formatConfigItem(item));
      }
      lines.push('');
    }
  }

  lines.push(escapeV2('Use /config get <key> for details'));
  lines.push(escapeV2('Use /config set <key> <value> to change'));

  return lines.join('\n');
}

/**
 * Format detailed view of a single config key
 */
function formatConfigDetail(key, item) {
  const schema = getSchema(key);
  if (!schema) {
    return `${escapeV2('Unknown key:')} ${codeV2(key)}`;
  }

  const lines = [
    boldV2(`⚙️ ${key}`),
    '',
    `${boldV2('Value:')} ${codeV2(String(item.value ?? '(not set)'))}`,
    `${boldV2('Source:')} ${escapeV2(item.source)}`,
    `${boldV2('Type:')} ${escapeV2(schema.type)}`,
  ];

  if (schema.min !== undefined || schema.max !== undefined) {
    lines.push(`${boldV2('Range:')} ${escapeV2(`${schema.min ?? '∞'} - ${schema.max ?? '∞'}`)}`);
  }

  if (schema.values) {
    lines.push(`${boldV2('Values:')} ${escapeV2(schema.values.join(', '))}`);
  }

  lines.push(`${boldV2('Default:')} ${codeV2(String(schema.default ?? '(none)'))}`);
  lines.push('');
  lines.push(escapeV2(schema.description || 'No description'));

  return lines.join('\n');
}

/**
 * Register config handler commands on the bot
 * @param {Telegraf} bot - Telegraf bot instance
 * @param {function} getRedisClient - Function to get Redis client
 */
function registerConfigHandler(bot, getRedisClient) {
  // Main /config command
  bot.command('config', async (ctx) => {
    try {
      const text = ctx.message.text.trim();
      const parts = text.split(/\s+/).slice(1); // Remove '/config'
      const subCommand = parts[0]?.toLowerCase();

      const configService = getConfigService();
      
      if (!configService.isInitialized()) {
        await ctx.reply('⚠️ Config service not initialized. Redis may be unavailable.', {
          parse_mode: 'MarkdownV2'
        });
        return;
      }

      // /config or /config list
      if (!subCommand || subCommand === 'list') {
        const items = configService.list();
        const message = formatConfigList(items);
        await ctx.reply(message, { parse_mode: 'MarkdownV2' });
        return;
      }

      // /config get <key>
      if (subCommand === 'get') {
        const key = parts[1]?.toUpperCase();
        if (!key) {
          await ctx.reply(escapeV2('Usage: /config get <KEY>'), { parse_mode: 'MarkdownV2' });
          return;
        }

        const schema = getSchema(key);
        if (!schema) {
          await ctx.reply(`${escapeV2('Unknown key:')} ${codeV2(key)}`, { parse_mode: 'MarkdownV2' });
          return;
        }

        const item = configService.getWithSource(key);
        const message = formatConfigDetail(key, item);
        await ctx.reply(message, { parse_mode: 'MarkdownV2' });
        return;
      }

      // /config set <key> <value>
      if (subCommand === 'set') {
        const key = parts[1]?.toUpperCase();
        const value = parts.slice(2).join(' ');

        if (!key) {
          await ctx.reply(escapeV2('Usage: /config set <KEY> <VALUE>'), { parse_mode: 'MarkdownV2' });
          return;
        }

        const schema = getSchema(key);
        if (!schema) {
          await ctx.reply(`${escapeV2('Unknown key:')} ${codeV2(key)}`, { parse_mode: 'MarkdownV2' });
          return;
        }

        const result = await configService.set(key, value);
        
        if (result.success) {
          const lines = [
            boldV2('✅ Config Updated'),
            '',
            `${boldV2('Key:')} ${codeV2(key)}`,
            `${boldV2('Value:')} ${codeV2(String(result.value))}`,
            '',
            escapeV2('Change propagated to all instances.')
          ];
          await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
        } else {
          await ctx.reply(`❌ ${escapeV2(result.error)}`, { parse_mode: 'MarkdownV2' });
        }
        return;
      }

      // /config reset <key>
      if (subCommand === 'reset') {
        const key = parts[1]?.toUpperCase();
        
        if (!key) {
          await ctx.reply(escapeV2('Usage: /config reset <KEY>'), { parse_mode: 'MarkdownV2' });
          return;
        }

        const schema = getSchema(key);
        if (!schema) {
          await ctx.reply(`${escapeV2('Unknown key:')} ${codeV2(key)}`, { parse_mode: 'MarkdownV2' });
          return;
        }

        const result = await configService.reset(key);
        
        if (result.success) {
          const lines = [
            boldV2('✅ Config Reset'),
            '',
            `${boldV2('Key:')} ${codeV2(key)}`,
            `${boldV2('Value:')} ${codeV2(String(result.value ?? '(default)'))}`,
            '',
            escapeV2('Reverted to env/default value.')
          ];
          await ctx.reply(lines.join('\n'), { parse_mode: 'MarkdownV2' });
        } else {
          await ctx.reply(`❌ ${escapeV2(result.error)}`, { parse_mode: 'MarkdownV2' });
        }
        return;
      }

      // Unknown subcommand - show help
      const helpLines = [
        boldV2('⚙️ Config Commands'),
        '',
        `${codeV2('/config')} ${escapeV2('- List all settings')}`,
        `${codeV2('/config get <KEY>')} ${escapeV2('- Get key details')}`,
        `${codeV2('/config set <KEY> <VALUE>')} ${escapeV2('- Update a setting')}`,
        `${codeV2('/config reset <KEY>')} ${escapeV2('- Reset to default')}`,
      ];
      await ctx.reply(helpLines.join('\n'), { parse_mode: 'MarkdownV2' });

    } catch (error) {
      log.error('Config command error', { error: error.message, stack: error.stack });
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  });

  log.info('Config handler registered');
}

module.exports = {
  registerConfigHandler
};
