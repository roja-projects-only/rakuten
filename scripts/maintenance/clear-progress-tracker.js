/*
 * Clear Redis progress tracker keys (progress_tracker:*) safely.
 * Usage:
 *   REDIS_URL=redis://... node scripts/maintenance/clear-progress-tracker.js
 */

const Redis = require('ioredis');

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error('REDIS_URL is required');
    process.exit(1);
  }

  const redis = new Redis(redisUrl, { lazyConnect: true });
  const pattern = 'progress_tracker:*';
  let totalDeleted = 0;

  try {
    await redis.connect();
    console.log('Connected to Redis');

    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = nextCursor;

      if (keys.length > 0) {
        // Use UNLINK to avoid blocking; fallback to DEL if unavailable.
        const cmd = redis.unlink ? 'unlink' : 'del';
        const pipeline = redis.pipeline();
        keys.forEach((k) => pipeline[cmd](k));
        const results = await pipeline.exec();
        const deleted = results.filter((r) => !r[0]).length;
        totalDeleted += deleted;
        console.log(`Deleted ${deleted} keys in this batch`);
      }
    } while (cursor !== '0');

    console.log(`Done. Total deleted: ${totalDeleted}`);
  } catch (err) {
    console.error('Error clearing progress tracker keys:', err.message);
    process.exitCode = 1;
  } finally {
    await redis.quit().catch(() => {});
  }
}

main();
