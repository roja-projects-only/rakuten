/**
 * =============================================================================
 * BIO GENERATOR - BEHAVIORAL BIOMETRICS DATA GENERATOR
 * =============================================================================
 * 
 * Generates realistic behavioral biometrics data including:
 * - Keystroke dynamics (timing patterns)
 * - Mouse movements
 * - Click patterns
 * 
 * =============================================================================
 */

const { createLogger } = require('../../../logger');

const log = createLogger('bio-gen');

// Human-like typing speed ranges (milliseconds between keystrokes)
const TYPING_SPEED = {
  min: 40,
  max: 180,
  avgFast: 80,
  avgSlow: 120,
};

// Human-like mouse movement patterns
const MOUSE_MOVEMENT = {
  minDistance: 100,
  maxDistance: 500,
  minDuration: 200,
  maxDuration: 1500,
};

/**
 * Generates behavioral biometrics data for form interactions.
 * @param {Object} options - Generation options
 * @param {string} [options.username] - Username being typed
 * @param {string} [options.password] - Password being typed
 * @returns {Object} Bio data
 */
function generateBioData(options = {}) {
  const { username = '', password = '' } = options;
  
  const bio = {
    kp: generateKeypressCount(username, password), // Total keypress count
    mm: generateMouseMovementCount(), // Mouse movement count
    kt: generateKeystrokeTiming(username, password), // Keystroke timing
    mc: generateMouseClicks(), // Mouse click count
    ts: Date.now(), // Timestamp
  };
  
  log.debug('Generated bio data');
  return bio;
}

/**
 * Generates total keypress count.
 * @param {string} username - Username
 * @param {string} password - Password
 * @returns {number} Keypress count
 */
function generateKeypressCount(username, password) {
  // Count includes: username length + password length + potential backspaces/corrections
  const baseCount = username.length + password.length;
  const corrections = Math.floor(Math.random() * 3); // 0-2 corrections
  return baseCount + corrections;
}

/**
 * Generates mouse movement count.
 * @returns {number} Mouse movement count
 */
function generateMouseMovementCount() {
  // Typical form interaction includes 5-15 mouse movements
  return Math.floor(Math.random() * 10) + 5;
}

/**
 * Generates realistic keystroke timing patterns.
 * @param {string} username - Username
 * @param {string} password - Password
 * @returns {Array<number>} Array of inter-keystroke delays (ms)
 */
function generateKeystrokeTiming(username, password) {
  const timings = [];
  const fullText = username + password;
  
  for (let i = 0; i < fullText.length; i++) {
    // Add variation - longer pauses at word boundaries, faster within words
    const isWordBoundary = fullText[i] === '@' || fullText[i] === '.' || fullText[i] === '_';
    
    let delay;
    if (isWordBoundary) {
      // Longer pause at boundaries (100-250ms)
      delay = Math.floor(Math.random() * 150) + 100;
    } else {
      // Normal typing speed with variation
      const baseSpeed = Math.random() > 0.5 ? TYPING_SPEED.avgFast : TYPING_SPEED.avgSlow;
      const variation = Math.floor(Math.random() * 40) - 20;
      delay = Math.max(TYPING_SPEED.min, Math.min(TYPING_SPEED.max, baseSpeed + variation));
    }
    
    timings.push(delay);
  }
  
  return timings;
}

/**
 * Generates mouse click count and patterns.
 * @returns {Object} Mouse click data
 */
function generateMouseClicks() {
  return {
    count: Math.floor(Math.random() * 3) + 2, // 2-4 clicks (email field, password field, submit)
    avgInterval: Math.floor(Math.random() * 2000) + 1000, // 1-3s between clicks
  };
}

/**
 * Generates mouse movement trajectory (coordinates and timings).
 * @param {Object} options - Movement options
 * @param {Object} options.from - Starting position {x, y}
 * @param {Object} options.to - Ending position {x, y}
 * @returns {Array<Object>} Array of movement points with timestamps
 */
function generateMouseTrajectory(options = {}) {
  const {
    from = { x: 100, y: 100 },
    to = { x: 500, y: 300 },
  } = options;
  
  const trajectory = [];
  const distance = Math.sqrt(
    Math.pow(to.x - from.x, 2) + Math.pow(to.y - from.y, 2)
  );
  
  // Number of intermediate points based on distance
  const steps = Math.max(5, Math.floor(distance / 50));
  const duration = Math.random() * 
    (MOUSE_MOVEMENT.maxDuration - MOUSE_MOVEMENT.minDuration) + 
    MOUSE_MOVEMENT.minDuration;
  
  for (let i = 0; i <= steps; i++) {
    const progress = i / steps;
    
    // Add slight curve to make movement more natural (ease-in-out)
    const eased = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    
    // Add small random variations
    const noise = (Math.random() - 0.5) * 10;
    
    trajectory.push({
      x: from.x + (to.x - from.x) * eased + noise,
      y: from.y + (to.y - from.y) * eased + noise,
      t: Math.floor((duration * progress)),
    });
  }
  
  return trajectory;
}

/**
 * Simulates human delay between actions.
 * @param {number} minMs - Minimum delay
 * @param {number} maxMs - Maximum delay
 * @returns {Promise<void>}
 */
async function humanDelay(minMs = 100, maxMs = 500) {
  const delay = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}

module.exports = {
  generateBioData,
  generateKeystrokeTiming,
  generateMouseTrajectory,
  humanDelay,
  TYPING_SPEED,
  MOUSE_MOVEMENT,
};
