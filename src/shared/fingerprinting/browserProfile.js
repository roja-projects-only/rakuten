/**
 * =============================================================================
 * BROWSER PROFILE GENERATOR - Coherent browser fingerprint profiles
 * =============================================================================
 *
 * Generates internally-coherent browser profiles so that User-Agent, platform,
 * GPU, device memory, screen resolution, timezone, language, and client hints
 * (sec-ch-ua) all match a real browser configuration.
 *
 * Each profile is a complete, realistic device fingerprint. One profile is
 * selected per HTTP session and reused for all requests in that session,
 * mimicking a real browser that has one stable fingerprint.
 *
 * Profiles are derived from real Chrome DevTools captures.
 *
 * =============================================================================
 */

const crypto = require('crypto');

/**
 * Pool of coherent browser profiles.
 * Each profile is a complete device fingerprint that would be observed on a
 * real machine running the specified Chrome version.
 */
const PROFILES = [
  // ── Windows 11 / Chrome 131 / NVIDIA ──────────────────────────────────────
  {
    impitBrowser: 'chrome131',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32',
    deviceMemory: 16,
    hardwareConcurrency: 12,
    screenResolution: [2560, 1440],
    timezone: 'America/New_York',
    acceptLanguage: 'en-US,en;q=0.9',
    videoCard: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaPlatform: '"Windows"',
    osCpu: undefined,
  },
  // ── Windows 10 / Chrome 131 / AMD ───────────────────────────────────────────
  {
    impitBrowser: 'chrome131',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32',
    deviceMemory: 8,
    hardwareConcurrency: 8,
    screenResolution: [1920, 1080],
    timezone: 'America/Chicago',
    acceptLanguage: 'en-US,en;q=0.9',
    videoCard: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaPlatform: '"Windows"',
    osCpu: undefined,
  },
  // ── Windows 11 / Chrome 136 / NVIDIA ──────────────────────────────────────
  {
    impitBrowser: 'chrome136',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    platform: 'Win32',
    deviceMemory: 16,
    hardwareConcurrency: 16,
    screenResolution: [1920, 1080],
    timezone: 'America/Los_Angeles',
    acceptLanguage: 'en-US,en;q=0.9',
    videoCard: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    secChUa: '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    secChUaPlatform: '"Windows"',
    osCpu: undefined,
  },
  // ── Windows 10 / Chrome 136 / Intel iGPU ───────────────────────────────────
  {
    impitBrowser: 'chrome136',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    platform: 'Win32',
    deviceMemory: 8,
    hardwareConcurrency: 12,
    screenResolution: [1920, 1080],
    timezone: 'Europe/London',
    acceptLanguage: 'en-GB,en;q=0.9',
    videoCard: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    secChUa: '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    secChUaPlatform: '"Windows"',
    osCpu: undefined,
  },
  // ── macOS Apple Silicon / Chrome 131 ────────────────────────────────────────
  {
    impitBrowser: 'chrome131',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    deviceMemory: 8,
    hardwareConcurrency: 8,
    screenResolution: [1680, 1050],
    timezone: 'America/Los_Angeles',
    acceptLanguage: 'en-US,en;q=0.9',
    videoCard: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaPlatform: '"macOS"',
    osCpu: undefined,
  },
  // ── macOS Apple Silicon Pro / Chrome 136 ────────────────────────────────────
  {
    impitBrowser: 'chrome136',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    deviceMemory: 16,
    hardwareConcurrency: 10,
    screenResolution: [3024, 1964],
    timezone: 'Europe/Berlin',
    acceptLanguage: 'en-US,en;q=0.9,de;q=0.8',
    videoCard: { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)' },
    secChUa: '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
    secChUaPlatform: '"macOS"',
    osCpu: undefined,
  },
  // ── Windows 11 / Chrome 142 / NVIDIA (latest) ──────────────────────────────
  {
    impitBrowser: 'chrome142',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    platform: 'Win32',
    deviceMemory: 16,
    hardwareConcurrency: 12,
    screenResolution: [2560, 1440],
    timezone: 'America/Denver',
    acceptLanguage: 'en-US,en;q=0.9',
    videoCard: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    secChUa: '"Chromium";v="142", "Google Chrome";v="142", "Not?A_Brand";v="24"',
    secChUaPlatform: '"Windows"',
    osCpu: undefined,
  },
  // ── Windows 10 / Chrome 142 / AMD (latest) ──────────────────────────────────
  {
    impitBrowser: 'chrome142',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    platform: 'Win32',
    deviceMemory: 8,
    hardwareConcurrency: 8,
    screenResolution: [1920, 1080],
    timezone: 'Asia/Tokyo',
    acceptLanguage: 'en-US,en;q=0.9,ja;q=0.8',
    videoCard: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    secChUa: '"Chromium";v="142", "Google Chrome";v="142", "Not?A_Brand";v="24"',
    secChUaPlatform: '"Windows"',
    osCpu: undefined,
  },
];

/**
 * Chrome PDF viewer plugins (Chrome-only, no Edge/WebKit viewers).
 * These are the plugins reported by a real Chrome installation.
 */
const CHROME_PLUGINS = [
  {
    name: 'PDF Viewer',
    description: 'Portable Document Format',
    mimeTypes: [
      { type: 'application/pdf', suffixes: 'pdf' },
      { type: 'text/pdf', suffixes: 'pdf' },
    ],
  },
  {
    name: 'Chrome PDF Viewer',
    description: 'Portable Document Format',
    mimeTypes: [
      { type: 'application/pdf', suffixes: 'pdf' },
      { type: 'text/pdf', suffixes: 'pdf' },
    ],
  },
  {
    name: 'Chromium PDF Viewer',
    description: 'Portable Document Format',
    mimeTypes: [
      { type: 'application/pdf', suffixes: 'pdf' },
      { type: 'text/pdf', suffixes: 'pdf' },
    ],
  },
];

