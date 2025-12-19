/**
 * =============================================================================
 * AUTHORIZE REQUEST - OAuth authorize_request payload builder
 * =============================================================================
 * 
 * Builds the authorize_request object used in Rakuten login requests.
 * Captured from real Chrome DevTools requests.
 * 
 * =============================================================================
 */

/**
 * Builds the authorize_request object used in login requests.
 * @returns {Object} authorize_request payload
 */
function buildAuthorizeRequest() {
  return {
    client_id: 'rakuten_ichiba_top_web',
    redirect_uri: 'https://www.rakuten.co.jp/',
    scope: 'openid',
    response_type: 'code',
    ui_locales: 'en-US',
    state: '',
    max_age: null,
    nonce: '',
    display: 'page',
    code_challenge: '',
    code_challenge_method: '',
    r10_required_claims: '',
    r10_audience: 'jid',
    r10_jid_service_id: 'omnit246',
    r10_preferred_authentication: null,
    r10_guest_login: false,
    r10_disable_intra: true,
    r10_force_account: null,
    r10_own_scope: null,
    r10_rejection: null,
    token: null,
  };
}

module.exports = { buildAuthorizeRequest };

