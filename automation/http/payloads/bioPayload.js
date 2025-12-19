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
 * @param {number} startTime - Start timestamp
 * @returns {Object} Bio payload
 */
function generateRealBioData(startTime) {
  return {
    kp: Math.floor(Math.random() * 20) + 10, // keypresses
    mc: Math.floor(Math.random() * 3) + 1,   // mouse clicks
    mm: Math.floor(Math.random() * 50) + 20, // mouse movements
    start_time: startTime,
    ts: 0,
  };
}

module.exports = { generateRealBioData };

