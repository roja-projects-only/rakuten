/**
 * =============================================================================
 * HTTP DATA CAPTURE - API-BASED ACCOUNT DATA EXTRACTION
 * =============================================================================
 * 
 * THIS FILE IS NOW A RE-EXPORT FACADE FOR BACKWARDS COMPATIBILITY.
 * Actual implementation is in automation/http/capture/
 * 
 * @see automation/http/capture/index.js - Main orchestrator
 * @see automation/http/capture/apiCapture.js - API-based capture
 * @see automation/http/capture/htmlCapture.js - HTML fallback
 * @see automation/http/capture/orderHistory.js - Order data
 * @see automation/http/capture/profileData.js - Profile & cards
 * @see automation/http/capture/ssoFormHandler.js - Shared SSO handler
 * 
 * =============================================================================
 */

// Re-export everything from the modularized capture directory
module.exports = require('./capture');
