/**
 * Shared constants.
 */
const statusCodes = require('./statusCodes');
const defaults = require('./defaults');

module.exports = {
  ...statusCodes,
  ...defaults,
};
