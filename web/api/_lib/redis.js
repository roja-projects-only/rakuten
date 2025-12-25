import Redis from 'ioredis';

let redisClient;

function createClient() {
  if (redisClient) return redisClient;
  if (!process.env.REDIS_URL) {
    throw new Error('REDIS_URL is required for capture/status API');
  }

  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    lazyConnect: true,
    connectTimeout: 10000,
    commandTimeout: parseInt(process.env.REDIS_COMMAND_TIMEOUT || '60000', 10),
  });

  redisClient.on('error', (err) => {
    console.warn('[api] redis error', err.message);
  });

  return redisClient;
}

export async function getRedis() {
  const client = createClient();
  if (client.status === 'wait' || client.status === 'end') {
    await client.connect();
  } else if (client.status === 'ready') {
    return client;
  } else {
    await client.connect();
  }
  return client;
}
