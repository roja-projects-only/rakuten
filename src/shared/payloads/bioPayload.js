/**
 * =============================================================================
 * BIO PAYLOAD - Biometric/interaction data payload builder
 * =============================================================================
 *
 * Generates bio data matching the real request format.
 * Simulates user interaction metrics (keypresses, mouse clicks, movements).
 *
 * =============================================================================
 */

/**
 * Generates bio data matching the real request format.
 * @param {number} startTime - Start timestamp (ms since epoch) from session start
 * @returns {Object} Bio payload
 */
function generateRealBioData(startTime) {
  const now = Date.now();
  return {
    kp: Math.floor(Math.random() * 20) + 10, // keypresses
    mc: Math.floor(Math.random() * 3) + 1,   // mouse clicks
    mm: Math.floor(Math.random() * 50) + 20, // mouse movements
    start_time: startTime,
    ts: now - startTime, // elapsed milliseconds since session start
  };
}

module.exports = { generateRealBioData };