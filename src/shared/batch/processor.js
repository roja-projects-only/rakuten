const { MAX_BYTES_HOTMAIL, MAX_BYTES_ULP, ALLOWED_DOMAINS } = require('./constants');
const { prepareHotmailBatch, prepareAllBatch, prepareJpBatch } = require('./hotmail');
const { prepareUlpBatch } = require('./ulp');

module.exports = {
  prepareBatchFromFile: prepareHotmailBatch,
  prepareAllBatch,
  prepareJpBatch,
  prepareUlpBatch,
  ALLOWED_DOMAINS,
  MAX_BYTES_HOTMAIL,
  MAX_BYTES_ULP,
};