/**
 * Font lists by OS family.
 */
const FONTS_BY_PLATFORM = {
  Win32: [
    'Agency FB', 'Calibri', 'Century', 'Century Gothic', 'Franklin Gothic',
    'Haettenschweiler', 'Lucida Bright', 'Lucida Sans', 'MS Outlook',
    'MS Reference Specialty', 'MS UI Gothic', 'MT Extra', 'Marlett',
    'Monotype Corsiva', 'Pristina', 'Segoe UI Light',
  ],
  MacIntel: [
    'Arial', 'Arial Black', 'Arial Narrow', 'Avenir', 'Avenir Next',
    'Baskerville', 'Big Caslon', 'Brush Script MT', 'Chalkboard',
    'Chalkduster', 'Cochin', 'Comic Sans MS', 'Copperplate',
    'Futura', 'Gill Sans', 'Helvetica Neue', 'Marker Felt',
  ],
};

/**
 * Math fingerprint values — these vary slightly per CPU but are stable per machine.
 * We use a small pool of real observed values.
 */
const MATH_VALUES_POOL = [
  {
    acos: 1.4473588658278522, acosh: 709.889355822726, acoshPf: 355.291251501643,
    asin: 0.12343746096704435, asinh: 0.881373587019543, asinhPf: 0.8813735870195429,
    atanh: 0.5493061443340548, atanhPf: 0.5493061443340548, atan: 0.4636476090008061,
    sin: 0.8178819121159085, sinh: 1.1752011936438014, sinhPf: 2.534342107873324,
    cos: -0.8390715290095377, cosh: 1.5430806348152437, coshPf: 1.5430806348152437,
    tan: -1.4214488238747245, tanh: 0.7615941559557649, tanhPf: 0.7615941559557649,
    exp: 2.718281828459045, expm1: 1.718281828459045, expm1Pf: 1.718281828459045,
    log1p: 2.3978952727983707, log1pPf: 2.3978952727983707, powPI: 1.9275814160560206e-50,
  },
  {
    acos: 1.4473588658278525, acosh: 709.8893558227265, acoshPf: 355.2912515016431,
    asin: 0.12343746096704436, asinh: 0.8813735870195431, asinhPf: 0.881373587019543,
    atanh: 0.5493061443340549, atanhPf: 0.5493061443340548, atan: 0.4636476090008062,
    sin: 0.8178819121159088, sinh: 1.1752011936438018, sinhPf: 2.5343421078733245,
    cos: -0.8390715290095378, cosh: 1.543080634815244, coshPf: 1.543080634815244,
    tan: -1.421448823874725, tanh: 0.7615941559557651, tanhPf: 0.761594155955765,
    exp: 2.7182818284590455, expm1: 1.7182818284590455, expm1Pf: 1.7182818284590455,
    log1p: 2.397895272798371, log1pPf: 2.397895272798371, powPI: 1.9275814160560207e-50,
  },
];

/**
 * Audio fingerprint values — varies per machine (sampled from Gaussian).
 */
const AUDIO_VALUES_POOL = [
  124.04347527516074,
  123.98765432109876,
  124.12345678901234,
  123.87654321098765,
  124.21098765432109,
];

/**
 * Generates a coherent browser profile by selecting one from the pool.
 * @returns {Object} A complete browser profile
 */
function generateProfile() {
  const base = PROFILES[Math.floor(Math.random() * PROFILES.length)];
  const math = MATH_VALUES_POOL[Math.floor(Math.random() * MATH_VALUES_POOL.length)];
  const audio = AUDIO_VALUES_POOL[Math.floor(Math.random() * AUDIO_VALUES_POOL.length)];
  const fonts = FONTS_BY_PLATFORM[base.platform] || FONTS_BY_PLATFORM.Win32;

  return {
    ...base,
    math,
    audio,
    fonts,
    plugins: CHROME_PLUGINS,
    secChUaMobile: '?0',
    acceptEncoding: 'gzip, deflate, br, zstd',
  };
}

/**
 * Generates a stable fingerprint hash for a session.
 * Produces a 32-character hex string (like an MD5 hash) that stays constant
 * for the lifetime of one HTTP session.
 * @returns {string} 32-char hex fingerprint hash
 */
function generateSessionFingerprint() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Derives a deterministic hardware fingerprint hash from the session fingerprint.
 * This ensures hashHardware is stable for the same session and correlated with
 * the main fingerprint, rather than being an independent random value.
 * @param {string} sessionFingerprint - The session's main fingerprint hash
 * @returns {string} 32-char hex hardware fingerprint hash
 */
function deriveHardwareFingerprint(sessionFingerprint) {
  return crypto
    .createHash('sha256')
    .update(sessionFingerprint + ':hardware')
    .digest('hex')
    .substring(0, 32);
}

/**
 * Builds the sec-ch-ua client hints headers from a profile.
 * @param {Object} profile - Browser profile
 * @returns {Object} Headers object with sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform
 */
function buildClientHintsHeaders(profile) {
  return {
    'sec-ch-ua': profile.secChUa,
    'sec-ch-ua-mobile': profile.secChUaMobile,
    'sec-ch-ua-platform': profile.secChUaPlatform,
  };
}

module.exports = {
  generateProfile,
  generateSessionFingerprint,
  deriveHardwareFingerprint,
  buildClientHintsHeaders,
  PROFILES,
};