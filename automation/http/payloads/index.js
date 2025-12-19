/**
 * =============================================================================
 * PAYLOADS - Re-export all payload builders
 * =============================================================================
 */

const { buildAuthorizeRequest } = require('./authorizeRequest');
const { generateFullRatData } = require('./ratPayload');
const { generateRealBioData } = require('./bioPayload');

module.exports = {
  buildAuthorizeRequest,
  generateFullRatData,
  generateRealBioData,
};

