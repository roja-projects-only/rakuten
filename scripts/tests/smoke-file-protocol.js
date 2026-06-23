// Smoke test for file:// URL handling in download modules
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const url = require('url');

(async () => {
  // Create a temp file with test credentials
  const tmpDir = path.join(os.tmpdir(), 'telegram-file-test-' + Date.now());
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, 'test-creds.txt');
  const testContent = 'user@rakuten.co.jp:pass123\nuser2@rakuten.co.jp:pass456\ninvalid-line\n';
  await fs.writeFile(tmpFile, testContent, 'utf8');
  const fileUrl = url.pathToFileURL(tmpFile).href;

  console.log('Testing file:// URL:', fileUrl);

  // Test 1: hotmail.js downloadFileToBuffer
  const { downloadFileToBuffer } = require('../../src/shared/batch/hotmail');
  const buffer = await downloadFileToBuffer(fileUrl, 50 * 1024 * 1024);
  const text = buffer.toString('utf8');
  console.log('Test 1 (hotmail downloadFileToBuffer): PASS, got', text.length, 'bytes');

  // Test 2: ulp.js parseUlpFromUrl
  const { parseUlpFromUrl } = require('../../src/shared/batch/ulp');
  const result = await parseUlpFromUrl(fileUrl, 1500 * 1024 * 1024);
  console.log('Test 2 (ulp parseUlpFromUrl): PASS, parsed', result.count, 'creds');

  // Test 3: ENOENT handling
  try {
    await downloadFileToBuffer('file:///nonexistent/path/file.txt', 1024);
    console.log('Test 3 (ENOENT): FAIL - should have thrown');
    process.exit(1);
  } catch (err) {
    console.log('Test 3 (ENOENT): PASS, error code:', err.code || err.message.substring(0, 60));
  }

  // Test 4: getTelegramFileLimitBytes
  const { getTelegramFileLimitBytes, TELEGRAM_FILE_LIMIT_CLOUD, TELEGRAM_FILE_LIMIT_LOCAL } = require('../../src/shared/batch/constants');
  const cloudLimit = getTelegramFileLimitBytes(undefined);
  const localLimit = getTelegramFileLimitBytes('http://localhost:8081');
  if (cloudLimit === TELEGRAM_FILE_LIMIT_CLOUD && localLimit === TELEGRAM_FILE_LIMIT_LOCAL) {
    console.log('Test 4 (getTelegramFileLimitBytes): PASS, cloud=' + cloudLimit + ' local=' + localLimit);
  } else {
    console.log('Test 4 (getTelegramFileLimitBytes): FAIL');
    process.exit(1);
  }

  // Test 5: buildFileTooLarge with dynamic limit
  const { buildFileTooLarge } = require('../../src/telegram/messages/batchMessages');
  const msg = buildFileTooLarge(2000 * 1024 * 1024);
  if (msg.includes('2000') || msg.includes('2GB') || msg.includes('2.0')) {
    console.log('Test 5 (buildFileTooLarge): PASS -', msg.substring(0, 80));
  } else {
    console.log('Test 5 (buildFileTooLarge): FAIL -', msg);
    process.exit(1);
  }

  // Test 6: buildFileTooLarge without arg (backward compat)
  const msgDefault = buildFileTooLarge();
  if (msgDefault.includes('20MB')) {
    console.log('Test 6 (buildFileTooLarge default): PASS -', msgDefault.substring(0, 80));
  } else {
    console.log('Test 6 (buildFileTooLarge default): FAIL -', msgDefault);
    process.exit(1);
  }

  // Cleanup
  await fs.unlink(tmpFile);
  await fs.rmdir(tmpDir);
  console.log('\nAll smoke tests passed!');
})().catch((err) => {
  console.error('Smoke test FAILED:', err.message);
  process.exit(1);
});
