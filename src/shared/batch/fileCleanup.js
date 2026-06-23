const fs = require('fs').promises;
const { fileURLToPath } = require('url');
const { createLogger } = require('../logger');

const log = createLogger('file-cleanup');

/**
 * Deletes a file from the local filesystem if the URL is a file:// URL.
 * Silently skips non-file:// URLs (cloud API mode) and missing files.
 * @param {string} fileUrl - File URL (file:// path or https:// URL)
 * @returns {Promise<void>}
 */
async function cleanupLocalFile(fileUrl) {
  if (!fileUrl || !fileUrl.startsWith('file://')) return;

  try {
    const filePath = fileURLToPath(fileUrl);
    await fs.unlink(filePath);
    log.info(`Deleted local file: ${filePath}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.debug(`File already removed: ${fileUrl}`);
    } else {
      log.warn(`Failed to delete local file: ${fileUrl} - ${err.message}`);
    }
  }
}

/**
 * Deletes multiple files from the local filesystem.
 * @param {string[]} fileUrls - Array of file URLs
 * @returns {Promise<void>}
 */
async function cleanupLocalFiles(fileUrls) {
  if (!fileUrls || !Array.isArray(fileUrls)) return;
  await Promise.all(fileUrls.map(cleanupLocalFile));
}

module.exports = {
  cleanupLocalFile,
  cleanupLocalFiles,
};
