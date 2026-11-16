// Coffee Tracker server: serves the PWA and proxies bag photos to OpenRouter.
// No dependencies - Node 20+ only.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const RATE_LIMIT = { max: 30, windowMs: 10 * 60 * 1000 };
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const FIELDS = [
  'name', 'roaster', 'origin', 'region', 'producer', 'variety',
  'process', 'roastLevel', 'roastDate', 'tastingNotes', 'altitude', 'weight',
];

const SYSTEM_PROMPT =
  'You read photos of retail coffee bags and extract the product details printed on them. ' +
  'Reply with one JSON object and nothing else: no markdown, no commentary.';

function userPrompt(today) {
  return `These are photos of one bag of coffee (front and/or back). Extract what is printed on it.

Return a JSON object with exactly these keys, all string values:
- "name": the coffee's own name as sold (farm, lot or blend name) - not the roaster's name
- "roaster": the company that roasted it
- "origin": country or countries of origin
- "region": growing region within the country
- "producer": farm, producer, cooperative or washing station
- "variety": coffee variety/cultivar (e.g. "Caturra, Bourbon")
- "process": processing method (e.g. "Washed", "Natural", "Honey")
- "roastLevel": roast level or intended use as printed (e.g. "Light", "Medium", "Dark", "Espresso", "Omni")
- "roastDate": the roast date as YYYY-MM-DD, only if a roast date is printed, stamped or handwritten on the bag
- "tastingNotes": flavour notes printed on the bag, comma separated
- "altitude": growing altitude with unit (e.g. "1,800 masl")
- "weight": net weight with unit (e.g. "250 g")

Rules:
- Use "" for anything that is not visible on the bag. Do not guess or fill in from general knowledge.
- Keep the wording from the bag, translated to English only where it is a common term (process, roast level).
- Today is ${today}. Use that to resolve a roast date with no year, or an ambiguous day/month order; a roast date is never in the future. A best-before date is not a roast date.`;
}

/** Config comes from env vars, falling back to <STORAGE_DIR>/config.json. */
export function loadConfig(env = process.env) {
  let file = {};
  const storageDir = env.STORAGE_DIR || '/storage';
  try {
    file = JSON.parse(readFileSync(path.join(storageDir, 'config.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Ignoring ${storageDir}/config.json: ${err.message}`);
  }
  const get = (key, fallback = '') => String(env[key] || file[key] || fallback).trim();
  return {
    port: Number(env.PORT || 80),
    apiKey: get('OPENROUTER_API_KEY'),
    model: get('OPENROUTER_MODEL', 'google/gemini-3.5-flash-lite'),
    baseUrl: get('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    appPassword: get('APP_PASSWORD'),
  };
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? MIME['.json'] : 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Photos are too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Pull a JSON object out of a model reply, tolerating code fences and stray prose. */
export function parseModelJson(text) {
  const raw = String(text ?? '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('The model did not return JSON');
    return JSON.parse(raw.slice(start, end + 1));
  }
}

export function normaliseCoffee(obj) {
  const out = {};
  for (const key of FIELDS) {
    let value = obj?.[key];
    if (Array.isArray(value)) value = value.filter(Boolean).join(', ');
    if (value == null || typeof value === 'object') value = '';
    out[key] = String(value).trim().slice(0, 300);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.roastDate) || Number.isNaN(Date.parse(out.roastDate))) {
    out.roastDate = '';
  }
  return out;
}

async function askOpenRouter(config, images) {
  const today = new Date().toISOString().slice(0, 10);
  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Coffee Tracker',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt(today) },
              ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
            ],
          },
        ],
      }),
    });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
    throw Object.assign(new Error(`OpenRouter ${why}`), { status: 502 });
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    const detail = data?.error?.message || `HTTP ${response.status}`;
    throw Object.assign(new Error(`OpenRouter (${config.model}): ${detail}`), { status: 502 });
  }

  let content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map((part) => part?.text ?? '').join('');
  try {
    return normaliseCoffee(parseModelJson(content));
  } catch {
    throw Object.assign(new Error('The model reply could not be read. Try again.'), { status: 502 });
  }
}

export function createApp(config) {
  const hits = new Map();

  function rateLimited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
    if (recent.length >= RATE_LIMIT.max) {
      hits.set(ip, recent);
      return true;
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    return false;
  }

  async function handleExtract(req, res) {
    if (!config.apiKey) {
      return send(res, 503, { error: 'Photo reading is not set up on the server (no OpenRouter key).' });
    }
    if (config.appPassword) {
      const given = String(req.headers['x-app-password'] || '');
      if (!safeEqual(given, config.appPassword)) {
        return send(res, 401, { error: 'Wrong or missing app password.' });
      }
    }
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) {
      return send(res, 429, { error: 'Too many requests. Try again in a few minutes.' });
    }

    let images;
    try {
      images = JSON.parse(await readBody(req, MAX_BODY_BYTES)).images;
    } catch (err) {
      return send(res, err.status || 400, { error: err.status ? err.message : 'Invalid request.' });
    }
    const valid = Array.isArray(images) && images.length >= 1 && images.length <= 2 &&
      images.every((img) => typeof img === 'string' && IMAGE_RE.test(img));
    if (!valid) return send(res, 400, { error: 'Send one or two photos.' });

    try {
      send(res, 200, { coffee: await askOpenRouter(config, images) });
    } catch (err) {
      if (!err.status) console.error(err);
      send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong.' });
    }
  }

  async function handleStatic(req, res, pathname) {
    let relative;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    if (relative.endsWith('/')) relative += 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, relative));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
    try {
      const body = await readFile(file);
      send(res, 200, body, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy':
          "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
    } catch {
      send(res, 404, 'Not found');
    }
  }

  return http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${pathname}`;
    if (route === 'GET /up' || route === 'HEAD /up') return send(res, 200, 'OK');
    if (route === 'GET /api/config') {
      return send(res, 200, {
        ai: Boolean(config.apiKey),
        model: config.apiKey ? config.model : '',
        passwordRequired: Boolean(config.apiKey && config.appPassword),
      }, { 'Cache-Control': 'no-store' });
    }
    if (route === 'POST /api/extract') return handleExtract(req, res);
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method === 'GET' || req.method === 'HEAD') return handleStatic(req, res, pathname);
    send(res, 405, 'Method not allowed');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const server = createApp(config);
  server.listen(config.port, () => {
    console.log(`Coffee Tracker listening on port ${config.port}`);
    console.log(config.apiKey
      ? `Photo reading: on (${config.model})${config.appPassword ? ', password protected' : ''}`
      : 'Photo reading: off (set OPENROUTER_API_KEY to enable)');
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}
