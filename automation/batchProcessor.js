const { MAX_BYTES_HOTMAIL, MAX_BYTES_ULP, ALLOWED_DOMAINS } = require('./batch/constants');
const { prepareHotmailBatch, prepareAllBatch, prepareJpBatch } = require('./batch/hotmail');
const { prepareUlpBatch } = require('./batch/ulp');

module.exports = {
  prepareBatchFromFile: prepareHotmailBatch,
  prepareAllBatch,
  prepareJpBatch,
  prepareUlpBatch,
  ALLOWED_DOMAINS,
  MAX_BYTES_HOTMAIL,
  MAX_BYTES_ULP,
};
