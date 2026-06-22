/**
 * =============================================================================
 * RAT PAYLOAD - Rakuten Analytics Tracking fingerprint data
 * =============================================================================
 *
 * Generates full RAT fingerprint data for login requests.
 * Structure captured from real Chrome DevTools requests - Dec 2025.
 * Values are parameterized by a coherent browser profile so that UA, platform,
 * GPU, memory, screen, timezone, and language are internally consistent.
 *
 * =============================================================================
 */

const { deriveHardwareFingerprint } = require('../fingerprinting/browserProfile');

/**
 * Generates full RAT (Rakuten Analytics Tracking) fingerprint data.
 * @param {string} correlationId - Correlation ID for request
 * @param {string} fingerprint - Session-stable fingerprint hash
 * @param {Object} profile - Coherent browser profile from browserProfile.generateProfile()
 * @returns {Object} Full RAT payload
 */
function generateFullRatData(correlationId, fingerprint, profile) {
  const p = profile || {};
  const fonts = p.fonts || [];
  const videoCard = p.videoCard || { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' };
  const math = p.math || {};
  const audio = p.audio || 124.04347527516074;
  const plugins = p.plugins || [];

  return {
    components: {
      fonts: {
        value: fonts,
        duration: Math.floor(Math.random() * 20) + 80,
      },
      domBlockers: { duration: Math.floor(Math.random() * 20) + 70 },
      fontPreferences: {
        value: {
          default: 149.3125, apple: 149.3125, serif: 149.3125, sans: 144.015625,
          mono: 121.515625, min: 9.34375, system: 147.859375
        },
        duration: Math.floor(Math.random() * 20) + 75,
      },
      audio: { value: audio, duration: 1 },
      screenFrame: { value: [0, 0, 0, 0], duration: 0 },
      osCpu: { duration: 0 },
      languages: { value: [[p.acceptLanguage ? p.acceptLanguage.split(',')[0] : 'en-US']], duration: 0 },
      colorDepth: { value: 24, duration: 0 },
      deviceMemory: { value: p.deviceMemory || 8, duration: 0 },
      screenResolution: { value: p.screenResolution || [1920, 1080], duration: 0 },
      hardwareConcurrency: { value: p.hardwareConcurrency || 12, duration: 0 },
      timezone: { value: p.timezone || 'America/New_York', duration: 4 },
      sessionStorage: { value: true, duration: 0 },
      localStorage: { value: true, duration: 0 },
      indexedDB: { value: true, duration: 0 },
      openDatabase: { value: false, duration: 0 },
      cpuClass: { duration: 0 },
      platform: { value: p.platform || 'Win32', duration: 0 },
      plugins: {
        value: plugins.map((pl) => ({
          name: pl.name,
          description: pl.description,
          mimeTypes: pl.mimeTypes,
        })),
        duration: 0,
      },
      touchSupport: { value: { maxTouchPoints: 0, touchEvent: false, touchStart: false }, duration: 0 },
      vendor: { value: 'Google Inc.', duration: 0 },
      vendorFlavors: { value: ['chrome'], duration: 0 },
      cookiesEnabled: { value: true, duration: 0 },
      colorGamut: { value: 'srgb', duration: 0 },
      invertedColors: { duration: 0 },
      forcedColors: { value: false, duration: 0 },
      monochrome: { value: 0, duration: 0 },
      contrast: { value: 0, duration: 0 },
      reducedMotion: { value: false, duration: 0 },
      hdr: { value: false, duration: 0 },
      math: {
        value: {
          acos: math.acos || 1.4473588658278522,
          acosh: math.acosh || 709.889355822726,
          acoshPf: math.acoshPf || 355.291251501643,
          asin: math.asin || 0.12343746096704435,
          asinh: math.asinh || 0.881373587019543,
          asinhPf: math.asinhPf || 0.8813735870195429,
          atanh: math.atanh || 0.5493061443340548,
          atanhPf: math.atanhPf || 0.5493061443340548,
          atan: math.atan || 0.4636476090008061,
          sin: math.sin || 0.8178819121159085,
          sinh: math.sinh || 1.1752011936438014,
          sinhPf: math.sinhPf || 2.534342107873324,
          cos: math.cos || -0.8390715290095377,
          cosh: math.cosh || 1.5430806348152437,
          coshPf: math.coshPf || 1.5430806348152437,
          tan: math.tan || -1.4214488238747245,
          tanh: math.tanh || 0.7615941559557649,
          tanhPf: math.tanhPf || 0.7615941559557649,
          exp: math.exp || 2.718281828459045,
          expm1: math.expm1 || 1.718281828459045,
          expm1Pf: math.expm1Pf || 1.718281828459045,
          log1p: math.log1p || 2.3978952727983707,
          log1pPf: math.log1pPf || 2.3978952727983707,
          powPI: math.powPI || 1.9275814160560206e-50,
        },
        duration: 1,
      },
      videoCard: {
        value: {
          vendor: videoCard.vendor,
          renderer: videoCard.renderer,
        },
        duration: 5,
      },
      pdfViewerEnabled: { value: true, duration: 0 },
      architecture: { value: 255, duration: 0 },
      C_webRTC: {
        value: {
          mediaDevices: [{ kind: 'audioinput' }, { kind: 'audiooutput' }, { kind: 'videoinput' }],
          mediaCapabilities: {
            audio: [
              { channels: 2, mimeType: 'audio/opus', clockRates: [48000], feedbackSupport: ['transport-cc'], sdpFmtpLine: ['minptime=10', 'useinbandfec=1'] },
              { channels: 2, mimeType: 'audio/red', clockRates: [48000], sdpFmtpLine: ['111/111'] },
              { channels: 1, mimeType: 'audio/G722', clockRates: [8000] },
              { channels: 1, mimeType: 'audio/PCMU', clockRates: [8000] },
              { channels: 1, mimeType: 'audio/PCMA', clockRates: [8000] },
              { channels: 1, mimeType: 'audio/CN', clockRates: [8000] },
              { channels: 1, mimeType: 'audio/telephone-event', clockRates: [48000, 8000] }
            ],
            video: [
              { mimeType: 'video/VP8', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'] },
              { mimeType: 'video/rtx', clockRates: [90000] },
              { mimeType: 'video/VP9', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'], sdpFmtpLine: ['profile-id=0', 'profile-id=2', 'profile-id=1', 'profile-id=3'] },
              { mimeType: 'video/H264', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'], sdpFmtpLine: ['level-asymmetry-allowed=1', 'packetization-mode=1', 'profile-level-id=42001f', 'packetization-mode=0', 'profile-level-id=42e01f', 'profile-level-id=4d001f', 'profile-level-id=f4001f', 'profile-level-id=64001f'] },
              { mimeType: 'video/AV1', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'], sdpFmtpLine: ['level-idx=5', 'profile=0', 'tier=0', 'profile=1'] },
              { mimeType: 'video/H264', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'], sdpFmtpLine: ['level-asymmetry-allowed=1', 'packetization-mode=1', 'profile-level-id=64001f', 'packetization-mode=0'] },
              { mimeType: 'video/H265', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc', 'ccm fir', 'nack', 'nack pli'], sdpFmtpLine: ['level-id=180', 'profile-id=1', 'tier-flag=0', 'tx-mode=SRST', 'profile-id=2'] },
              { mimeType: 'video/red', clockRates: [90000] },
              { mimeType: 'video/ulpfec', clockRates: [90000] },
              { mimeType: 'video/flexfec-03', clockRates: [90000], feedbackSupport: ['goog-remb', 'transport-cc'], sdpFmtpLine: ['repair-window=10000000'] }
            ]
          }
        },
        duration: Math.floor(Math.random() * 100) + 500,
      },
      C_codecs: {
        value: [
          'video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.58A01E"',
          'video/mp4; codecs="avc1.4D401E"', 'video/mp4; codecs="avc1.640028"',
          'video/mp4; codecs="hev1.1.6.L93.B0"', 'video/mp4; codecs="hvc1.1.6.L93.B0"',
          'video/mp4; codecs="av01.0.01M.08"', 'video/webm; codecs="vp8"',
          'video/webm; codecs="vp9"', 'video/webm; codecs="av01.0.01M.08"',
          'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="mp4a.40.5"',
          'audio/mp4; codecs="mp4a.67"', 'audio/mp4; codecs="opus"',
          'audio/mp4; codecs="flac"', 'audio/webm; codecs="opus"',
          'audio/webm; codecs="vorbis"'
        ],
        duration: 1,
      },
      C_sensors: {
        value: { hasOrientationApi: true, hasAccelerometerApi: true, hasOrientationChanged: false, hasAccelerationChanged: false },
        duration: Math.floor(Math.random() * 50) + 280,
      },
    },
    hash: fingerprint,
    hashesOther: {
      hashHardware: deriveHardwareFingerprint(fingerprint),
    },
  };
}

module.exports = { generateFullRatData };