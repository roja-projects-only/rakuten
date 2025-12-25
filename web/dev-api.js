import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load env BEFORE importing handlers (they read ALLOWED_IPS at module load)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env.local') });

import express from 'express';
import statusHandler from './api/status.js';
import validsHandler from './api/valids.js';

console.log('[dev-api] loaded ALLOWED_IPS=', process.env.ALLOWED_IPS || '(empty)');

const PORT = process.env.API_DEV_PORT || 3000;
const app = express();

app.use(express.json());

app.get('/api/status', (req, res) => statusHandler(req, res));
app.get('/api/valids', (req, res) => validsHandler(req, res));

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

app.listen(PORT, () => {
  console.log(`[dev-api] listening on http://localhost:${PORT}`);
});
